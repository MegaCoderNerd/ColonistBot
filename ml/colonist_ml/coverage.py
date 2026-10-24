"""Phase 6 supervised comparison.

Thresholds below were fixed before the corpus was scored. They are diagnostics.
Clearing them does not authorize PPO and does not claim a stronger player.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path

import torch

from .fidelity import OVERFIT_EPOCHS, OVERFIT_LIMIT, OVERFIT_TOP1_MIN, evaluate_imitation, overfit_subset
from .graph import GraphPolicyValueNet, collate_graph, graph_logits
from .model import PolicyValueNet
from .schema import load_jsonl
from .tracked import (
    FEATURE_VERSION_V4,
    FEATURE_VERSION_V5,
    GLOBAL_DIM_V4,
    encode_observation_v4,
    global_vector_v4,
)
from .train import supervised_loss

# Written before any phase-6 model result. Do not retune these after scoring.
PHASE6_EPOCHS = 12
PHASE6_BATCH = 64
PHASE6_SEED = 7
MEASURED_MIN = 40
WITHIN_TYPE_READY = 0.35
GRAPH_MARGIN = 0.05
HARD_TYPES = ("buildRoad", "bankTrade", "moveRobber", "placeSetupSettlement")
COVERAGE_TYPES = HARD_TYPES + (
    "placeSetupRoad",
    "buildSettlement",
    "buildCity",
    "discard",
    "buyDevCard",
)
PROFILE = "colonist_benchmark_1v1_v1"
FINAL_PREFIX = "ml-phase6-final-"
VAL_PREFIX = "ml-phase6-val-"
TRAIN_PREFIX = "ml-phase6-train-"


def with_teacher_labels(examples: list[dict]) -> list[dict]:
    """Imitation target is the baseline action actually evaluated on that state."""
    relabeled = []
    for example in examples:
        if example.get("teacher_policy") != "baseline_heuristic_v1":
            raise RuntimeError(f"phase 6 label is not the baseline heuristic: {example.get('teacher_policy')}")
        teacher = example.get("teacher_action_id")
        if not teacher:
            raise RuntimeError("missing baseline label")
        copied = dict(example)
        copied["played_action_id"] = example["chosen_action_id"]
        copied["chosen_action_id"] = teacher
        relabeled.append(copied)
    return relabeled


def assert_phase6_split(examples: list[dict], prefix: str, banned_prefixes: tuple[str, ...]) -> None:
    if not examples:
        raise RuntimeError("empty split")
    profiles = {example.get("simulator", {}).get("rule_profile") for example in examples}
    if profiles != {PROFILE}:
        raise RuntimeError(f"refusing profiles {sorted(profiles)}")
    schemas = {example["observation"].get("schema_version") for example in examples}
    if schemas != {"colonist_observation_v2"}:
        raise RuntimeError(f"refusing observation schemas {sorted(schemas)}")
    seeds = {example["seed"] for example in examples}
    if any(not seed.startswith(prefix) for seed in seeds):
        raise RuntimeError(f"split {prefix} contains unexpected seeds")
    for banned in banned_prefixes:
        if any(seed.startswith(banned) for seed in seeds):
            raise RuntimeError(f"split contains banned seeds {banned}")


def coverage_report(examples: list[dict]) -> dict:
    games: dict[str, str] = {}
    teacher_types: Counter = Counter()
    played_types: Counter = Counter()
    single = 0
    multi = 0
    completed_decisions = 0
    cutoff_decisions = 0
    policies: Counter = Counter()
    for example in examples:
        games[example["game_id"]] = example["completion_status"]
        policies[example["generating_policy"]] += 1
        teacher = str(example.get("teacher_action_id") or example["chosen_action_id"])
        teacher_types[teacher.split(":", 1)[0]] += 1
        played_types[str(example["chosen_action_id"]).split(":", 1)[0]] += 1
        legal = len(example["observation"]["candidates"])
        if legal <= 1:
            single += 1
        else:
            multi += 1
        if example["completion_status"] == "completed":
            completed_decisions += 1
        else:
            cutoff_decisions += 1
    completed_games = sum(1 for status in games.values() if status == "completed")
    categories = {}
    for action_type in COVERAGE_TYPES:
        count = teacher_types[action_type]
        categories[action_type] = {
            "teacher_labels": count,
            "played_actions": played_types[action_type],
            "measured": count >= MEASURED_MIN,
        }
    return {
        "games": len(games),
        "completed_games": completed_games,
        "incomplete_games": len(games) - completed_games,
        "decisions": len(examples),
        "completed_game_decisions": completed_decisions,
        "cutoff_trajectory_decisions": cutoff_decisions,
        "single_legal_decisions": single,
        "multi_legal_decisions": multi,
        "generating_policies": dict(policies),
        "categories": categories,
        "measured_min": MEASURED_MIN,
    }


def within_by_type(model, examples: list[dict], device: torch.device, scorer) -> dict[str, dict[str, float | int | None]]:
    hits: Counter = Counter()
    totals: Counter = Counter()
    for example in examples:
        teacher = str(example["chosen_action_id"])
        teacher_type = teacher.split(":", 1)[0]
        ranked = sorted(scorer(model, example["observation"], device), key=lambda item: item[1], reverse=True)
        same = [action_id for action_id, _score in ranked if action_id.split(":", 1)[0] == teacher_type]
        if len(same) <= 1:
            continue
        totals[teacher_type] += 1
        if same[0] == teacher:
            hits[teacher_type] += 1
    out = {}
    for action_type in COVERAGE_TYPES:
        count = totals[action_type]
        out[action_type] = {
            "n": count,
            "within_type": None if count == 0 else hits[action_type] / count,
            "measured": count >= MEASURED_MIN,
        }
    return out


def graph_replaces_summary(summary_within: dict, graph_within: dict, summary_multi: float, graph_multi: float, graph_invalid: int) -> bool:
    """Validation-only rule. A tie, a missing category, or any illegal prediction keeps the summary model."""
    if graph_invalid:
        return False
    if graph_multi + 0.01 < summary_multi:
        return False
    for action_type in HARD_TYPES:
        left = summary_within[action_type]
        right = graph_within[action_type]
        if not left["measured"] or not right["measured"]:
            return False
        if right["within_type"] is None or left["within_type"] is None:
            return False
        if right["within_type"] < left["within_type"] + GRAPH_MARGIN:
            return False
    return True


def ready_for_strength(within: dict) -> bool:
    for action_type in HARD_TYPES:
        row = within[action_type]
        if not row["measured"] or row["within_type"] is None or row["within_type"] < WITHIN_TYPE_READY:
            return False
    return True


def _score_v4(model, observation: dict, device: torch.device):
    model.eval()
    with torch.no_grad():
        global_x, candidates, ids = encode_observation_v4(observation, device)
        mask = torch.ones(1, candidates.size(0), dtype=torch.bool, device=device)
        logits, _value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
        return [(action_id, float(logits[0, index].item())) for index, action_id in enumerate(ids)]


def _collate_v4(examples: list[dict], device: torch.device) -> dict:
    width = max(len(example["observation"]["candidates"]) for example in examples)
    from .features import CANDIDATE_DIM

    global_x = torch.zeros(len(examples), GLOBAL_DIM_V4, device=device)
    candidates = torch.zeros(len(examples), width, CANDIDATE_DIM, device=device)
    mask = torch.zeros(len(examples), width, dtype=torch.bool, device=device)
    chosen = torch.zeros(len(examples), dtype=torch.long, device=device)
    wins = torch.zeros(len(examples), device=device)
    completed = torch.zeros(len(examples), dtype=torch.bool, device=device)
    for index, example in enumerate(examples):
        one_global, one_candidates, ids = encode_observation_v4(example["observation"], device)
        global_x[index] = one_global
        count = one_candidates.size(0)
        candidates[index, :count] = one_candidates
        mask[index, :count] = True
        chosen[index] = ids.index(example["chosen_action_id"])
        if example["completion_status"] == "completed" and example["actor_win"] is not None:
            completed[index] = True
            wins[index] = float(example["actor_win"])
    return {
        "global_x": global_x,
        "candidates": candidates,
        "mask": mask,
        "chosen": chosen,
        "wins": wins,
        "completed": completed,
    }


def _train_summary(model, examples: list[dict], device: torch.device, epochs: int) -> float:
    torch.manual_seed(PHASE6_SEED)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    model.train()
    started = time.perf_counter()
    for _epoch in range(epochs):
        for start in range(0, len(examples), PHASE6_BATCH):
            batch = _collate_v4(examples[start : start + PHASE6_BATCH], device)
            optimizer.zero_grad(set_to_none=True)
            logits, values = model(batch["global_x"], batch["candidates"], batch["mask"])
            loss, _stats = supervised_loss(logits, values, batch)
            loss.backward()
            optimizer.step()
    return time.perf_counter() - started


def _train_graph(model, examples: list[dict], device: torch.device, epochs: int) -> float:
    torch.manual_seed(PHASE6_SEED)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    model.train()
    started = time.perf_counter()
    grouped: dict[str, list[dict]] = {}
    for example in examples:
        grouped.setdefault(str(example["game_id"]), []).append(example)
    ordered = [row for game_id in sorted(grouped) for row in grouped[game_id]]
    for _epoch in range(epochs):
        for start in range(0, len(ordered), PHASE6_BATCH):
            chunk = ordered[start : start + PHASE6_BATCH]
            # One board per batch. A generated board can still share its edge graph, but do not mix game ids here.
            if len({row["game_id"] for row in chunk}) != 1:
                by_game: dict[str, list[dict]] = {}
                for row in chunk:
                    by_game.setdefault(row["game_id"], []).append(row)
                pieces = list(by_game.values())
            else:
                pieces = [chunk]
            for piece in pieces:
                batch = collate_graph(piece, device, global_fn=global_vector_v4, global_dim=GLOBAL_DIM_V4)
                optimizer.zero_grad(set_to_none=True)
                logits, values = graph_logits(model, batch)
                loss, _stats = supervised_loss(logits, values, batch)
                loss.backward()
                optimizer.step()
    return time.perf_counter() - started


def _latency_ms(scorer, model, examples: list[dict], device: torch.device) -> float:
    sample = examples[:32]
    if not sample:
        return 0.0
    started = time.perf_counter()
    for example in sample:
        scorer(model, example["observation"], device)
    return (time.perf_counter() - started) * 1000.0 / len(sample)


def _pack(metrics: dict, within: dict, seconds: float, latency: float, parameters: int, version: str) -> dict:
    return {
        "feature_version": version,
        "parameters": parameters,
        "train_seconds": seconds,
        "inference_ms": latency,
        "imitation": metrics,
        "within_by_type": within,
    }


def run_phase6(train_path: str, val_path: str, final_path: str, out_path: str, device: torch.device) -> dict:
    train_raw, _dropped = load_jsonl(train_path, held_out_seeds=set())
    val_raw, _dropped = load_jsonl(val_path, held_out_seeds=set())
    assert_phase6_split(train_raw, TRAIN_PREFIX, (VAL_PREFIX, FINAL_PREFIX))
    assert_phase6_split(val_raw, VAL_PREFIX, (TRAIN_PREFIX, FINAL_PREFIX))
    train = with_teacher_labels(train_raw)
    val = with_teacher_labels(val_raw)
    report: dict = {
        "profile": PROFILE,
        "epochs": PHASE6_EPOCHS,
        "batch": PHASE6_BATCH,
        "seed": PHASE6_SEED,
        "thresholds": {
            "overfit_top1_min": OVERFIT_TOP1_MIN,
            "overfit_epochs": OVERFIT_EPOCHS,
            "within_type_ready": WITHIN_TYPE_READY,
            "graph_margin": GRAPH_MARGIN,
            "measured_min": MEASURED_MIN,
            "hard_types": list(HARD_TYPES),
            "ppo_authorized": False,
        },
        "coverage": {
            "train": coverage_report(train_raw),
            "validation": coverage_report(val_raw),
        },
    }
    subset = overfit_subset(train, OVERFIT_LIMIT)
    summary = PolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V4).to(device)
    fit_seconds = _train_summary(summary, subset, device, OVERFIT_EPOCHS)
    fit_metrics = evaluate_imitation(summary, subset, device, scorer=_score_v4)
    report["summary_subset_fit"] = {
        "n": len(subset),
        "seconds": fit_seconds,
        "top1": fit_metrics["top1"],
        "bar": OVERFIT_TOP1_MIN,
        "cleared": bool(fit_metrics["top1"] is not None and fit_metrics["top1"] >= OVERFIT_TOP1_MIN),
    }
    summary = PolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V4).to(device)
    graph = GraphPolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V5).to(device)
    summary_seconds = _train_summary(summary, train, device, PHASE6_EPOCHS)
    graph_seconds = _train_graph(graph, train, device, PHASE6_EPOCHS)

    def score_graph(model, observation, device):
        from .graph import score_graph

        return score_graph(model, observation, device)

    summary_val = evaluate_imitation(summary, val, device, scorer=_score_v4)
    graph_val = evaluate_imitation(graph, val, device, scorer=score_graph)
    summary_within = within_by_type(summary, val, device, _score_v4)
    graph_within = within_by_type(graph, val, device, score_graph)
    summary_train = evaluate_imitation(summary, train, device, scorer=_score_v4)
    adopt_graph = graph_replaces_summary(
        summary_within,
        graph_within,
        float(summary_val["multi_legal_top1"] or 0.0),
        float(graph_val["multi_legal_top1"] or 0.0),
        int(graph_val["invalid_predictions"]),
    )
    chosen_name = FEATURE_VERSION_V5 if adopt_graph else FEATURE_VERSION_V4
    chosen_within = graph_within if adopt_graph else summary_within
    report["validation"] = {
        "summary_v4": _pack(summary_val, summary_within, summary_seconds, _latency_ms(_score_v4, summary, val, device), sum(p.numel() for p in summary.parameters()), FEATURE_VERSION_V4),
        "graph_v5": _pack(graph_val, graph_within, graph_seconds, _latency_ms(score_graph, graph, val, device), sum(p.numel() for p in graph.parameters()), FEATURE_VERSION_V5),
        "summary_train_top1": summary_train["top1"],
        "summary_train_multi_legal_top1": summary_train["multi_legal_top1"],
        "adopt_graph": adopt_graph,
        "chosen": chosen_name,
        "ready_for_strength_on_validation": ready_for_strength(chosen_within),
    }
    # The final file is read only after the choice above.
    final_raw, _dropped = load_jsonl(final_path, held_out_seeds=set())
    assert_phase6_split(final_raw, FINAL_PREFIX, (TRAIN_PREFIX, VAL_PREFIX))
    final = with_teacher_labels(final_raw)
    report["coverage"]["final"] = coverage_report(final_raw)
    chosen_model = graph if adopt_graph else summary
    chosen_scorer = score_graph if adopt_graph else _score_v4
    final_metrics = evaluate_imitation(chosen_model, final, device, scorer=chosen_scorer)
    final_within = within_by_type(chosen_model, final, device, chosen_scorer)
    report["final_test"] = {
        "chosen": chosen_name,
        "imitation": final_metrics,
        "within_by_type": final_within,
        "ready_for_strength": ready_for_strength(final_within),
        "ppo_authorized": False,
    }
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report
