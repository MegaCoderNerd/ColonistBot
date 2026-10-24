"""Identical-data comparison of the summary policy and the board-aware candidate.

The epoch budget is a smoke test. It is not a strength evaluation, and it does
not touch the reserved final seeds.
"""

from __future__ import annotations

import time

import torch

from .features import FEATURE_VERSION
from .fidelity import evaluate_imitation
from .graph import GRAPH_FEATURE_VERSION, GraphPolicyValueNet, graph_logits, score_graph
from .graph import collate_graph
from .model import PolicyValueNet
from .rules import GRAPH_FINAL_SEEDS, GRAPH_TRAIN_SEEDS, GRAPH_VAL_SEEDS, assert_comparison_seeds
from .train import stratified_examples, supervised_loss, train_steps

COMPARE_EPOCHS = 8
COMPARE_BATCH = 32
COMPARE_SEED = 7
HARD_TYPES = ("buildRoad", "bankTrade", "moveRobber", "placeSetupSettlement", "discard")


def _count_parameters(model: torch.nn.Module) -> int:
    return sum(parameter.numel() for parameter in model.parameters())


def _train_graph(model: GraphPolicyValueNet, examples: list[dict], device: torch.device, epochs: int, seed: int) -> None:
    torch.manual_seed(seed)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    model.train()
    for _epoch in range(epochs):
        for start in range(0, len(examples), COMPARE_BATCH):
            batch = collate_graph(examples[start : start + COMPARE_BATCH], device)
            optimizer.zero_grad(set_to_none=True)
            logits, values = graph_logits(model, batch)
            loss, _stats = supervised_loss(logits, values, batch)
            loss.backward()
            optimizer.step()


def _latency_ms(model, examples: list[dict], device: torch.device, scorer, repeats: int = 20) -> float:
    from .train import score_candidates

    score = scorer or score_candidates
    model.eval()
    sample = examples[: min(8, len(examples))]
    started = time.perf_counter()
    for _repeat in range(repeats):
        for example in sample:
            score(model, example["observation"], device)
    elapsed = time.perf_counter() - started
    return 1000.0 * elapsed / (repeats * len(sample))


def _slice(metrics: dict) -> dict:
    by_type = metrics["by_action_type"]
    return {
        "n": metrics["n"],
        "top1": metrics["top1"],
        "top3_when_at_least_3": metrics["top3"],
        "type_agreement": metrics["type_agreement"],
        "within_type_agreement": metrics["within_type_agreement"],
        "within_type_n": metrics["within_type_n"],
        "multi_legal_top1": metrics["multi_legal_top1"],
        "multi_legal_n": metrics["multi_legal_n"],
        "single_legal_top1": metrics["single_legal_top1"],
        "single_legal_n": metrics["single_legal_n"],
        "invalid_predictions": metrics["invalid_predictions"],
        "unmapped_teacher_actions": metrics["unmapped_teacher_actions"],
        "by_phase": metrics["by_phase"],
        "by_legal_count": metrics["by_legal_count"],
        "by_policy": metrics["by_policy"],
        "hard_types": {name: by_type.get(name) for name in HARD_TYPES},
    }


def compare_models(train: list[dict], validation: list[dict], device: torch.device) -> dict:
    assert_comparison_seeds(train, frozenset(GRAPH_TRAIN_SEEDS))
    assert_comparison_seeds(validation, frozenset(GRAPH_VAL_SEEDS))
    completed_train = [example for example in train if example["completion_status"] == "completed"]
    completed_val = [example for example in validation if example["completion_status"] == "completed"]
    if not completed_train or not completed_val:
        raise RuntimeError("comparison needs completed games on both sides")

    torch.manual_seed(COMPARE_SEED)
    summary = PolicyValueNet().to(device)
    torch.manual_seed(COMPARE_SEED)
    graph = GraphPolicyValueNet().to(device)
    torch.manual_seed(COMPARE_SEED)
    graph_balanced = GraphPolicyValueNet().to(device)

    started = time.perf_counter()
    train_steps(summary, torch.optim.Adam(summary.parameters(), lr=1e-3), completed_train, device, epochs=COMPARE_EPOCHS, batch_size=COMPARE_BATCH)
    summary_seconds = time.perf_counter() - started

    started = time.perf_counter()
    _train_graph(graph, completed_train, device, COMPARE_EPOCHS, COMPARE_SEED)
    graph_seconds = time.perf_counter() - started

    ordered = stratified_examples(completed_train, COMPARE_SEED)
    if len(ordered) != len(completed_train):
        raise RuntimeError("stratified order duplicated or dropped an example")
    started = time.perf_counter()
    _train_graph(graph_balanced, ordered, device, COMPARE_EPOCHS, COMPARE_SEED)
    balanced_seconds = time.perf_counter() - started

    def pack(model, scorer, train_seconds: float, schema: str) -> dict:
        train_metrics = evaluate_imitation(model, completed_train, device, scorer=scorer)
        val_metrics = evaluate_imitation(model, completed_val, device, scorer=scorer)
        return {
            "feature_schema": schema,
            "parameters": _count_parameters(model),
            "train_seconds": train_seconds,
            "inference_ms_per_decision": _latency_ms(model, completed_val, device, scorer),
            "train": _slice(train_metrics),
            "validation": _slice(val_metrics),
        }

    return {
        "note": "Teacher agreement is not playing strength. Final seeds were not used.",
        "epochs": COMPARE_EPOCHS,
        "batch_size": COMPARE_BATCH,
        "seed": COMPARE_SEED,
        "train_examples": len(completed_train),
        "validation_examples": len(completed_val),
        "train_games": len({example["game_id"] for example in completed_train}),
        "validation_games": len({example["game_id"] for example in completed_val}),
        "final_seeds_reserved": list(GRAPH_FINAL_SEEDS),
        "final_seeds_used": False,
        "summary_v2": pack(summary, None, summary_seconds, FEATURE_VERSION),
        "graph_v3": pack(graph, score_graph, graph_seconds, GRAPH_FEATURE_VERSION),
        "graph_v3_stratified_batches": pack(graph_balanced, score_graph, balanced_seconds, GRAPH_FEATURE_VERSION),
        "acceptance_unchanged": {"overfit_top1_min": 0.90, "holdout_top1_min": 0.40, "holdout_lift_over_chance": 0.20, "role": "diagnostic"},
    }
