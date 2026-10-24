"""Matched play of frozen v6 and v4 against the baseline heuristic.

Checkpoints are loaded and not updated. Cutoffs are not wins or losses.
The interpretation thresholds were fixed before this batch was scored.
"""

from __future__ import annotations

import time
from collections import Counter

import torch

from .algorithm import bootstrap_mean, pair_scores
from .features import CANDIDATE_DIM
from .match import MATCH_LIMITS, MIN_COMPLETED_PAIRS, _mean, _progress_mean, _weight_hash
from .model import PolicyValueNet
from .phase9 import CANDIDATE_DIM_V6, FINAL_SEEDS
from .tracked import FEATURE_VERSION_V4, FEATURE_VERSION_V6, GLOBAL_DIM_V4

STRENGTH_SEED_COUNT = 200
STRENGTH_SEEDS = tuple(f"ml-v6-strength-{index}" for index in range(STRENGTH_SEED_COUNT))
SMOKE_SEEDS = STRENGTH_SEEDS[:2]
V4_WEIGHT_SHA256 = "ed099144448aee98ba9d43b95fee2f6875aa8f4cb2ffc567b7d4d7c6abead710"
V6_WEIGHT_SHA256 = "371636b728ae6e9f40e840fcbc04bd2d2db35079b0f53bda4afab164dd078b9d"
CUTOFF_RATE_MARGIN = 0.05
VP_DROP_MAX = 1.0
RESOURCES = ("lumber", "brick", "wool", "grain", "ore")
BUILD_COSTS = {
    "road": {"lumber": 1, "brick": 1, "wool": 0, "grain": 0, "ore": 0},
    "settlement": {"lumber": 1, "brick": 1, "wool": 1, "grain": 1, "ore": 0},
    "city": {"lumber": 0, "brick": 0, "wool": 0, "grain": 2, "ore": 3},
    "dev": {"lumber": 0, "brick": 0, "wool": 1, "grain": 1, "ore": 1},
}
SAMPLE_SEEDS = set(SMOKE_SEEDS)
TRACE_LIMIT = 40


def assert_strength_seeds(seeds: tuple[str, ...] | list[str]) -> None:
    banned_prefixes = (
        "ml-v4-match-",
        "ml-v6-final-",
        "ml-phase6-",
        "ml-fidelity-",
        "ml-graph-",
        "ml-v4-agg-",
        "ml-rl-",
        "ml-holdout-",
    )
    banned = set(FINAL_SEEDS)
    for seed in seeds:
        if not seed.startswith("ml-v6-strength-"):
            raise RuntimeError(f"seed {seed} is outside the strength namespace")
        if seed in banned or any(seed.startswith(prefix) for prefix in banned_prefixes):
            raise RuntimeError(f"seed {seed} reuses an earlier split")


def verify_checkpoint(model: PolicyValueNet, payload: dict, expected_version: str, expected_hash: str) -> str:
    version = str(payload.get("feature_version") or "")
    observation = str(payload.get("observation_version") or "")
    if version != expected_version:
        raise RuntimeError(f"checkpoint schema is {version}, expected {expected_version}")
    if observation != "colonist_observation_v2":
        raise RuntimeError("checkpoint observation schema is not colonist_observation_v2")
    digest = _weight_hash(model)
    if digest != expected_hash:
        raise RuntimeError(f"checkpoint hash {digest} does not match {expected_hash}")
    if version == FEATURE_VERSION_V4 and int(getattr(model, "candidate_dim", CANDIDATE_DIM)) != CANDIDATE_DIM:
        raise RuntimeError("v4 candidate width is not the frozen width")
    if version == FEATURE_VERSION_V6 and int(model.candidate_dim) != CANDIDATE_DIM_V6:
        raise RuntimeError("v6 candidate width is not the frozen width")
    model.eval()
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    return digest


def _action_type(action_id: str | None) -> str:
    if not action_id:
        return ""
    return action_id.split(":", 1)[0]


