"""Learner-state aggregation for the frozen summary v4 policy.

The network chooses the actions that build the trajectory. baseline_heuristic_v1
is asked for a label on that same state. Its label is behavior, not an optimum.
Cutoff games keep their decisions and do not receive a win, a loss, or a value.

The acceptance numbers below were written before any aggregated candidate was
scored. Do not lower them after reading the candidate.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path
from statistics import median

import torch
import torch.nn.functional as F

from .coverage import PHASE6_BATCH, PHASE6_EPOCHS, PHASE6_SEED, WITHIN_TYPE_READY, _collate_v4, _train_summary, with_teacher_labels, within_by_type
from .fidelity import evaluate_imitation
from .match import MATCH_LIMITS, MATCH_SEEDS, _weight_hash
from .model import PolicyValueNet
from .schema import observation_leak, validate_example
from .tracked import FEATURE_VERSION_V4, GLOBAL_DIM_V4, encode_observation_v4
from .train import supervised_loss

OPPONENT = "baseline_heuristic_v1"
TEACHER = "baseline_heuristic_v1"
PROFILE = "colonist_benchmark_1v1_v1"
FEATURE_VERSION = FEATURE_VERSION_V4

# Budgets fixed from the phase-7 match rate before this phase scored a candidate.
# Timing may refuse a larger job; it may not grow the budget after disagreement counts.
TRAIN_SEED_COUNT = 32
VAL_SEED_COUNT = 8
FINAL_SEED_COUNT = 8
TIMING_SEED_COUNT = 2
TIMING_MAX_SECONDS_PER_GAME = 3.0

# Pairwise variant rule, written before the score audit.
# Authorize it when frozen v4 prefers endTurn over the teacher on more than half
# of in-distribution rows whose teacher action is a road or a bank trade and
# endTurn is legal. Otherwise ordinary cross-entropy is the only candidate.
PAIRWISE_RATE_ABOVE = 0.50

# Held-out action-selection gate. Not a playing-strength claim.
TARGET_MIN_N = 40
ROAD_RECOVERY_LIFT = 0.15
ROAD_RECOVERY_MIN = 0.25
TRADE_RECOVERY_LIFT = 0.10
TRADE_RECOVERY_MIN = 0.25
NATURAL_DROP_MAX = 0.02
OTHER_TYPE_DROP_MAX = 0.05
CONTROL_TYPES = ("moveRobber", "placeSetupSettlement", "discard")
HARD_TYPES = ("buildRoad", "bankTrade", "moveRobber", "placeSetupSettlement")

BANNED_PREFIXES = (
    "ml-v4-match-",
    "ml-phase6-train-",
    "ml-phase6-val-",
    "ml-phase6-final-",
    "ml-fidelity-",
    "ml-graph-",
    "ml-rl-",
    "ml-holdout-",
)
SPLIT_PREFIX = {
    "train": "ml-v4-agg-train-",
    "val": "ml-v4-agg-val-",
    "final": "ml-v4-agg-final-",
    "timing": "ml-v4-agg-timing-",
}
SPLIT_COUNTS = {
    "train": TRAIN_SEED_COUNT,
    "val": VAL_SEED_COUNT,
    "final": FINAL_SEED_COUNT,
    "timing": TIMING_SEED_COUNT,
}
COSTS = {
    "road": {"lumber": 1, "brick": 1},
    "settlement": {"lumber": 1, "brick": 1, "wool": 1, "grain": 1},
    "city": {"grain": 2, "ore": 3},
    "dev": {"wool": 1, "grain": 1, "ore": 1},
}
REWARD_NOTE = (
    "Trajectory action is frozen colonist_features_v4. "
    "The label is baseline_heuristic_v1 evaluated on this state before the action was applied. "
    "Heuristic behavior, not an optimal move. A cutoff is not a win, a loss, or a value target."
)


def seeds_for(split: str) -> tuple[str, ...]:
    if split not in SPLIT_PREFIX:
        raise RuntimeError(f"unknown split {split}")
    prefix = SPLIT_PREFIX[split]
    return tuple(f"{prefix}{index}" for index in range(SPLIT_COUNTS[split]))


def assert_agg_seeds(seeds: tuple[str, ...] | list[str], split: str) -> None:
    prefix = SPLIT_PREFIX[split]
    allowed = set(seeds_for(split))
    other_prefixes = tuple(value for key, value in SPLIT_PREFIX.items() if key != split)
    for seed in seeds:
        if seed not in allowed or not seed.startswith(prefix):
            raise RuntimeError(f"seed {seed} is outside {prefix}")
        if any(seed.startswith(banned) for banned in BANNED_PREFIXES):
            raise RuntimeError(f"seed {seed} reuses an earlier split")
        if any(seed.startswith(other) for other in other_prefixes):
            raise RuntimeError(f"seed {seed} crosses aggregation splits")


def action_type(action_id: str | None) -> str:
    if not action_id:
        return ""
    return str(action_id).split(":", 1)[0]


def disagreement_kind(learner_action: str, teacher_action: str) -> str | None:
    if action_type(learner_action) != "endTurn":
        return None
    teacher = action_type(teacher_action)
    if teacher == "buildRoad":
        return "endturn_vs_road"
    if teacher == "bankTrade":
        return "endturn_vs_trade"
    return None


def _without_location(features: dict) -> str:
    data = dict(features)
    for key in ("corner_index", "edge_index", "hex_index"):
        data.pop(key, None)
    return json.dumps(data, sort_keys=True)


def _hand(observation: dict) -> dict:
    hand = (observation.get("actor") or {}).get("hand") or {}
    return {name: int(hand.get(name, 0)) for name in ("lumber", "brick", "wool", "grain", "ore")}


def can_pay(hand: dict, cost: dict) -> bool:
    return all(int(hand.get(name, 0)) >= amount for name, amount in cost.items())


def parse_trade(action_id: str) -> tuple[str, int, str, int] | None:
    parts = str(action_id).split(":")
    if len(parts) < 5 or parts[0] != "bankTrade":
        return None
    return parts[1], int(parts[2]), parts[3], int(parts[4])


def trade_effect(hand: dict, action_id: str) -> dict:
    parsed = parse_trade(action_id)
    if parsed is None:
        return {"affordable_give": False, "newly_affordable": [], "deficit_reduced": []}
    give, give_count, receive, receive_count = parsed
    affordable = int(hand.get(give, 0)) >= give_count
    after = dict(hand)
    after[give] = int(after.get(give, 0)) - give_count
    after[receive] = int(after.get(receive, 0)) + receive_count
    newly = []
    reduced = []
    for name, cost in COSTS.items():
        before_missing = sum(max(0, amount - int(hand.get(resource, 0))) for resource, amount in cost.items())
        after_missing = sum(max(0, amount - int(after.get(resource, 0))) for resource, amount in cost.items())
        if before_missing > 0 and after_missing == 0:
            newly.append(name)
        if after_missing < before_missing:
            reduced.append(name)
    return {"affordable_give": affordable, "newly_affordable": newly, "deficit_reduced": reduced}


def road_affordable(hand: dict) -> bool:
    return can_pay(hand, COSTS["road"])


def build_example(
    *,
    game_id: str,
    seed: str,
    decision_index: int,
    observation: dict,
    learner_action: str,
    teacher_action: str,
    checkpoint_hash: str,
    checkpoint_path: str,
    completion_status: str,
    cutoff_reason: str | None,
    actor_win: float | None,
    teacher_diagnostic: dict | None,
    learner_seat: str,
) -> dict:
    if observation_leak(observation):
        raise RuntimeError(observation_leak(observation))
    legal = [str(candidate["action_id"]) for candidate in observation["candidates"]]
    if learner_action not in legal:
        raise RuntimeError("learner action is not a legal candidate")
    if teacher_action not in legal:
        raise RuntimeError("teacher action is not a legal candidate")
    if completion_status == "incomplete" and actor_win is not None:
        raise RuntimeError("cutoff trajectory cannot carry a terminal value")
    if completion_status == "completed" and actor_win not in (0, 0.5, 1):
        raise RuntimeError("completed trajectory needs a terminal score")
    kind = disagreement_kind(learner_action, teacher_action)
    example = {
        "schema_version": "colonist_training_example_v1",
        "example_id": f"{game_id}:{decision_index}",
        "game_id": game_id,
        "decision_index": decision_index,
        "seed": seed,
        "ruleset": "base",
        "player_count": 2,
        "generating_policy": FEATURE_VERSION,
        "model_checkpoint": checkpoint_hash,
        "completion_status": completion_status,
        "cutoff_reason": cutoff_reason,
        "target_provenance": "heuristic_demonstration",
        "label_role": "heuristic_behavior",
        "chosen_action_id": learner_action,
        "teacher_action_id": teacher_action,
        "teacher_policy": TEACHER,
        "actor_win": actor_win,
        "reward_note": REWARD_NOTE,
        "observation": observation,
        "simulator": {
            "victory_points_to_win": MATCH_LIMITS["victoryPointsToWin"],
            "max_turns": MATCH_LIMITS["maxTurns"],
            "max_actions": MATCH_LIMITS["maxActions"],
            "dice_mode": "balanced",
            "dice_model": "balanced_24_of_36_shoe_approx",
            "domestic_trades": "not_offered",
            "board": "generated_opening_not_colonist_map_seed",
            "rule_profile": PROFILE,
        },
        "sample_weight": 1,
        "diagnostic_slice": kind,
        "teacher_diagnostic": teacher_diagnostic,
        "feature_version": FEATURE_VERSION,
        "checkpoint_path": checkpoint_path,
        "learner_seat": learner_seat,
        "opponent_policy": OPPONENT,
    }
    validate_example(example)
    return example


def mix_corpora(original: list[dict], aggregated: list[dict]) -> list[dict]:
    """Each row once, weight 1. Disagreement rows are not duplicated."""
    mixed = list(original) + list(aggregated)
    for example in mixed:
        weight = example.get("sample_weight", 1)
        if weight != 1:
            raise RuntimeError("aggregation training uses weight 1 on every row")
    return mixed


def _score(model, observation: dict, device: torch.device) -> list[tuple[str, float]]:
    model.eval()
    with torch.inference_mode():
        global_x, candidates, ids = encode_observation_v4(observation, device)
        if global_x.numel() != GLOBAL_DIM_V4:
            raise RuntimeError("feature width is not colonist_features_v4")
        mask = torch.ones(1, candidates.size(0), dtype=torch.bool, device=device)
        logits, _value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
        return [(action_id, float(logits[0, index].item())) for index, action_id in enumerate(ids)]


def _best_of_type(ranked: list[tuple[str, float]]) -> dict[str, dict]:
    best: dict[str, dict] = {}
    for action_id, score in ranked:
        kind = action_type(action_id)
        current = best.get(kind)
        if current is None or score > current["score"]:
            best[kind] = {"action_id": action_id, "score": score}
    return best


def _summary_numbers(values: list[float]) -> dict:
    if not values:
        return {"n": 0, "mean": None, "median": None}
    return {"n": len(values), "mean": sum(values) / len(values), "median": median(values)}


def _blank_slice() -> dict:
    return {
        "n": 0,
        "cross_type": 0,
        "within_type_miss": 0,
        "exact": 0,
        "margins": [],
        "aliased": 0,
        "aliased_without_location": 0,
        "road_affordable": 0,
        "trade_affordable": 0,
        "reach_hist": Counter(),
        "opens_settlement_now": 0,
        "no_open_settlement": 0,
        "newly_affordable": Counter(),
        "deficit_reduced": Counter(),
        "samples": [],
    }


def _close_slice(row: dict) -> dict:
    return {
        "n": row["n"],
        "cross_type": row["cross_type"],
        "within_type_miss": row["within_type_miss"],
        "exact": row["exact"],
        "margin_teacher_minus_endturn": _summary_numbers(row["margins"]),
        "aliased_teacher_features": row["aliased"],
        "aliased_ignoring_edge_index": row["aliased_without_location"],
        "road_affordable": row["road_affordable"],
        "trade_affordable": row["trade_affordable"],
        "reach_hist": dict(row["reach_hist"]),
        "opens_settlement_now": row["opens_settlement_now"],
        "no_open_settlement_legal": row["no_open_settlement"],
        "newly_affordable": dict(row["newly_affordable"]),
        "deficit_reduced": dict(row["deficit_reduced"]),
        "samples": row["samples"],
    }


def _consider(model, device, observation: dict, learner_action: str, teacher_action: str, diagnostic: dict | None, slices: dict, agreed_endturn: list) -> None:
    ranked = sorted(_score(model, observation, device), key=lambda item: item[1], reverse=True)
    scores = dict(ranked)
    predicted = ranked[0][0]
    teacher_kind = action_type(teacher_action)
    predicted_kind = action_type(predicted)
    end_score = scores.get("endTurn")
    teacher_score = scores.get(teacher_action)
    legal_types = sorted({str(candidate["type"]) for candidate in observation["candidates"]})
    hand = _hand(observation)
    if predicted == "endTurn" and teacher_action == "endTurn":
        agreed_endturn.append(1)
    kind = disagreement_kind(learner_action, teacher_action)
    if kind is None:
        return
    row = slices[kind]
    row["n"] += 1
    if predicted_kind != teacher_kind:
        row["cross_type"] += 1
    elif predicted != teacher_action:
        row["within_type_miss"] += 1
    if predicted == teacher_action:
        row["exact"] += 1
    if end_score is not None and teacher_score is not None:
        row["margins"].append(teacher_score - end_score)
    teacher_candidate = next(candidate for candidate in observation["candidates"] if candidate["action_id"] == teacher_action)
    teacher_key = json.dumps(teacher_candidate.get("public_features") or {}, sort_keys=True)
    aliases = [
        candidate["action_id"]
        for candidate in observation["candidates"]
        if candidate["action_id"] != teacher_action and json.dumps(candidate.get("public_features") or {}, sort_keys=True) == teacher_key
    ]
    if aliases:
        row["aliased"] += 1
    bare = _without_location(teacher_candidate.get("public_features") or {})
    bare_aliases = [
        candidate["action_id"]
        for candidate in observation["candidates"]
        if candidate["action_id"] != teacher_action and _without_location(candidate.get("public_features") or {}) == bare
    ]
    if bare_aliases:
        row["aliased_without_location"] += 1
    if road_affordable(hand):
        row["road_affordable"] += 1
    effect = trade_effect(hand, teacher_action) if teacher_kind == "bankTrade" else None
    if effect and effect["affordable_give"]:
        row["trade_affordable"] += 1
        for name in effect["newly_affordable"]:
            row["newly_affordable"][name] += 1
        for name in effect["deficit_reduced"]:
            row["deficit_reduced"][name] += 1
    reach = (diagnostic or {}).get("road_reach") or {}
    if "dist" in reach:
        dist = int(reach["dist"])
        row["reach_hist"][">3" if dist > 3 else str(dist)] += 1
        if reach.get("opens_settlement_now"):
            row["opens_settlement_now"] += 1
    if "buildSettlement" not in legal_types:
        row["no_open_settlement"] += 1
    if len(row["samples"]) < 8:
        best = _best_of_type(ranked)
        row["samples"].append(
            {
                "phase": observation.get("phase"),
                "rule_profile": PROFILE,
                "legal_types": legal_types,
                "candidate_count": len(observation["candidates"]),
                "teacher": teacher_action,
                "learner": learner_action,
                "predicted": predicted,
                "end_turn_score": end_score,
                "teacher_score": teacher_score,
                "margin_teacher_minus_endturn": None if end_score is None or teacher_score is None else teacher_score - end_score,
                "best_by_type": best,
                "hand": hand,
                "production": (observation.get("actor") or {}).get("production"),
                "public_vp": (observation.get("actor") or {}).get("public_vp"),
                "settlements_left": (observation.get("actor") or {}).get("settlements_left"),
                "road_affordable": road_affordable(hand),
                "trade_effect": effect,
                "teacher_diagnostic": diagnostic,
                "feature_alias_ids": aliases[:4],
                "explanation_available": False,
            }
        )


def in_distribution_audit(model, examples: list[dict], device: torch.device) -> dict:
    """Frozen v4 on teacher-generated rows. Diagnosis only."""
    road_margins = []
    trade_margins = []
    road_end_wins = 0
    trade_end_wins = 0
    road_n = 0
    trade_n = 0
    road_exact = 0
    trade_exact = 0
    road_cross = 0
    trade_cross = 0
    for example in examples:
        teacher = str(example.get("teacher_action_id") or "")
        kind = action_type(teacher)
        if kind not in ("buildRoad", "bankTrade"):
            continue
        observation = example["observation"]
        legal = {str(candidate["action_id"]) for candidate in observation["candidates"]}
        if "endTurn" not in legal or teacher not in legal:
            continue
        ranked = _score(model, observation, device)
        scores = dict(ranked)
        predicted = max(ranked, key=lambda item: item[1])[0]
        margin = scores[teacher] - scores["endTurn"]
        if kind == "buildRoad":
            road_n += 1
            road_margins.append(margin)
            road_end_wins += int(scores["endTurn"] > scores[teacher])
            road_exact += int(predicted == teacher)
            road_cross += int(action_type(predicted) != "buildRoad")
        else:
            trade_n += 1
            trade_margins.append(margin)
            trade_end_wins += int(scores["endTurn"] > scores[teacher])
            trade_exact += int(predicted == teacher)
            trade_cross += int(action_type(predicted) != "bankTrade")
    road_rate = None if road_n == 0 else road_end_wins / road_n
    trade_rate = None if trade_n == 0 else trade_end_wins / trade_n
    authorized = bool(
        (road_rate is not None and road_rate > PAIRWISE_RATE_ABOVE)
        or (trade_rate is not None and trade_rate > PAIRWISE_RATE_ABOVE)
    )
    return {
        "source": "phase-6 validation, teacher-generated states, diagnosis only",
        "teacher_road_with_endturn_legal": {
            "n": road_n,
            "endturn_scored_above_teacher": road_end_wins,
            "rate": road_rate,
            "exact_top1": None if road_n == 0 else road_exact / road_n,
            "cross_type": road_cross,
            "margin_teacher_minus_endturn": _summary_numbers(road_margins),
        },
        "teacher_trade_with_endturn_legal": {
            "n": trade_n,
            "endturn_scored_above_teacher": trade_end_wins,
            "rate": trade_rate,
            "exact_top1": None if trade_n == 0 else trade_exact / trade_n,
            "cross_type": trade_cross,
            "margin_teacher_minus_endturn": _summary_numbers(trade_margins),
        },
        "pairwise_variant_authorized": authorized,
        "authorization_rule": (
            f"Authorize pairwise_endturn_margin_v1 when either rate is above {PAIRWISE_RATE_ABOVE}. "
            "The extra term is relu(endTurn logit - teacher logit + 1) on rows whose teacher "
            "action is a road or bank trade and endTurn is legal. It is not a class weight, "
            "and it is not applied when the teacher chose endTurn."
        ),
    }


def label_counts(path: str) -> dict:
    counts: Counter = Counter()
    rows = 0
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            example = json.loads(line)
            rows += 1
            counts[action_type(str(example.get("teacher_action_id") or example.get("chosen_action_id") or ""))] += 1
    return {"rows": rows, "teacher_types": dict(counts)}


def _start_payload(seed: str, learner: str, checkpoint: str, detail: str = "summary") -> dict:
    return {
        "cmd": "start",
        "seed": seed,
        "learner": learner,
        "opponent": OPPONENT,
        "teacher": TEACHER,
        "victoryPointsToWin": MATCH_LIMITS["victoryPointsToWin"],
        "maxTurns": MATCH_LIMITS["maxTurns"],
        "maxActions": MATCH_LIMITS["maxActions"],
        "checkpoint": checkpoint,
        "detail": detail,
    }


def collect_game(bridge, model: PolicyValueNet, device: torch.device, seed: str, learner: str, checkpoint: str, checkpoint_hash: str, detail: str = "summary") -> dict:
    if getattr(model, "feature_version", "") != FEATURE_VERSION_V4:
        raise RuntimeError("aggregation refuses a checkpoint that is not colonist_features_v4")
    model.eval()
    reply = bridge.request(_start_payload(seed, learner, checkpoint, detail))
    pending = []
    while reply.get("type") == "decision":
        observation = reply["observation"]
        if observation.get("schema_version") != "colonist_observation_v2":
            raise RuntimeError("observation schema drifted")
        teacher = reply.get("teacher_action_id")
        if not teacher:
            raise RuntimeError("teacher label missing on a learner state")
        ranked = _score(model, observation, device)
        legal = [str(candidate["action_id"]) for candidate in observation["candidates"]]
        if {action_id for action_id, _score in ranked} != set(legal):
            raise RuntimeError("score list does not match the legal candidates")
        action_id = max(ranked, key=lambda item: item[1])[0]
        if action_id not in legal:
            raise RuntimeError("policy emitted an unlisted action")
        pending.append(
            {
                "game_id": reply["game_id"],
                "decision_index": reply["decision_index"],
                "observation": observation,
                "learner_action": action_id,
                "teacher_action": teacher,
                "teacher_diagnostic": reply.get("teacher_diagnostic"),
            }
        )
        reply = bridge.request({"cmd": "act", "action_id": action_id})
        if reply.get("type") == "error":
            raise RuntimeError(reply.get("message", "bridge error"))
    if reply.get("type") != "terminal":
        raise RuntimeError(reply.get("message", "bridge closed"))
    completed = reply["completion_status"] == "completed"
    actor_win = reply["actor_win"][learner] if completed else None
    if not completed and reply["actor_win"][learner] is not None:
        raise RuntimeError("bridge attached a terminal value to a cutoff")
    examples = [
        build_example(
            game_id=row["game_id"],
            seed=seed,
            decision_index=row["decision_index"],
            observation=row["observation"],
            learner_action=row["learner_action"],
            teacher_action=row["teacher_action"],
            checkpoint_hash=checkpoint_hash,
            checkpoint_path=checkpoint,
            completion_status="completed" if completed else "incomplete",
            cutoff_reason=None if completed else reply.get("cutoff_reason"),
            actor_win=actor_win,
            teacher_diagnostic=row["teacher_diagnostic"],
            learner_seat=learner,
        )
        for row in pending
    ]
    return {"examples": examples, "terminal": reply}


def write_jsonl(path: str, examples: list[dict]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        for example in examples:
            handle.write(json.dumps(example, separators=(",", ":")) + "\n")


def collect_split(bridge, model, device, checkpoint: str, split: str, out_path: str, detail: str = "summary") -> dict:
    seeds = seeds_for(split)
    assert_agg_seeds(seeds, split)
    checkpoint_hash = _weight_hash(model)
    examples = []
    games = []
    started = time.perf_counter()
    for seed in seeds:
        for learner in ("c1", "c2"):
            played = collect_game(bridge, model, device, seed, learner, checkpoint, checkpoint_hash, detail=detail)
            examples.extend(played["examples"])
            terminal = played["terminal"]
            games.append(
                {
                    "seed": seed,
                    "learner": learner,
                    "completion_status": terminal["completion_status"],
                    "cutoff_reason": terminal.get("cutoff_reason"),
                    "decisions": len(played["examples"]),
                }
            )
    elapsed = time.perf_counter() - started
    write_jsonl(out_path, examples)
    slices = Counter(example["diagnostic_slice"] or "other" for example in examples)
    completed_games = sum(1 for game in games if game["completion_status"] == "completed")
    per_game = None if not games else elapsed / len(games)
    if split == "timing" and per_game is not None and per_game > TIMING_MAX_SECONDS_PER_GAME:
        raise RuntimeError(f"timing {per_game:.2f}s per game exceeds {TIMING_MAX_SECONDS_PER_GAME}")
    return {
        "split": split,
        "seeds": list(seeds),
        "games": len(games),
        "completed_games": completed_games,
        "cutoff_games": len(games) - completed_games,
        "decisions": len(examples),
        "diagnostic_slices": dict(slices),
        "elapsed_seconds": elapsed,
        "seconds_per_game": per_game,
        "checkpoint_sha256": checkpoint_hash,
        "out": out_path,
    }


def game_fingerprint(bridge, model, device, seed: str, learner: str, checkpoint: str) -> list[tuple]:
    played = collect_game(bridge, model, device, seed, learner, checkpoint, _weight_hash(model))
    return [
        (example["decision_index"], example["chosen_action_id"], example["teacher_action_id"], example["completion_status"], example["actor_win"])
        for example in played["examples"]
    ]


def audit_match_seeds(bridge, model, device, seeds: tuple[str, ...]) -> dict:
    slices = {"endturn_vs_road": _blank_slice(), "endturn_vs_trade": _blank_slice()}
    agreed = []
    games = 0
    decisions = 0
    completed = 0
    cutoffs: Counter = Counter()
    within_road_miss = 0
    teacher_road = 0
    teacher_trade = 0
    for seed in seeds:
        for learner in ("c1", "c2"):
            played = collect_game(bridge, model, device, seed, learner, "diagnosis-only", _weight_hash(model))
            games += 1
            terminal = played["terminal"]
            if terminal["completion_status"] == "completed":
                completed += 1
            else:
                cutoffs[terminal.get("cutoff_reason") or "unknown"] += 1
            for example in played["examples"]:
                decisions += 1
                teacher = example["teacher_action_id"]
                learner_action = example["chosen_action_id"]
                if action_type(teacher) == "buildRoad":
                    teacher_road += 1
                    if action_type(learner_action) == "buildRoad" and learner_action != teacher:
                        within_road_miss += 1
                if action_type(teacher) == "bankTrade":
                    teacher_trade += 1
                _consider(
                    model,
                    device,
                    example["observation"],
                    learner_action,
                    teacher,
                    example.get("teacher_diagnostic"),
                    slices,
                    agreed,
                )
    return {
        "seeds": "ml-v4-match diagnosis only; not a training or final-test source",
        "seed_count": len(seeds),
        "games": games,
        "completed_games": completed,
        "cutoffs": dict(cutoffs),
        "learner_decisions": decisions,
        "teacher_road_decisions": teacher_road,
        "teacher_trade_decisions": teacher_trade,
        "model_chose_other_road": within_road_miss,
        "agreed_endturn": len(agreed),
        "endturn_vs_road": _close_slice(slices["endturn_vs_road"]),
        "endturn_vs_trade": _close_slice(slices["endturn_vs_trade"]),
        "explanation_available": False,
        "note": (
            "selectAction returns an action and no text. road_reach is the same settlement-distance "
            "the baseline uses, attached outside the observation. A teacher label is not proof the action is optimal."
        ),
    }


def targeted_recovery(model, examples: list[dict], device: torch.device, scorer=None) -> dict:
    score = scorer or _score
    grouped = {"endturn_vs_road": [], "endturn_vs_trade": []}
    for example in examples:
        kind = disagreement_kind(str(example["chosen_action_id"]), str(example.get("teacher_action_id") or ""))
        if kind:
            grouped[kind].append(example)
    report = {}
    for kind, rows in grouped.items():
        exact = 0
        type_hits = 0
        top3 = 0
        margins = []
        invalid = 0
        for example in rows:
            teacher = str(example["teacher_action_id"])
            legal = [str(candidate["action_id"]) for candidate in example["observation"]["candidates"]]
            ranked = sorted(score(model, example["observation"], device), key=lambda item: item[1], reverse=True)
            ids = [action_id for action_id, _score in ranked]
            if set(ids) != set(legal):
                invalid += 1
                continue
            scores = dict(ranked)
            if ids[0] == teacher:
                exact += 1
            if action_type(ids[0]) == action_type(teacher):
                type_hits += 1
            if teacher in ids[:3]:
                top3 += 1
            if "endTurn" in scores and teacher in scores:
                margins.append(scores[teacher] - scores["endTurn"])
        count = len(rows)
        report[kind] = {
            "n": count,
            "exact": None if count == 0 else exact / count,
            "type_agreement": None if count == 0 else type_hits / count,
            "top3": None if count == 0 else top3 / count,
            "invalid": invalid,
            "margin_teacher_minus_endturn": _summary_numbers(margins),
        }
    return report


def selection_view(model, examples: list[dict], device: torch.device, scorer=None) -> dict:
    score = scorer or _score
    labeled = with_teacher_labels(examples)
    started = time.perf_counter()
    imitation = evaluate_imitation(model, labeled, device, scorer=score)
    elapsed = time.perf_counter() - started
    within = within_by_type(model, labeled, device, score)
    return {
        "natural": {
            "n": imitation["n"],
            "top1": imitation["top1"],
            "top3": imitation["top3"],
            "multi_legal_top1": imitation["multi_legal_top1"],
            "multi_legal_n": imitation["multi_legal_n"],
            "type_agreement": imitation["type_agreement"],
            "within_type_agreement": imitation["within_type_agreement"],
            "invalid_predictions": imitation["invalid_predictions"],
            "by_action_type": imitation["by_action_type"],
            "predicted_type_counts": imitation["predicted_type_counts"],
        },
        "within_by_type": within,
        "targeted": targeted_recovery(model, examples, device, scorer=score),
        "inference_ms": None if not examples else elapsed * 1000.0 / len(examples),
    }


def _rate(block: dict, key: str) -> float | None:
    value = block.get(key)
    return None if value is None else float(value)


def meets_action_criteria(baseline: dict, candidate: dict) -> dict:
    """True only when the candidate clears the predeclared action-selection gate."""
    reasons = []
    base_target = baseline["targeted"]
    cand_target = candidate["targeted"]
    for kind, lift, floor in (
        ("endturn_vs_road", ROAD_RECOVERY_LIFT, ROAD_RECOVERY_MIN),
        ("endturn_vs_trade", TRADE_RECOVERY_LIFT, TRADE_RECOVERY_MIN),
    ):
        count = int(cand_target[kind]["n"])
        if count < TARGET_MIN_N:
            reasons.append(f"{kind} n {count} < {TARGET_MIN_N}")
            continue
        old = _rate(base_target[kind], "exact")
        new = _rate(cand_target[kind], "exact")
        if old is None or new is None or new < old + lift or new < floor:
            reasons.append(f"{kind} exact {new} versus {old}")
    old_top = _rate(baseline["natural"], "top1")
    new_top = _rate(candidate["natural"], "top1")
    old_multi = _rate(baseline["natural"], "multi_legal_top1")
    new_multi = _rate(candidate["natural"], "multi_legal_top1")
    if old_top is None or new_top is None or new_top < old_top - NATURAL_DROP_MAX:
        reasons.append(f"natural top1 {new_top} versus {old_top}")
    if old_multi is None or new_multi is None or new_multi < old_multi - NATURAL_DROP_MAX:
        reasons.append(f"natural multi-legal top1 {new_multi} versus {old_multi}")
    if int(candidate["natural"]["invalid_predictions"]) != 0:
        reasons.append("illegal predictions")
    for action_type_name in HARD_TYPES:
        row = candidate["within_by_type"][action_type_name]
        if int(row["n"]) >= TARGET_MIN_N and (row["within_type"] is None or float(row["within_type"]) < WITHIN_TYPE_READY):
            reasons.append(f"within-type {action_type_name} {row['within_type']}")
    for action_type_name in CONTROL_TYPES:
        old_row = baseline["natural"]["by_action_type"].get(action_type_name) or {}
        new_row = candidate["natural"]["by_action_type"].get(action_type_name) or {}
        if int(old_row.get("n") or 0) < TARGET_MIN_N:
            continue
        old = old_row.get("top1")
        new = new_row.get("top1")
        if old is None or new is None or float(new) < float(old) - OTHER_TYPE_DROP_MAX:
            reasons.append(f"{action_type_name} top1 {new} versus {old}")
    if "control" in baseline or "control" in candidate:
        old_control = baseline["control"]["natural"]
        new_control = candidate["control"]["natural"]
        if float(new_control["top1"]) < float(old_control["top1"]) - NATURAL_DROP_MAX:
            reasons.append("phase6 validation top1 regression")
        if float(new_control["multi_legal_top1"]) < float(old_control["multi_legal_top1"]) - NATURAL_DROP_MAX:
            reasons.append("phase6 validation multi-legal regression")
    return {"met": not reasons, "reasons": reasons}


def choose_variant(ordinary_met: bool, pairwise_met: bool, ordinary_multi: float | None, pairwise_multi: float | None) -> str:
    """Validation chooses the variant. The final test is not an input."""
    if ordinary_met:
        return "ordinary"
    if (
        pairwise_met
        and ordinary_multi is not None
        and pairwise_multi is not None
        and pairwise_multi >= ordinary_multi - NATURAL_DROP_MAX
    ):
        return "pairwise"
    return "ordinary"


def _pair_mask(examples: list[dict], device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    ends = []
    flags = []
    for example in examples:
        ids = [str(candidate["action_id"]) for candidate in example["observation"]["candidates"]]
        teacher = str(example["chosen_action_id"])
        end_index = ids.index("endTurn") if "endTurn" in ids else 0
        use = action_type(teacher) in ("buildRoad", "bankTrade") and "endTurn" in ids
        ends.append(end_index)
        flags.append(use)
    return (
        torch.tensor(ends, dtype=torch.long, device=device),
        torch.tensor(flags, dtype=torch.bool, device=device),
    )


def train_ordinary(examples: list[dict], device: torch.device) -> PolicyValueNet:
    labeled = with_teacher_labels(mix_checked(examples))
    torch.manual_seed(PHASE6_SEED)
    model = PolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V4).to(device)
    _train_summary(model, labeled, device, PHASE6_EPOCHS)
    model.eval()
    return model


def mix_checked(examples: list[dict]) -> list[dict]:
    for example in examples:
        if example.get("sample_weight", 1) != 1:
            raise RuntimeError("refusing a weighted row")
        if example.get("diagnostic_slice") not in (None, "endturn_vs_road", "endturn_vs_trade"):
            raise RuntimeError("unknown diagnostic slice")
    return examples


def train_pairwise(examples: list[dict], device: torch.device) -> tuple[PolicyValueNet, dict]:
    labeled = with_teacher_labels(mix_checked(examples))
    torch.manual_seed(PHASE6_SEED)
    model = PolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V4).to(device)
    torch.manual_seed(PHASE6_SEED)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    model.train()
    applied = 0
    seen = 0
    started = time.perf_counter()
    for _epoch in range(PHASE6_EPOCHS):
        for start in range(0, len(labeled), PHASE6_BATCH):
            chunk = labeled[start : start + PHASE6_BATCH]
            batch = _collate_v4(chunk, device)
            end_index, pair = _pair_mask(chunk, device)
            seen += len(chunk)
            applied += int(pair.sum().item())
            optimizer.zero_grad(set_to_none=True)
            logits, values = model(batch["global_x"], batch["candidates"], batch["mask"])
            loss, _stats = supervised_loss(logits, values, batch)
            if bool(pair.any()):
                index = torch.arange(len(chunk), device=device)
                margin = F.relu(logits[index, end_index] - logits[index, batch["chosen"]] + 1.0)
                loss = loss + (margin * pair.float()).sum() / pair.float().sum()
            loss.backward()
            optimizer.step()
    model.eval()
    return model, {
        "loss": "cross_entropy_plus_relu_endturn_margin",
        "pair_rows_seen": applied,
        "rows_seen_including_epochs": seen,
        "seconds": time.perf_counter() - started,
    }


def corpus_summary(examples: list[dict]) -> dict:
    games = {}
    slices: Counter = Counter()
    for example in examples:
        games[example["game_id"]] = example["completion_status"]
        slices[example.get("diagnostic_slice") or "other"] += 1
        if example["completion_status"] != "completed" and example["actor_win"] is not None:
            raise RuntimeError("cutoff row has a terminal value")
    completed = sum(1 for status in games.values() if status == "completed")
    return {
        "decisions": len(examples),
        "games": len(games),
        "completed_games": completed,
        "cutoff_games": len(games) - completed,
        "diagnostic_slices": dict(slices),
        "sample_weight": 1,
    }


def assert_checkpoint_unchanged(path: str, expected_hash: str) -> None:
    payload = torch.load(path, map_location="cpu")
    if payload.get("feature_version") != FEATURE_VERSION_V4:
        raise RuntimeError("frozen checkpoint feature version changed")
    model = PolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V4)
    model.load_state_dict(payload["model"])
    digest = _weight_hash(model)
    if digest != expected_hash:
        raise RuntimeError("frozen summary v4 weights changed")


def diagnosis_seeds(limit: int | None = None) -> tuple[str, ...]:
    if limit is None:
        return MATCH_SEEDS
    if limit < 1 or limit > len(MATCH_SEEDS):
        raise RuntimeError("diagnosis seed limit is outside the match namespace")
    return MATCH_SEEDS[:limit]
