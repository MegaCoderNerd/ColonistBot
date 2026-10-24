"""Matched play of the frozen summary v4 policy against the baseline heuristic.

The checkpoint is loaded and not updated. Cutoffs are not wins or losses.
A completed pair is the mean of the two seat scores. Fewer than
MIN_COMPLETED_PAIRS finished pairs is an inconclusive result. That count was
chosen before this match was scored.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path

import torch

from .algorithm import bootstrap_mean, pair_scores
from .coverage import PHASE6_EPOCHS, _train_summary, with_teacher_labels
from .model import PolicyValueNet
from .rules import GRAPH_FINAL_SEEDS, GRAPH_TRAIN_SEEDS, GRAPH_VAL_SEEDS, INSPECTED_FIDELITY_SEEDS
from .schema import load_jsonl
from .tracked import FEATURE_VERSION_V4, GLOBAL_DIM_V4, encode_observation_v4

MATCH_SEED_COUNT = 200
MATCH_SEEDS = tuple(f"ml-v4-match-{index}" for index in range(MATCH_SEED_COUNT))
MIN_COMPLETED_PAIRS = 30
MATCH_LIMITS = {"victoryPointsToWin": 10, "maxTurns": 70, "maxActions": 450}
BUILD_TYPES = ("buildRoad", "buildSettlement", "buildCity", "bankTrade", "buyDevCard")
SAMPLE_SEEDS = {"ml-v4-match-0", "ml-v4-match-1"}


def assert_match_seeds(seeds: tuple[str, ...] | list[str]) -> None:
    banned = set(INSPECTED_FIDELITY_SEEDS) | set(GRAPH_FINAL_SEEDS) | set(GRAPH_TRAIN_SEEDS) | set(GRAPH_VAL_SEEDS)
    banned_prefixes = (
        "ml-phase6-train-",
        "ml-phase6-val-",
        "ml-phase6-final-",
        "ml-fidelity-",
        "ml-graph-",
        "ml-rl-",
        "ml-holdout-",
    )
    for seed in seeds:
        if not seed.startswith("ml-v4-match-"):
            raise RuntimeError(f"seed {seed} is outside the match namespace")
        if seed in banned or any(seed.startswith(prefix) for prefix in banned_prefixes):
            raise RuntimeError(f"seed {seed} reuses an earlier split")


def _weight_hash(model: torch.nn.Module) -> str:
    digest = hashlib.sha256()
    for parameter in model.parameters():
        digest.update(parameter.detach().cpu().contiguous().numpy().tobytes())
    return digest.hexdigest()


def freeze_v4_checkpoint(data_path: str, out_path: str, device: torch.device) -> dict:
    """Write the phase-6 summary procedure to disk.

    Phase 6 trained this model in memory and did not save it. The initialization
    is the first draw after torch.manual_seed(7), and the update reseeds to 7.
    That is the same sequence the phase-6 summary training used. This function
    does not read match results.
    """
    from .checkpoint import save_checkpoint

    examples, _dropped = load_jsonl(data_path)
    labeled = with_teacher_labels(examples)
    torch.manual_seed(7)
    model = PolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V4).to(device)
    _train_summary(model, labeled, device, PHASE6_EPOCHS)
    model.eval()
    manifest = {
        "feature_version": FEATURE_VERSION_V4,
        "observation_version": "colonist_observation_v2",
        "epochs": PHASE6_EPOCHS,
        "torch_seed": 7,
        "label_policy": "baseline_heuristic_v1",
        "rule_profile": "colonist_benchmark_1v1_v1",
        "train_rows": len(labeled),
        "weight_sha256": _weight_hash(model),
        "selection": "phase 6 validation kept the summary model",
        "frozen": True,
    }
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    save_checkpoint(out_path, model, optimizer, PHASE6_EPOCHS, 7, manifest)
    return manifest


def _action_type(action_id: str | None) -> str:
    if not action_id:
        return ""
    return action_id.split(":", 1)[0]


def play_v4_game(bridge, model: PolicyValueNet, device: torch.device, seed: str, learner: str, checkpoint: str) -> dict:
    """Greedy legal-list selection. The checkpoint is not updated."""
    if getattr(model, "feature_version", "") != FEATURE_VERSION_V4:
        raise RuntimeError("refusing to play a checkpoint that is not colonist_features_v4")
    model.eval()
    reply = bridge.request(
        {
            "cmd": "start",
            "seed": seed,
            "learner": learner,
            "opponent": "baseline_heuristic_v1",
            "teacher": "baseline_heuristic_v1",
            "victoryPointsToWin": MATCH_LIMITS["victoryPointsToWin"],
            "maxTurns": MATCH_LIMITS["maxTurns"],
            "maxActions": MATCH_LIMITS["maxActions"],
            "checkpoint": checkpoint,
            "detail": "summary",
        }
    )
    decisions = []
    illegal = 0
    while reply.get("type") == "decision":
        observation = reply["observation"]
        if observation.get("schema_version") != "colonist_observation_v2":
            raise RuntimeError("observation schema is not colonist_observation_v2")
        for opponent in observation.get("opponents") or []:
            if "hand" in opponent or "dev_cards" in opponent:
                raise RuntimeError("opponent hidden cards reached the policy")
        with torch.inference_mode():
            global_x, candidates, ids = encode_observation_v4(observation, device)
            if global_x.numel() != GLOBAL_DIM_V4:
                raise RuntimeError("feature width does not match colonist_features_v4")
            mask = torch.ones(1, candidates.size(0), dtype=torch.bool, device=device)
            logits, _value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
            action_index = int(torch.argmax(logits, dim=-1).item())
        if action_index < 0 or action_index >= len(ids):
            illegal += 1
            return {"ok": False, "illegal": illegal, "message": "policy index escaped the legal list", "decisions": decisions}
        action_id = ids[action_index]
        legal_ids = [str(candidate["action_id"]) for candidate in observation["candidates"]]
        if action_id not in legal_ids:
            illegal += 1
            return {"ok": False, "illegal": illegal, "message": "policy emitted an unlisted action", "decisions": decisions}
        decisions.append(
            {
                "phase": observation.get("phase"),
                "chosen": action_id,
                "teacher": reply.get("teacher_action_id"),
                "legal_types": sorted({str(candidate["type"]) for candidate in observation["candidates"]}),
                "public_vp": (observation.get("actor") or {}).get("public_vp"),
                "hand_size": sum(int(value) for value in ((observation.get("actor") or {}).get("hand") or {}).values()),
            }
        )
        reply = bridge.request({"cmd": "act", "action_id": action_id})
        if reply.get("type") == "error":
            illegal += 1
            return {"ok": False, "illegal": illegal, "message": reply.get("message", "bridge error"), "decisions": decisions}
    if reply.get("type") != "terminal":
        return {"ok": False, "illegal": illegal, "message": reply.get("message", "bridge closed"), "decisions": decisions}
    return {"ok": True, "illegal": illegal, "terminal": reply, "decisions": decisions}


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _progress_mean(rows: list[dict], seat_key: str, field: str) -> float | None:
    values = []
    for row in rows:
        progress = ((row.get("scores") or {}).get(seat_key) or {}).get(field)
        if isinstance(progress, bool):
            values.append(1.0 if progress else 0.0)
        elif isinstance(progress, (int, float)):
            values.append(float(progress))
    return _mean(values)


def summarize_decisions(decisions: list[dict]) -> dict:
    counts: Counter = Counter()
    teacher_exact = Counter()
    teacher_n = Counter()
    end_turn_while: Counter = Counter()
    for decision in decisions:
        chosen = _action_type(decision["chosen"])
        teacher = _action_type(decision.get("teacher"))
        counts[chosen] += 1
        if teacher:
            teacher_n[teacher] += 1
            if decision["chosen"] == decision.get("teacher"):
                teacher_exact[teacher] += 1
        if chosen == "endTurn":
            for build in BUILD_TYPES:
                if build in decision["legal_types"]:
                    end_turn_while[build] += 1
    def rate(action_type: str) -> float | None:
        if teacher_n[action_type] == 0:
            return None
        return teacher_exact[action_type] / teacher_n[action_type]

    return {
        "learner_decisions": sum(counts.values()),
        "chosen_types": dict(counts),
        "teacher_exact_rate": {action_type: rate(action_type) for action_type in ("placeSetupSettlement", "placeSetupRoad", "buildRoad", "bankTrade", "moveRobber", "discard", "buyDevCard", "buildSettlement", "buildCity")},
        "teacher_counts": {action_type: teacher_n[action_type] for action_type in teacher_n},
        "end_turn_while_legal": dict(end_turn_while),
    }


def run_match(bridge, model: PolicyValueNet, device: torch.device, checkpoint: str, seeds: tuple[str, ...]) -> dict:
    assert_match_seeds(seeds)
    rows = []
    failures = []
    illegal = 0
    sample_games = []
    all_decisions_for_summary = []
    import time

    started = time.perf_counter()
    for seed in seeds:
        for learner in ("c1", "c2"):
            played = play_v4_game(bridge, model, device, seed, learner, checkpoint)
            illegal += int(played.get("illegal") or 0)
            if not played.get("ok"):
                failures.append({"seed": seed, "learner": learner, "message": played.get("message")})
                rows.append(
                    {
                        "seed": seed,
                        "learner": learner,
                        "completion_status": "incomplete",
                        "cutoff_reason": "simulator_failure",
                        "actor_win": None,
                        "scores": None,
                        "turns": None,
                        "actions": None,
                    }
                )
                continue
            terminal = played["terminal"]
            score = terminal["actor_win"][learner] if terminal["completion_status"] == "completed" else None
            row = {
                "seed": seed,
                "learner": learner,
                "completion_status": terminal["completion_status"],
                "cutoff_reason": terminal["cutoff_reason"],
                "actor_win": score,
                "scores": terminal.get("scores"),
                "turns": terminal.get("turns"),
                "actions": terminal.get("actions"),
                "winner_id": terminal.get("winner_id"),
            }
            rows.append(row)
            all_decisions_for_summary.extend(played["decisions"])
            if seed in SAMPLE_SEEDS:
                sample_games.append(
                    {
                        "seed": seed,
                        "learner": learner,
                        "completion_status": terminal["completion_status"],
                        "cutoff_reason": terminal["cutoff_reason"],
                        "actor_win": score,
                        "scores": terminal.get("scores"),
                        "turns": terminal.get("turns"),
                        "decisions": played["decisions"][:40],
                        "decision_count": len(played["decisions"]),
                    }
                )
    elapsed = time.perf_counter() - started
    completed = [row for row in rows if row["actor_win"] is not None]
    cutoffs = [row for row in rows if row["completion_status"] != "completed" and row["cutoff_reason"] != "simulator_failure"]
    reasons: Counter = Counter(row["cutoff_reason"] or "unknown" for row in rows if row["completion_status"] != "completed")
    pairs = pair_scores(rows)
    pair_values = [pairs[seed] for seed in seeds if pairs.get(seed) is not None]
    interval = bootstrap_mean([value - 0.5 for value in pair_values], seed="ml-v4-match-bootstrap-v1")
    by_seat = {}
    for seat in ("c1", "c2"):
        seat_rows = [row for row in completed if row["learner"] == seat]
        by_seat[seat] = {
            "launched": sum(1 for row in rows if row["learner"] == seat),
            "completed": len(seat_rows),
            "wins": sum(1 for row in seat_rows if row["actor_win"] == 1),
            "draws": sum(1 for row in seat_rows if row["actor_win"] == 0.5),
            "losses": sum(1 for row in seat_rows if row["actor_win"] == 0),
            "mean_vp": _progress_mean(seat_rows, seat, "actual_vp"),
            "mean_vp_margin": _mean(
                [
                    float(row["scores"][seat]["actual_vp"]) - float(row["scores"]["c2" if seat == "c1" else "c1"]["actual_vp"])
                    for row in seat_rows
                    if row.get("scores")
                ]
            ),
            "mean_turns": _mean([float(row["turns"]) for row in seat_rows if row.get("turns") is not None]),
            "mean_actions": _mean([float(row["actions"]) for row in seat_rows if row.get("actions") is not None]),
            "mean_settlements": _progress_mean(seat_rows, seat, "settlements_placed"),
            "mean_cities": _progress_mean(seat_rows, seat, "cities_placed"),
            "mean_roads": _progress_mean(seat_rows, seat, "roads_placed"),
            "mean_devs_bought": _progress_mean(seat_rows, seat, "devs_bought"),
            "longest_road_rate": _progress_mean(seat_rows, seat, "has_longest_road"),
            "largest_army_rate": _progress_mean(seat_rows, seat, "has_largest_army"),
            "mean_hand_size": _progress_mean(seat_rows, seat, "hand_size"),
            "opponent_mean_vp": _progress_mean(seat_rows, "c2" if seat == "c1" else "c1", "actual_vp"),
            "opponent_mean_cities": _progress_mean(seat_rows, "c2" if seat == "c1" else "c1", "cities_placed"),
            "opponent_mean_settlements": _progress_mean(seat_rows, "c2" if seat == "c1" else "c1", "settlements_placed"),
        }
    conclusive = len(pair_values) >= MIN_COMPLETED_PAIRS
    point = interval["mean"]
    above_even = bool(conclusive and interval["low"] is not None and interval["low"] > 0)
    below_even = bool(conclusive and interval["high"] is not None and interval["high"] < 0)
    if not conclusive:
        signal = "inconclusive"
    elif above_even:
        signal = "positive"
    elif below_even:
        signal = "negative"
    else:
        signal = "inconclusive"
    return {
        "checkpoint": checkpoint,
        "feature_version": FEATURE_VERSION_V4,
        "observation_version": "colonist_observation_v2",
        "opponent": "baseline_heuristic_v1",
        "selection": "greedy argmax over the legal candidate list",
        "profile": "colonist_benchmark_1v1_v1",
        "limits": {"victory_points_to_win": 10, "max_turns": 70, "max_actions": 450},
        "seeds": list(seeds),
        "games_launched": len(rows),
        "completed_games": len(completed),
        "cutoff_games": len(cutoffs),
        "cutoffs_by_reason": dict(reasons),
        "simulator_failures": len(failures),
        "failure_examples": failures[:8],
        "illegal_actions": illegal,
        "learner_wins": sum(1 for row in completed if row["actor_win"] == 1),
        "draws": sum(1 for row in completed if row["actor_win"] == 0.5),
        "learner_losses": sum(1 for row in completed if row["actor_win"] == 0),
        "mean_vp_among_completed": _mean(
            [float(row["scores"][row["learner"]]["actual_vp"]) for row in completed if row.get("scores")]
        ),
        "mean_vp_among_cutoffs": _mean(
            [float(row["scores"][row["learner"]]["actual_vp"]) for row in cutoffs if row.get("scores")]
        ),
        "pairs_completed": len(pair_values),
        "pairs_omitted": len(seeds) - len(pair_values),
        "pair_score": None if not pair_values else sum(pair_values) / len(pair_values),
        "pair_score_minus_even": interval,
        "min_completed_pairs": MIN_COMPLETED_PAIRS,
        "conclusive": conclusive,
        "signal": signal,
        "above_even": above_even,
        "by_seat": by_seat,
        "decision_diagnostics": summarize_decisions(all_decisions_for_summary),
        "sample_games": sample_games,
        "elapsed_seconds": elapsed,
        "stochastic_note": (
            "Both seat assignments use the same seed, so the generated board, development deck, "
            "dice stream, and theft stream start from the same state. The heuristic's own random "
            "stream is consumed on the turns it plays, so a seat swap does not replay the same "
            "heuristic tie breaks. The network always takes the highest legal score."
        ),
        "interval_note": (
            "The bootstrap interval is the completed-pair score minus 0.5. It includes only seeds "
            "where both seat assignments finished. It does not represent seeds that were cut off."
        ),
        "ppo_authorized": False,
    }