def _affordable(hand: dict, cost: dict) -> bool:
    return all(int(hand.get(resource) or 0) >= int(cost[resource]) for resource in RESOURCES)


def trade_newly_affordable(hand: dict, features: dict) -> list[str]:
    after = {}
    for resource in RESOURCES:
        after[resource] = int(hand.get(resource) or 0) - int(features.get(f"give_{resource}") or 0) + int(features.get(f"receive_{resource}") or 0)
    opened = []
    for name, cost in BUILD_COSTS.items():
        if _affordable(after, cost) and not _affordable(hand, cost):
            opened.append(name)
    return opened


def _candidate_map(observation: dict) -> dict[str, dict]:
    return {str(candidate["action_id"]): candidate for candidate in observation.get("candidates") or []}


def _road_bits(candidate: dict | None) -> dict:
    features = (candidate or {}).get("public_features") or {}
    return {
        "reach_after": features.get("reach_after"),
        "opens_settlement": int(features.get("opens_settlement") or 0),
        "newly_opened": int(features.get("newly_opened") or 0),
        "connects_network": int(features.get("connects_network") or 0),
    }


def select_legal(model: PolicyValueNet, observation: dict, device: torch.device, version: str) -> str:
    if model.training:
        raise RuntimeError("refusing to play a model that is in training mode")
    if observation.get("schema_version") != "colonist_observation_v2":
        raise RuntimeError("observation schema is not colonist_observation_v2")
    for opponent in observation.get("opponents") or []:
        if "hand" in opponent or "dev_cards" in opponent:
            raise RuntimeError("opponent hidden cards reached the policy")
    if version == FEATURE_VERSION_V4:
        from .tracked import encode_observation_v4

        global_x, candidates, ids = encode_observation_v4(observation, device)
        if global_x.numel() != GLOBAL_DIM_V4 or candidates.size(1) != CANDIDATE_DIM:
            raise RuntimeError("feature width does not match colonist_features_v4")
    elif version == FEATURE_VERSION_V6:
        from .roads import encode_observation_v6

        global_x, candidates, ids = encode_observation_v6(observation, device)
        if global_x.numel() != GLOBAL_DIM_V4 or candidates.size(1) != CANDIDATE_DIM_V6:
            raise RuntimeError("feature width does not match colonist_features_v6")
    elif version == "colonist_features_v7":
        from .longest import LONGEST_ROAD_DIM, encode_observation_v7

        global_x, candidates, ids = encode_observation_v7(observation, device)
        if global_x.numel() != GLOBAL_DIM_V4 + 2 or candidates.size(1) != CANDIDATE_DIM_V6 + LONGEST_ROAD_DIM:
            raise RuntimeError("feature width does not match colonist_features_v7")
    else:
        raise RuntimeError(f"unsupported feature schema {version}")
    with torch.inference_mode():
        mask = torch.ones(1, candidates.size(0), dtype=torch.bool, device=device)
        logits, _value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
        action_index = int(torch.argmax(logits, dim=-1).item())
    if action_index < 0 or action_index >= len(ids):
        raise RuntimeError("policy index escaped the legal list")
    action_id = ids[action_index]
    legal_ids = [str(candidate["action_id"]) for candidate in observation["candidates"]]
    if action_id not in legal_ids or set(ids) != set(legal_ids):
        raise RuntimeError("policy emitted an unlisted action")
    return action_id


def _blank_diag() -> dict:
    return {
        "learner_decisions": 0,
        "chosen_types": Counter(),
        "teacher_exact": Counter(),
        "teacher_n": Counter(),
        "end_turn_while": Counter(),
        "end_turn_while_opening_road": 0,
        "paid_roads": 0,
        "paid_roads_that_open": 0,
        "paid_road_newly_opened": 0,
        "skipped_teacher_roads": 0,
        "skipped_teacher_roads_that_open": 0,
        "trades": 0,
        "trade_newly_affordable": Counter(),
        "settlements": 0,
        "cities": 0,
        "devs": 0,
        "hand_at_end_turn": [],
        "vp_trace_games": 0,
    }


