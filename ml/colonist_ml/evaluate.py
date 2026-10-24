"""Held-out games against the unchanged baseline. Cutoffs stay out of the win rate."""

from __future__ import annotations

import json
import sys
import time

from .algorithm import bootstrap_mean, pair_scores
from .model import PolicyValueNet
from .protocol import EVAL_RULES, MIN_PAIRS_TO_ADOPT
from .rl import EVAL_SEEDS, SimulatorBridge, play_game

# Namespaces already used to train or to choose a model. Fresh eval seeds must stay outside them.
# ml-holdout- is the default evaluation pair for this command, so it is not in this list.
# ml-overnight-0 and ml-overnight-1 are the documented overnight training export, not the final eval range.
TRAINING_OR_SELECTION_PREFIXES = (
    "ml-phase6-",
    "ml-fidelity-",
    "ml-graph-",
    "ml-rl-",
    "ml-v4-match-",
    "ml-v4-agg-",
    "ml-v6-final-",
    "ml-v6-strength-",
    "ml-v7-strength-",
    "ml-cutoff-probe-",
)
OVERNIGHT_TRAIN_SEEDS = frozenset({"ml-overnight-0", "ml-overnight-1"})


def parse_eval_seeds(raw: str | None) -> tuple[str, ...] | None:
    """Parse a comma-separated eval seed list. None keeps the default holdout pair."""
    if raw is None:
        return None
    return validate_eval_seeds(part.strip() for part in str(raw).split(","))


def validate_eval_seeds(seeds) -> tuple[str, ...]:
    parsed = tuple(str(seed) for seed in seeds)
    if not parsed or any(seed == "" for seed in parsed):
        raise ValueError("eval seeds must be a nonempty comma-separated list")
    if len(parsed) != len(set(parsed)):
        duplicates = sorted({seed for seed in parsed if parsed.count(seed) > 1})
        raise ValueError(f"eval seeds must be unique: {duplicates}")
    for seed in parsed:
        if seed in OVERNIGHT_TRAIN_SEEDS or any(seed.startswith(prefix) for prefix in TRAINING_OR_SELECTION_PREFIXES):
            raise ValueError(f"eval seed {seed} reuses a training or model-selection namespace")
    return parsed


def _margin(terminal: dict, learner: str):
    scores = terminal.get("scores") or {}
    opponent = "c2" if learner == "c1" else "c1"
    mine = (scores.get(learner) or {}).get("actual_vp")
    theirs = (scores.get(opponent) or {}).get("actual_vp")
    if mine is None or theirs is None or terminal.get("completion_status") != "completed":
        return None
    return mine - theirs


def evaluate_against_baseline(
    bridge: SimulatorBridge,
    model: PolicyValueNet,
    device,
    checkpoint: str,
    victory_points: int | None = None,
    max_turns: int | None = None,
    max_actions: int | None = None,
    seeds: tuple[str, ...] | None = None,
) -> dict:
    victory_points = EVAL_RULES["victory_points_to_win"] if victory_points is None else victory_points
    max_turns = EVAL_RULES["max_turns"] if max_turns is None else max_turns
    max_actions = EVAL_RULES["max_actions"] if max_actions is None else max_actions
    seed_list = EVAL_SEEDS if seeds is None else seeds
    model.eval()
    rows = []
    started = time.perf_counter()
    for seed_index, seed in enumerate(seed_list):
        for learner in ("c1", "c2"):
            result = play_game(
                bridge,
                model,
                device,
                {
                    "seed": seed,
                    "learner": learner,
                    "opponent": "baseline_heuristic_v1",
                    "victoryPointsToWin": victory_points,
                    "maxTurns": max_turns,
                    "maxActions": max_actions,
                    "checkpoint": checkpoint,
                    "detail": "summary",
                },
                greedy=True,
            )
            terminal = result["terminal"]
            score = terminal["actor_win"][learner] if terminal["completion_status"] == "completed" else None
            rows.append(
                {
                    "seed": seed,
                    "learner": learner,
                    "completion_status": terminal["completion_status"],
                    "cutoff_reason": terminal["cutoff_reason"],
                    "actor_win": score,
                    "turns": terminal["turns"],
                    "actions": terminal["actions"],
                    "opponent_policy": terminal["opponent_policy"],
                    "vp_margin": _margin(terminal, learner),
                    "actual_vp": ((terminal.get("scores") or {}).get(learner) or {}).get("actual_vp"),
                    "limits": terminal.get("limits"),
                }
            )
            if learner == "c2" and seed_index % 10 == 0:
                print(
                    json.dumps({"event": "eval", "seed_index": seed_index, "seeds": len(seed_list), "games": len(rows)}),
                    file=sys.stderr,
                )
    elapsed = time.perf_counter() - started
    completed = [row for row in rows if row["actor_win"] is not None]
    pairs = pair_scores(rows)
    pair_values = [pairs[seed] for seed in seed_list if pairs.get(seed) is not None]
    interval = bootstrap_mean([value - 0.5 for value in pair_values])
    reasons: dict[str, int] = {}
    for row in rows:
        if row["completion_status"] != "completed":
            reason = row["cutoff_reason"] or "unknown"
            reasons[reason] = reasons.get(reason, 0) + 1
    by_seat = {}
    for seat in ("c1", "c2"):
        seat_rows = [row for row in completed if row["learner"] == seat]
        by_seat[seat] = {
            "completed": len(seat_rows),
            "wins": sum(1 for row in seat_rows if row["actor_win"] == 1),
            "draws": sum(1 for row in seat_rows if row["actor_win"] == 0.5),
            "losses": sum(1 for row in seat_rows if row["actor_win"] == 0),
            "mean_vp_margin": _mean([row["vp_margin"] for row in seat_rows]),
        }
    mean_score = _mean([row["actor_win"] for row in completed])
    beats = interval["low"] is not None and interval["low"] > 0 and interval["n"] >= MIN_PAIRS_TO_ADOPT
    return {
        "opponent": "baseline_heuristic_v1",
        "checkpoint": checkpoint,
        "seeds": list(seed_list),
        "games": len(rows),
        "completed": len(completed),
        "incomplete": len(rows) - len(completed),
        "cutoffs_by_reason": reasons,
        "failures": sum(count for reason, count in reasons.items() if reason not in ("max_turns_reached", "max_actions_reached")),
        "learner_wins": sum(1 for row in completed if row["actor_win"] == 1),
        "draws": sum(1 for row in completed if row["actor_win"] == 0.5),
        "learner_losses": sum(1 for row in completed if row["actor_win"] == 0),
        "mean_actor_win_among_completed": mean_score,
        "mean_vp_margin_among_completed": _mean([row["vp_margin"] for row in completed]),
        "mean_vp_among_completed": _mean([row["actual_vp"] for row in completed if row["actual_vp"] is not None]),
        "pairs_completed": len(pair_values),
        "pair_score_minus_even": interval,
        "by_seat": by_seat,
        "beats_baseline": beats,
        "demonstrated_improvement": beats,
        "rows": rows,
        "elapsed_seconds": elapsed,
        "limits": {"victory_points_to_win": victory_points, "max_turns": max_turns, "max_actions": max_actions},
        "note": "Completed games are the only win denominator. A cutoff is not a loss.",
    }


def _mean(values: list) -> float | None:
    numbers = [float(value) for value in values if value is not None]
    if not numbers:
        return None
    return sum(numbers) / len(numbers)
