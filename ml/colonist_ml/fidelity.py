"""Teacher imitation metrics.

The thresholds in this module were fixed before the fidelity measurement.
They are not revised after seeing agreement rates.

Heuristic chosen actions are behavior labels. They are not optimal moves.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict

import torch

from .model import PolicyValueNet
from .train import score_candidates, train_steps

# Diagnostic acceptance, written down before the measurement run.
OVERFIT_TOP1_MIN = 0.90
OVERFIT_EPOCHS = 40
OVERFIT_LIMIT = 64
HELDOUT_TOP1_MIN = 0.40
HELDOUT_LIFT_OVER_CHANCE = 0.20
FIT_EPOCHS = 10
FIT_SEEDS = ("ml-fidelity-fit-0", "ml-fidelity-fit-1")
HOLDOUT_SEEDS = ("ml-fidelity-holdout-0", "ml-fidelity-holdout-1")
TRACE_SEED = "ml-fidelity-trace-0"
TRACE_LIMITS = {"victoryPointsToWin": 10, "maxTurns": 70, "maxActions": 450}


def chance_rate(examples: list[dict]) -> float:
    if not examples:
        return 0.0
    total = 0.0
    for example in examples:
        legal = len(example["observation"]["candidates"])
        total += 1.0 / max(1, legal)
    return total / len(examples)


def overfit_subset(examples: list[dict], limit: int = OVERFIT_LIMIT) -> list[dict]:
    """Round-robin across action types, in example-id order, from complete games when any exist."""
    pool = [example for example in examples if example["completion_status"] == "completed"] or list(examples)
    buckets: dict[str, list[dict]] = defaultdict(list)
    for example in sorted(pool, key=lambda item: str(item["example_id"])):
        buckets[str(example["chosen_action_id"]).split(":", 1)[0]].append(example)
    picked: list[dict] = []
    while len(picked) < limit:
        progressed = False
        for action_type in sorted(buckets):
            if not buckets[action_type]:
                continue
            picked.append(buckets[action_type].pop(0))
            progressed = True
            if len(picked) >= limit:
                break
        if not progressed:
            break
    return picked


def _bucket_legal(count: int) -> str:
    if count <= 1:
        return "1"
    if count <= 3:
        return "2-3"
    if count <= 8:
        return "4-8"
    return "9+"


def _hand_size(observation: dict) -> int:
    hand = observation.get("actor", {}).get("hand") or {}
    return int(sum(int(value) for value in hand.values()))


def _bucket_hand(size: int) -> str:
    if size <= 2:
        return "0-2 cards"
    if size <= 5:
        return "3-5 cards"
    return "6+ cards"


def _bucket_vp(vp: float) -> str:
    if vp <= 2:
        return "vp<=2"
    if vp <= 4:
        return "vp 3-4"
    return "vp>=5"


def evaluate_imitation(model, examples: list[dict], device: torch.device, disagreement_limit: int = 12, scorer=None) -> dict:
    """Top-1 and top-3 agreement with the recorded teacher action. Not a strength claim."""
    score = scorer or score_candidates
    if not examples:
        raise ValueError("no examples")
    totals = Counter()
    hits = Counter()
    top3_totals = Counter()
    top3_hits = Counter()
    invalid = 0
    unmapped_teacher = 0
    predicted_types: Counter = Counter()
    teacher_types: Counter = Counter()
    disagreements = []
    seen_disagreement_types: set[str] = set()
    type_hits = 0
    within_hits = 0
    within_n = 0
    multi_hits = 0
    multi_n = 0
    single_hits = 0
    single_n = 0
    for example in examples:
        observation = example["observation"]
        legal_ids = [str(candidate["action_id"]) for candidate in observation["candidates"]]
        teacher = str(example["chosen_action_id"])
        if teacher not in legal_ids:
            unmapped_teacher += 1
            continue
        ranked = sorted(score(model, observation, device), key=lambda item: item[1], reverse=True)
        ranked_ids = [action_id for action_id, _score in ranked]
        if any(action_id not in legal_ids for action_id in ranked_ids) or len(ranked_ids) != len(legal_ids):
            invalid += 1
            continue
        predicted = ranked_ids[0]
        teacher_type = teacher.split(":", 1)[0]
        predicted_type = predicted.split(":", 1)[0]
        if predicted_type == teacher_type:
            type_hits += 1
        same_type = [action_id for action_id in ranked_ids if action_id.split(":", 1)[0] == teacher_type]
        if len(same_type) > 1:
            within_n += 1
            if same_type[0] == teacher:
                within_hits += 1
        if len(legal_ids) == 1:
            single_n += 1
            if predicted == teacher:
                single_hits += 1
        else:
            multi_n += 1
            if predicted == teacher:
                multi_hits += 1
        phase = str(observation.get("phase", "other"))
        policy = str(example.get("generating_policy", "unknown"))
        legal_bucket = _bucket_legal(len(legal_ids))
        hand_bucket = _bucket_hand(_hand_size(observation))
        vp_bucket = _bucket_vp(float(observation.get("actor", {}).get("public_vp", 0)))
        keys = ("overall", f"phase:{phase}", f"type:{teacher_type}", f"legal:{legal_bucket}", f"hand:{hand_bucket}", f"vp:{vp_bucket}", f"policy:{policy}")
        for key in keys:
            totals[key] += 1
            if predicted == teacher:
                hits[key] += 1
        if len(legal_ids) >= 3:
            for key in ("overall", f"phase:{phase}", f"type:{teacher_type}"):
                top3_totals[key] += 1
                if teacher in ranked_ids[:3]:
                    top3_hits[key] += 1
        teacher_types[teacher_type] += 1
        predicted_types[predicted_type] += 1
        if predicted != teacher and len(disagreements) < disagreement_limit:
            if teacher_type in seen_disagreement_types and len(seen_disagreement_types) < disagreement_limit:
                continue
            seen_disagreement_types.add(teacher_type)
            teacher_rank = ranked_ids.index(teacher)
            disagreements.append(
                {
                    "seed": example.get("seed"),
                    "game_id": example.get("game_id"),
                    "phase": phase,
                    "policy": policy,
                    "public_vp": observation.get("actor", {}).get("public_vp"),
                    "hand": observation.get("actor", {}).get("hand"),
                    "production": observation.get("actor", {}).get("production"),
                    "legal_count": len(legal_ids),
                    "teacher": teacher,
                    "predicted": predicted,
                    "teacher_rank": teacher_rank,
                    "top3": ranked_ids[:3],
                }
            )
    def rate(key: str) -> float | None:
        if totals[key] == 0:
            return None
        return hits[key] / totals[key]

    def grouped(prefix: str) -> dict[str, dict[str, float | int | None]]:
        out = {}
        for key, count in sorted(totals.items()):
            if not key.startswith(prefix):
                continue
            name = key[len(prefix) :]
            top3 = None if top3_totals[key] == 0 else top3_hits[key] / top3_totals[key]
            out[name] = {"n": count, "top1": hits[key] / count, "top3": top3}
        return out

    return {
        "n": totals["overall"],
        "top1": rate("overall"),
        "top3": None if top3_totals["overall"] == 0 else top3_hits["overall"] / top3_totals["overall"],
        "top3_n": top3_totals["overall"],
        "invalid_predictions": invalid,
        "unmapped_teacher_actions": unmapped_teacher,
        "chance": chance_rate(examples),
        "type_agreement": type_hits / totals["overall"] if totals["overall"] else None,
        "within_type_agreement": None if within_n == 0 else within_hits / within_n,
        "within_type_n": within_n,
        "multi_legal_top1": None if multi_n == 0 else multi_hits / multi_n,
        "multi_legal_n": multi_n,
        "single_legal_top1": None if single_n == 0 else single_hits / single_n,
        "single_legal_n": single_n,
        "by_phase": grouped("phase:"),
        "by_action_type": grouped("type:"),
        "by_legal_count": grouped("legal:"),
        "by_hand": grouped("hand:"),
        "by_public_vp": grouped("vp:"),
        "by_policy": grouped("policy:"),
        "teacher_type_counts": dict(teacher_types),
        "predicted_type_counts": dict(predicted_types),
        "disagreements": disagreements,
    }


def train_imitation(examples: list[dict], device: torch.device, epochs: int, seed: int, batch_size: int, balance: bool = False) -> PolicyValueNet:
    from .train import behavior_weights

    torch.manual_seed(seed)
    model = PolicyValueNet().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    weights = behavior_weights(examples) if balance else None
    train_steps(model, optimizer, examples, device, epochs=epochs, batch_size=batch_size, weights=weights)
    return model


def acceptance(overfit_top1: float, holdout_top1: float, holdout_chance: float) -> dict:
    holdout_bar = max(HELDOUT_TOP1_MIN, holdout_chance + HELDOUT_LIFT_OVER_CHANCE)
    return {
        "overfit_top1_min": OVERFIT_TOP1_MIN,
        "overfit_epochs": OVERFIT_EPOCHS,
        "fit_epochs": FIT_EPOCHS,
        "holdout_top1_min": HELDOUT_TOP1_MIN,
        "holdout_lift_over_chance": HELDOUT_LIFT_OVER_CHANCE,
        "holdout_bar": holdout_bar,
        "overfit_passed": overfit_top1 >= OVERFIT_TOP1_MIN,
        "holdout_passed": holdout_top1 >= holdout_bar,
        "ready_for_ppo": overfit_top1 >= OVERFIT_TOP1_MIN and holdout_top1 >= holdout_bar,
    }


def assert_disjoint(fit: list[dict], holdout: list[dict]) -> None:
    fit_seeds = {example["seed"] for example in fit}
    holdout_seeds = {example["seed"] for example in holdout}
    if fit_seeds & holdout_seeds:
        raise RuntimeError(f"fit and holdout share seeds: {sorted(fit_seeds & holdout_seeds)}")
    fit_games = {example["game_id"] for example in fit}
    holdout_games = {example["game_id"] for example in holdout}
    if fit_games & holdout_games:
        raise RuntimeError("fit and holdout share a game id")
    if fit_seeds != set(FIT_SEEDS):
        raise RuntimeError(f"fit seeds {sorted(fit_seeds)} are not {list(FIT_SEEDS)}")
    if holdout_seeds != set(HOLDOUT_SEEDS):
        raise RuntimeError(f"holdout seeds {sorted(holdout_seeds)} are not {list(HOLDOUT_SEEDS)}")


def trace_matched_games(model: PolicyValueNet, device: torch.device, repo_root) -> list[dict]:
    """One generated board, both seats, at the standard 10 VP / 70 turn / 450 action limits.

    The trace is a divergence diagnostic. It is not a strength comparison.
    """
    from .rl import SimulatorBridge

    bridge = SimulatorBridge(repo_root)
    traces = []
    try:
        for learner in ("c1", "c2"):
            reply = bridge.request(
                {
                    "cmd": "start",
                    "seed": TRACE_SEED,
                    "learner": learner,
                    "opponent": "baseline_heuristic_v1",
                    "teacher": "baseline_heuristic_v1",
                    "victoryPointsToWin": TRACE_LIMITS["victoryPointsToWin"],
                    "maxTurns": TRACE_LIMITS["maxTurns"],
                    "maxActions": TRACE_LIMITS["maxActions"],
                    "checkpoint": "fidelity-supervised",
                    "detail": "summary",
                }
            )
            steps = []
            apply_errors = 0
            while reply.get("type") == "decision":
                observation = reply["observation"]
                legal_ids = [str(candidate["action_id"]) for candidate in observation["candidates"]]
                ranked = sorted(score_candidates(model, observation, device), key=lambda item: item[1], reverse=True)
                predicted = ranked[0][0]
                teacher = reply.get("teacher_action_id")
                gap = None if len(ranked) < 2 else ranked[0][1] - ranked[1][1]
                steps.append(
                    {
                        "decision_index": reply.get("decision_index"),
                        "phase": observation.get("phase"),
                        "public_vp": observation.get("actor", {}).get("public_vp"),
                        "hand": observation.get("actor", {}).get("hand"),
                        "production": observation.get("actor", {}).get("production"),
                        "legal_types": sorted({str(candidate["type"]) for candidate in observation["candidates"]}),
                        "legal_count": len(legal_ids),
                        "predicted": predicted,
                        "predicted_legal": predicted in legal_ids,
                        "score_gap": gap,
                        "teacher": teacher,
                        "agrees": predicted == teacher,
                        "teacher_rank": None if teacher not in [action_id for action_id, _score in ranked] else [action_id for action_id, _score in ranked].index(teacher),
                    }
                )
                reply = bridge.request({"cmd": "act", "action_id": predicted})
                if reply.get("type") == "error":
                    apply_errors += 1
                    steps[-1]["apply_error"] = reply.get("message")
                    break
            terminal = reply if reply.get("type") == "terminal" else {"type": reply.get("type"), "message": reply.get("message")}
            traces.append(
                {
                    "learner": learner,
                    "limits": TRACE_LIMITS,
                    "seed": TRACE_SEED,
                    "decisions": len(steps),
                    "agreements": sum(1 for step in steps if step["agrees"]),
                    "apply_errors": apply_errors,
                    "illegal_predictions": sum(1 for step in steps if not step["predicted_legal"]),
                    "terminal": terminal,
                    "steps": steps,
                }
            )
    finally:
        bridge.close()
    return traces


def write_report(path, payload: dict) -> None:
    from pathlib import Path

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