def _note_decision(diag: dict, observation: dict, chosen: str, teacher: str | None) -> dict:
    candidates = _candidate_map(observation)
    chosen_type = _action_type(chosen)
    teacher_type = _action_type(teacher)
    legal_types = {str(candidate["type"]) for candidate in observation["candidates"]}
    hand = (observation.get("actor") or {}).get("hand") or {}
    diag["learner_decisions"] += 1
    diag["chosen_types"][chosen_type] += 1
    if teacher:
        diag["teacher_n"][teacher_type] += 1
        if chosen == teacher:
            diag["teacher_exact"][teacher_type] += 1
    opening_roads = [
        candidate
        for candidate in observation["candidates"]
        if candidate.get("type") == "buildRoad" and int((candidate.get("public_features") or {}).get("opens_settlement") or 0) == 1
    ]
    if chosen_type == "endTurn":
        for build in ("buildRoad", "buildSettlement", "buildCity", "bankTrade", "buyDevCard"):
            if build in legal_types:
                diag["end_turn_while"][build] += 1
        if opening_roads:
            diag["end_turn_while_opening_road"] += 1
        diag["hand_at_end_turn"].append(sum(int(value) for value in hand.values()))
    if chosen_type == "buildRoad":
        bits = _road_bits(candidates.get(chosen))
        diag["paid_roads"] += 1
        diag["paid_roads_that_open"] += bits["opens_settlement"]
        diag["paid_road_newly_opened"] += bits["newly_opened"]
    if teacher_type == "buildRoad" and chosen != teacher:
        bits = _road_bits(candidates.get(str(teacher)))
        diag["skipped_teacher_roads"] += 1
        diag["skipped_teacher_roads_that_open"] += bits["opens_settlement"]
    if chosen_type == "bankTrade":
        diag["trades"] += 1
        for name in trade_newly_affordable(hand, (candidates.get(chosen) or {}).get("public_features") or {}):
            diag["trade_newly_affordable"][name] += 1
    if chosen_type == "buildSettlement":
        diag["settlements"] += 1
    if chosen_type == "buildCity":
        diag["cities"] += 1
    if chosen_type == "buyDevCard":
        diag["devs"] += 1
    public_vp = (observation.get("actor") or {}).get("public_vp")
    return {
        "phase": observation.get("phase"),
        "chosen": chosen,
        "teacher": teacher,
        "public_vp": public_vp,
        "hand_size": sum(int(value) for value in hand.values()),
        "road": _road_bits(candidates.get(chosen)) if chosen_type == "buildRoad" else None,
        "teacher_road": _road_bits(candidates.get(str(teacher))) if teacher_type == "buildRoad" else None,
        "legal_types": sorted(legal_types),
    }


def _close_diag(diag: dict) -> dict:
    def rate(action_type: str) -> float | None:
        if diag["teacher_n"][action_type] == 0:
            return None
        return diag["teacher_exact"][action_type] / diag["teacher_n"][action_type]

    return {
        "learner_decisions": diag["learner_decisions"],
        "chosen_types": dict(diag["chosen_types"]),
        "teacher_counts": dict(diag["teacher_n"]),
        "teacher_exact_rate": {
            action_type: rate(action_type)
            for action_type in (
                "placeSetupSettlement",
                "placeSetupRoad",
                "buildRoad",
                "bankTrade",
                "moveRobber",
                "discard",
                "buyDevCard",
                "buildSettlement",
                "buildCity",
            )
        },
        "end_turn_while_legal": dict(diag["end_turn_while"]),
        "end_turn_while_opening_road": diag["end_turn_while_opening_road"],
        "paid_roads": diag["paid_roads"],
        "paid_roads_that_open": diag["paid_roads_that_open"],
        "paid_road_newly_opened": diag["paid_road_newly_opened"],
        "skipped_teacher_roads": diag["skipped_teacher_roads"],
        "skipped_teacher_roads_that_open": diag["skipped_teacher_roads_that_open"],
        "trades": diag["trades"],
        "trade_newly_affordable": dict(diag["trade_newly_affordable"]),
        "settlements_chosen": diag["settlements"],
        "cities_chosen": diag["cities"],
        "devs_chosen": diag["devs"],
        "mean_hand_at_end_turn": _mean([float(value) for value in diag["hand_at_end_turn"]]),
    }


def play_frozen_game(bridge, model: PolicyValueNet, device: torch.device, seed: str, learner: str, checkpoint: str, version: str) -> dict:
    if getattr(model, "feature_version", "") != version:
        raise RuntimeError("model schema does not match the requested checkpoint")
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
    diag = _blank_diag()
    trace = []
    first_actions = []
    illegal = 0
    while reply.get("type") == "decision":
        observation = reply["observation"]
        try:
            action_id = select_legal(model, observation, device, version)
        except RuntimeError as error:
            illegal += 1
            return {"ok": False, "illegal": illegal, "message": str(error), "decisions": trace, "diag": diag, "first_actions": first_actions}
        if len(first_actions) < 8:
            first_actions.append(action_id)
        noted = _note_decision(diag, observation, action_id, reply.get("teacher_action_id"))
        if seed in SAMPLE_SEEDS and len(trace) < TRACE_LIMIT:
            trace.append(noted)
        reply = bridge.request({"cmd": "act", "action_id": action_id})
        if reply.get("type") == "error":
            illegal += 1
            return {"ok": False, "illegal": illegal, "message": reply.get("message", "bridge error"), "decisions": trace, "diag": diag, "first_actions": first_actions}
    if reply.get("type") != "terminal":
        return {"ok": False, "illegal": illegal, "message": reply.get("message", "bridge closed"), "decisions": trace, "diag": diag, "first_actions": first_actions}
    if reply.get("model_checkpoint") != checkpoint:
        raise RuntimeError("terminal result names a different checkpoint")
    if reply.get("opponent_policy") != "baseline_heuristic_v1":
        raise RuntimeError("terminal result names a different opponent")
    return {
        "ok": True,
        "illegal": illegal,
        "terminal": reply,
        "decisions": trace,
        "diag": diag,
        "first_actions": first_actions,
        "decision_count": diag["learner_decisions"],
    }


def _seat_block(rows: list[dict], completed: list[dict], seat: str) -> dict:
    seat_rows = [row for row in completed if row["learner"] == seat]
    other = "c2" if seat == "c1" else "c1"
    return {
        "launched": sum(1 for row in rows if row["learner"] == seat),
        "completed": len(seat_rows),
        "wins": sum(1 for row in seat_rows if row["actor_win"] == 1),
        "draws": sum(1 for row in seat_rows if row["actor_win"] == 0.5),
        "losses": sum(1 for row in seat_rows if row["actor_win"] == 0),
        "mean_vp": _progress_mean(seat_rows, seat, "actual_vp"),
        "mean_visible_vp": _progress_mean(seat_rows, seat, "visible_vp"),
        "mean_vp_margin": _mean(
            [
                float(row["scores"][seat]["actual_vp"]) - float(row["scores"][other]["actual_vp"])
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
        "mean_knights": _progress_mean(seat_rows, seat, "knights_played"),
        "longest_road_rate": _progress_mean(seat_rows, seat, "has_longest_road"),
        "largest_army_rate": _progress_mean(seat_rows, seat, "has_largest_army"),
        "mean_road_length": _progress_mean(seat_rows, seat, "road_length"),
        "mean_hand_size": _progress_mean(seat_rows, seat, "hand_size"),
        "opponent_mean_vp": _progress_mean(seat_rows, other, "actual_vp"),
    }


def _cutoff_block(cutoffs: list[dict], seat: str) -> dict:
    seat_rows = [row for row in cutoffs if row["learner"] == seat]
    return {
        "n": len(seat_rows),
        "mean_vp": _progress_mean(seat_rows, seat, "actual_vp"),
        "mean_settlements": _progress_mean(seat_rows, seat, "settlements_placed"),
        "mean_cities": _progress_mean(seat_rows, seat, "cities_placed"),
        "mean_roads": _progress_mean(seat_rows, seat, "roads_placed"),
        "mean_devs_bought": _progress_mean(seat_rows, seat, "devs_bought"),
        "mean_hand_size": _progress_mean(seat_rows, seat, "hand_size"),
        "mean_turns": _mean([float(row["turns"]) for row in seat_rows if row.get("turns") is not None]),
        "opponent_mean_vp": _progress_mean(seat_rows, "c2" if seat == "c1" else "c1", "actual_vp"),
    }


def summarize_policy(rows: list[dict], seeds: tuple[str, ...], diag: dict, version: str, checkpoint: str, bootstrap_seed: str, elapsed: float, failures: list[dict], illegal: int, samples: list[dict]) -> dict:
    completed = [row for row in rows if row["actor_win"] is not None]
    cutoffs = [row for row in rows if row["completion_status"] != "completed" and row["cutoff_reason"] != "simulator_failure"]
    reasons = Counter(row["cutoff_reason"] or "unknown" for row in rows if row["completion_status"] != "completed")
    pairs = pair_scores(rows)
    pair_values = [pairs[seed] for seed in seeds if pairs.get(seed) is not None]
    interval = bootstrap_mean([value - 0.5 for value in pair_values], seed=bootstrap_seed)
    return {
        "checkpoint": checkpoint,
        "feature_version": version,
        "observation_version": "colonist_observation_v2",
        "opponent": "baseline_heuristic_v1",
        "selection": "greedy argmax over the legal candidate list",
        "profile": "colonist_benchmark_1v1_v1",
        "limits": {"victory_points_to_win": 10, "max_turns": 70, "max_actions": 450},
        "games_launched": len(rows),
        "completed_games": len(completed),
        "cutoff_games": len(cutoffs),
        "cutoff_rate": None if not rows else len(cutoffs) / len(rows),
        "cutoffs_by_reason": dict(reasons),
        "simulator_failures": len(failures),
        "failure_examples": failures[:8],
        "illegal_actions": illegal,
        "learner_wins": sum(1 for row in completed if row["actor_win"] == 1),
        "draws": sum(1 for row in completed if row["actor_win"] == 0.5),
        "learner_losses": sum(1 for row in completed if row["actor_win"] == 0),
        "mean_vp_among_completed": _mean([float(row["scores"][row["learner"]]["actual_vp"]) for row in completed if row.get("scores")]),
        "mean_vp_among_cutoffs": _mean([float(row["scores"][row["learner"]]["actual_vp"]) for row in cutoffs if row.get("scores")]),
        "pairs_completed": len(pair_values),
        "pairs_omitted": len(seeds) - len(pair_values),
        "pair_score": None if not pair_values else sum(pair_values) / len(pair_values),
        "pair_score_minus_even": interval,
        "min_completed_pairs": MIN_COMPLETED_PAIRS,
        "by_seat": {seat: _seat_block(rows, completed, seat) for seat in ("c1", "c2")},
        "cutoffs_by_seat": {seat: _cutoff_block(cutoffs, seat) for seat in ("c1", "c2")},
        "decision_diagnostics": _close_diag(diag),
        "sample_games": samples,
        "elapsed_seconds": elapsed,
        "pair_values_by_seed": {seed: pairs.get(seed) for seed in seeds},
    }


def matched_difference(v6: dict, v4: dict, seeds: tuple[str, ...]) -> dict:
    left = v6["pair_values_by_seed"]
    right = v4["pair_values_by_seed"]
    shared = [seed for seed in seeds if left.get(seed) is not None and right.get(seed) is not None]
    diffs = [float(left[seed]) - float(right[seed]) for seed in shared]
    return {
        "seeds": len(shared),
        "mean_v6_minus_v4": None if not diffs else sum(diffs) / len(diffs),
        "interval": bootstrap_mean(diffs, seed="ml-v6-strength-diff-bootstrap-v1"),
        "note": "This difference uses seeds where both policies completed both seats. It is not a score against the heuristic.",
    }


def interpret(v6: dict, v4: dict) -> dict:
    """Apply the phase-10 rule. Thresholds are module constants, not fit to this batch."""
    if int(v6["pairs_completed"]) < MIN_COMPLETED_PAIRS:
        return {"decision": "inconclusive", "reasons": [f"completed pairs {v6['pairs_completed']}"]}
    interval = v6["pair_score_minus_even"]
    low = interval.get("low")
    high = interval.get("high")
    above = low is not None and float(low) > 0
    below = high is not None and float(high) < 0
    cutoff_v6 = float(v6["cutoff_games"]) / float(v6["games_launched"])
    cutoff_v4 = float(v4["cutoff_games"]) / float(v4["games_launched"])
    cutoff_worse = cutoff_v6 > cutoff_v4 + CUTOFF_RATE_MARGIN
    vp_v6 = v6.get("mean_vp_among_completed")
    vp_v4 = v4.get("mean_vp_among_completed")
    vp_regression = vp_v6 is not None and vp_v4 is not None and float(vp_v6) < float(vp_v4) - VP_DROP_MAX
    if below:
        return {"decision": "negative", "reasons": ["paired interval is entirely below even"]}
    if cutoff_worse:
        return {"decision": "negative", "reasons": [f"cutoff rate {cutoff_v6:.3f} exceeds v4 {cutoff_v4:.3f} by more than {CUTOFF_RATE_MARGIN}"]}
    if above and not vp_regression:
        return {"decision": "positive", "reasons": []}
    if above and vp_regression:
        return {"decision": "inconclusive", "reasons": ["interval is above even and completed VP regressed by more than 1"]}
    return {"decision": "inconclusive", "reasons": ["paired interval includes an even result"]}


def _run_once(bridge, models: dict, device: torch.device, seeds: tuple[str, ...]) -> dict:
    reports = {}
    for name, spec in models.items():
        rows = []
        failures = []
        illegal = 0
        samples = []
        diag = _blank_diag()
        started = time.perf_counter()
        for seed in seeds:
            for learner in ("c1", "c2"):
                played = play_frozen_game(bridge, spec["model"], device, seed, learner, spec["checkpoint"], spec["version"])
                illegal += int(played.get("illegal") or 0)
                if not played.get("ok"):
                    failures.append({"seed": seed, "learner": learner, "message": played.get("message")})
                    rows.append(
                        {
                            "seed": seed,
                            "learner": learner,
                            "policy": name,
                            "checkpoint": spec["checkpoint"],
                            "completion_status": "incomplete",
                            "cutoff_reason": "simulator_failure",
                            "actor_win": None,
                            "scores": None,
                            "turns": None,
                            "actions": None,
                            "winner_id": None,
                            "first_actions": played.get("first_actions") or [],
                            "decision_count": played.get("decision_count") or 0,
                        }
                    )
                    continue
                terminal = played["terminal"]
                score = terminal["actor_win"][learner] if terminal["completion_status"] == "completed" else None
                row = {
                    "seed": seed,
                    "learner": learner,
                    "policy": name,
                    "checkpoint": spec["checkpoint"],
                    "feature_version": spec["version"],
                    "completion_status": terminal["completion_status"],
                    "cutoff_reason": terminal["cutoff_reason"],
                    "actor_win": score,
                    "scores": terminal.get("scores"),
                    "turns": terminal.get("turns"),
                    "actions": terminal.get("actions"),
                    "winner_id": terminal.get("winner_id"),
                    "first_actions": played["first_actions"],
                    "decision_count": played["decision_count"],
                }
                rows.append(row)
                for key, value in played["diag"].items():
                    if isinstance(value, Counter):
                        diag[key].update(value)
                    elif isinstance(value, list):
                        diag[key].extend(value)
                    else:
                        diag[key] += value
                if seed in SAMPLE_SEEDS:
                    samples.append(
                        {
                            "seed": seed,
                            "learner": learner,
                            "checkpoint": spec["checkpoint"],
                            "feature_version": spec["version"],
                            "completion_status": terminal["completion_status"],
                            "cutoff_reason": terminal["cutoff_reason"],
                            "actor_win": score,
                            "scores": terminal.get("scores"),
                            "turns": terminal.get("turns"),
                            "actions": terminal.get("actions"),
                            "decision_count": played["decision_count"],
                            "decisions": played["decisions"],
                        }
                    )
        elapsed = time.perf_counter() - started
        reports[name] = summarize_policy(
            rows,
            seeds,
            diag,
            spec["version"],
            spec["checkpoint"],
            "ml-v6-strength-bootstrap-v1" if name == "v6" else "ml-v6-strength-v4-bootstrap-v1",
            elapsed,
            failures,
            illegal,
            samples,
        )
        reports[name]["weight_sha256"] = spec["hash"]
    return reports


def fingerprint(report: dict) -> list[tuple]:
    rows = []
    for name in ("v6", "v4"):
        for game in report[name]["sample_games"]:
            rows.append(
                (
                    name,
                    game["seed"],
                    game["learner"],
                    game["completion_status"],
                    game["cutoff_reason"],
                    game["actor_win"],
                    game["turns"],
                    game["actions"],
                    game["decision_count"],
                    tuple(decision["chosen"] for decision in game["decisions"][:8]),
                )
            )
    return rows


def run_smoke(bridge, models: dict, device: torch.device) -> dict:
    assert_strength_seeds(SMOKE_SEEDS)
    first = _run_once(bridge, models, device, SMOKE_SEEDS)
    second = _run_once(bridge, models, device, SMOKE_SEEDS)
    same = fingerprint(first) == fingerprint(second)
    if not same:
        raise RuntimeError("smoke repetition did not reproduce the first run")
    for name in ("v6", "v4"):
        if first[name]["illegal_actions"] or second[name]["illegal_actions"]:
            raise RuntimeError("smoke produced an illegal action")
        if first[name]["simulator_failures"] or second[name]["simulator_failures"]:
            raise RuntimeError("smoke produced a simulator failure")
    return {"repeated": True, "seeds": list(SMOKE_SEEDS), "first": first}


def run_strength(bridge, models: dict, device: torch.device, seeds: tuple[str, ...]) -> dict:
    assert_strength_seeds(seeds)
    reports = _run_once(bridge, models, device, seeds)
    reports["matched_v6_minus_v4"] = matched_difference(reports["v6"], reports["v4"], seeds)
    reports["interpretation"] = interpret(reports["v6"], reports["v4"])
    reports["ppo_authorized"] = False
    reports["playing_strength_claim"] = reports["interpretation"]["decision"] == "positive"
    reports["professional_strength_claim"] = False
    reports["stochastic_note"] = (
        "The same seed rebuilds the board and development deck. Dice, theft, and heuristic tie breaks "
        "start from the same derived streams. Those streams are consumed as actions occur, so a seat swap "
        "and a different neural policy do not replay one trajectory. The network always takes the highest legal score."
    )
    reports["interval_note"] = (
        "Each bootstrap interval is conditional on seeds whose two seat assignments both finished. "
        "A cutoff drops the whole pair. The interval does not represent unfinished games."
    )
    return reports
