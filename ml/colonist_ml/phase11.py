"""Diagnosis of frozen v6 games. This does not train or score a new match.

The seeds are a slice of the Phase 10 batch. Replaying them explains those
games. It is not fresh evidence of playing strength.
"""

from __future__ import annotations

from collections import Counter

import torch

from .match import MATCH_LIMITS
from .phase10 import select_legal
from .roads import _distance_open, _parse_board
from .tracked import FEATURE_VERSION_V6

DIAGNOSIS_SEEDS = tuple(f"ml-v6-strength-{index}" for index in range(8))
RESOURCES = ("lumber", "brick", "wool", "grain", "ore")
SETTLEMENT_COST = {"lumber": 1, "brick": 1, "wool": 1, "grain": 1, "ore": 0}
CITY_COST = {"lumber": 0, "brick": 0, "wool": 0, "grain": 2, "ore": 3}


def _pair(left: str, right: str) -> str:
    return f"{left}|{right}" if left < right else f"{right}|{left}"


def longest_road_length(graph: dict[str, set[str]], blocked: set[str]) -> int:
    """Same walk as src/analyzer/engine/roads.ts longestRoad."""
    if not graph:
        return 0
    best = 0
    used: set[str] = set()

    def walk(node: str, depth: int) -> None:
        nonlocal best
        if depth > best:
            best = depth
        if depth > 0 and node in blocked:
            return
        for nxt in graph.get(node, ()):
            edge = _pair(node, nxt)
            if edge in used:
                continue
            used.add(edge)
            walk(nxt, depth + 1)
            used.remove(edge)

    for start in graph:
        walk(start, 0)
    return best


def road_length(observation: dict, player: str, extra_edge: str | None = None) -> int:
    board = observation.get("board") or {}
    if not board.get("edges"):
        raise ValueError("road length needs the public board")
    owned = {str(edge["id"]) for edge in (observation.get("placements") or {}).get("edges") or [] if edge.get("owner") == player}
    if extra_edge:
        owned.add(extra_edge)
    graph: dict[str, set[str]] = {}
    for edge in board["edges"]:
        if str(edge["id"]) not in owned:
            continue
        left, right = str(edge["corners"][0]), str(edge["corners"][1])
        graph.setdefault(left, set()).add(right)
        graph.setdefault(right, set()).add(left)
    blocked = {
        str(corner["id"])
        for corner in (observation.get("placements") or {}).get("corners") or []
        if corner.get("owner") not in (None, player)
    }
    return longest_road_length(graph, blocked)


def _pips(observation: dict, corner_index: int) -> int:
    hexes = {str(hex_item["id"]): hex_item for hex_item in observation["board"]["hexes"]}
    robber = observation.get("robber_hex_id")
    corner = observation["board"]["corners"][corner_index]
    total = 0
    for hex_id in corner.get("hex_ids") or []:
        if hex_id == robber:
            continue
        hex_item = hexes.get(str(hex_id)) or {}
        if hex_item.get("resource"):
            total += int(hex_item.get("pips") or 0)
    return total


def _can_pay(hand: dict, cost: dict) -> bool:
    return all(int(hand.get(resource) or 0) >= int(amount) for resource, amount in cost.items())


def _opened_spots(observation: dict, player: str, edge_index: int) -> list[int]:
    board = _parse_board(observation)
    ends = board["edge_corners"][edge_index]
    if ends is None:
        return []
    opened = []
    for corner in ends:
        if not _distance_open(board, corner):
            continue
        already = any(board["edge_owners"][edge] == player for edge, _neighbor in board["incident"][corner])
        if not already:
            opened.append(corner)
    return opened


def _blank() -> dict:
    return {
        "games": 0,
        "completed": 0,
        "cutoffs": 0,
        "wins": 0,
        "losses": 0,
        "roads": 0,
        "roads_that_open": 0,
        "roads_while_settlement_legal": 0,
        "roads_while_city_legal": 0,
        "roads_with_length_gain": 0,
        "roads_below_best_length_gain": 0,
        "opened_spot_pips": [],
        "opened_but_unaffordable_after_road": 0,
        "opened_with_no_settlement_piece": 0,
        "settlements": 0,
        "settlement_pips": [],
        "settlement_below_best_pips": 0,
        "cities": 0,
        "city_skipped_when_legal": 0,
        "city_decisions": 0,
        "settlement_skipped_when_legal": 0,
        "settlement_decisions": 0,
        "trades": 0,
        "trades_while_city_legal": 0,
        "trades_while_settlement_legal": 0,
        "trades_toward": Counter(),
        "terminal_own_length": [],
        "terminal_opp_length": [],
        "terminal_own_longest_road": 0,
        "terminal_opp_longest_road": 0,
        "terminal_own_production": [],
        "terminal_vp_margin": [],
        "completed_vp_margin": [],
        "completed_own_length": [],
        "completed_opp_length": [],
        "completed_opp_longest_road": 0,
        "completed_own_longest_road": 0,
        "production_at_settlement": [],
        "production_after_settlement": [],
    }


def _classify(stats: dict, observation: dict, chosen: str, player: str, pending_production: dict) -> None:
    candidates = {str(item["action_id"]): item for item in observation["candidates"]}
    legal_types = {str(item["type"]) for item in observation["candidates"]}
    chosen_type = chosen.split(":", 1)[0]
    hand = (observation.get("actor") or {}).get("hand") or {}
    city_legal = "buildCity" in legal_types
    settlement_legal = "buildSettlement" in legal_types
    if city_legal:
        stats["city_decisions"] += 1
        if chosen_type != "buildCity":
            stats["city_skipped_when_legal"] += 1
    elif settlement_legal:
        stats["settlement_decisions"] += 1
        if chosen_type != "buildSettlement":
            stats["settlement_skipped_when_legal"] += 1
    production = sum(int(value) for value in ((observation.get("actor") or {}).get("production") or {}).values())
    if pending_production.get("waiting") and chosen_type not in {"rollDice"}:
        stats["production_after_settlement"].append(production)
        pending_production["waiting"] = False
    if chosen_type == "buildSettlement":
        stats["settlements"] += 1
        chosen_pips = _pips(observation, int(chosen.split("c")[-1]))
        options = [
            _pips(observation, int(item["action_id"].split("c")[-1]))
            for item in observation["candidates"]
            if item["type"] == "buildSettlement"
        ]
        stats["settlement_pips"].append(chosen_pips)
        if options and chosen_pips < max(options):
            stats["settlement_below_best_pips"] += 1
        stats["production_at_settlement"].append(production)
        pending_production["waiting"] = True
    if chosen_type == "buildCity":
        stats["cities"] += 1
    if chosen_type == "bankTrade":
        stats["trades"] += 1
        if city_legal:
            stats["trades_while_city_legal"] += 1
        if settlement_legal:
            stats["trades_while_settlement_legal"] += 1
        features = (candidates.get(chosen) or {}).get("public_features") or {}
        for resource in RESOURCES:
            if int(features.get(f"receive_{resource}") or 0) > 0:
                stats["trades_toward"][resource] += 1
    if chosen_type != "buildRoad":
        return
    stats["roads"] += 1
    edge_index = int((candidates.get(chosen) or {}).get("public_features", {}).get("edge_index"))
    opened = _opened_spots(observation, player, edge_index)
    if opened:
        stats["roads_that_open"] += 1
        stats["opened_spot_pips"].extend(_pips(observation, corner) for corner in opened)
        after = dict(hand)
        after["lumber"] = int(after.get("lumber") or 0) - 1
        after["brick"] = int(after.get("brick") or 0) - 1
        if int((observation.get("actor") or {}).get("settlements_left") or 0) <= 0:
            stats["opened_with_no_settlement_piece"] += 1
        elif not _can_pay(after, SETTLEMENT_COST):
            stats["opened_but_unaffordable_after_road"] += 1
    if settlement_legal:
        stats["roads_while_settlement_legal"] += 1
    if city_legal:
        stats["roads_while_city_legal"] += 1
    before = road_length(observation, player)
    after_length = road_length(observation, player, extra_edge=f"e{edge_index}")
    if after_length > before:
        stats["roads_with_length_gain"] += 1
    best_gain = 0
    for item in observation["candidates"]:
        if item["type"] != "buildRoad":
            continue
        other = int(item["public_features"]["edge_index"])
        gain = road_length(observation, player, extra_edge=f"e{other}") - before
        best_gain = max(best_gain, gain)
    if after_length - before < best_gain:
        stats["roads_below_best_length_gain"] += 1


def _timeline_row(observation: dict, chosen: str, player: str, rolls: int) -> dict:
    opponent = (observation.get("opponents") or [{}])[0]
    production = (observation.get("actor") or {}).get("production") or {}
    return {
        "rolls": rolls,
        "phase": observation.get("phase"),
        "chosen": chosen,
        "public_vp": (observation.get("actor") or {}).get("public_vp"),
        "opponent_vp": opponent.get("public_vp"),
        "own_road_length": road_length(observation, player),
        "opponent_road_length": opponent.get("road_length"),
        "opponent_longest_road": bool(opponent.get("has_longest_road")),
        "opponent_largest_army": bool(opponent.get("has_largest_army")),
        "production": sum(int(value) for value in production.values()),
        "hand": sum(int(value) for value in ((observation.get("actor") or {}).get("hand") or {}).values()),
        "settlements_left": (observation.get("actor") or {}).get("settlements_left"),
        "cities_left": (observation.get("actor") or {}).get("cities_left"),
    }


def diagnose_games(bridge, model, device: torch.device, seeds: tuple[str, ...]) -> dict:
    if any(not seed.startswith("ml-v6-strength-") for seed in seeds):
        raise RuntimeError("diagnosis replays only the phase-10 strength seeds")
    if getattr(model, "feature_version", "") != FEATURE_VERSION_V6:
        raise RuntimeError("diagnosis plays the frozen v6 checkpoint")
    stats = _blank()
    timelines = []
    for seed in seeds:
        for learner in ("c1", "c2"):
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
                    "checkpoint": "ml/runs/phase9/road_v6.pt",
                    "detail": "full",
                }
            )
            stats["games"] += 1
            pending = {"waiting": False}
            rolls = 0
            timeline = []
            keep_timeline = seed in {"ml-v6-strength-0", "ml-v6-strength-1"}
            while reply.get("type") == "decision":
                observation = reply["observation"]
                action_id = select_legal(model, observation, device, FEATURE_VERSION_V6)
                if action_id.split(":", 1)[0] == "rollDice":
                    rolls += 1
                _classify(stats, observation, action_id, learner, pending)
                if keep_timeline and action_id.split(":", 1)[0] not in {"rollDice", "moveRobber", "discard"}:
                    timeline.append(_timeline_row(observation, action_id, learner, rolls))
                reply = bridge.request({"cmd": "act", "action_id": action_id})
                if reply.get("type") == "error":
                    raise RuntimeError(reply.get("message", "bridge error"))
            terminal = reply
            completed = terminal.get("completion_status") == "completed"
            stats["completed" if completed else "cutoffs"] += 1
            score = terminal["actor_win"][learner] if completed else None
            if score == 1:
                stats["wins"] += 1
            elif score == 0:
                stats["losses"] += 1
            scores = terminal.get("scores") or {}
            mine = scores.get(learner) or {}
            other = scores.get("c2" if learner == "c1" else "c1") or {}
            if mine and other:
                margin = float(mine["actual_vp"]) - float(other["actual_vp"])
                stats["terminal_vp_margin"].append(margin)
                if completed:
                    stats["completed_vp_margin"].append(margin)
            if mine:
                stats["terminal_own_length"].append(int(mine.get("road_length") or 0))
                stats["terminal_own_longest_road"] += 1 if mine.get("has_longest_road") else 0
                if completed:
                    stats["completed_own_length"].append(int(mine.get("road_length") or 0))
                    stats["completed_own_longest_road"] += 1 if mine.get("has_longest_road") else 0
            if other:
                stats["terminal_opp_length"].append(int(other.get("road_length") or 0))
                stats["terminal_opp_longest_road"] += 1 if other.get("has_longest_road") else 0
                if completed:
                    stats["completed_opp_length"].append(int(other.get("road_length") or 0))
                    stats["completed_opp_longest_road"] += 1 if other.get("has_longest_road") else 0
            if keep_timeline:
                timelines.append(
                    {
                        "seed": seed,
                        "learner": learner,
                        "completion_status": terminal.get("completion_status"),
                        "cutoff_reason": terminal.get("cutoff_reason"),
                        "actor_win": score,
                        "scores": scores,
                        "turns": terminal.get("turns"),
                        "events": timeline,
                    }
                )
    def mean(values: list[float]) -> float | None:
        return None if not values else sum(values) / len(values)

    return {
        "diagnosis_only": True,
        "fresh_evaluation": False,
        "seeds": list(seeds),
        "games": stats["games"],
        "completed": stats["completed"],
        "cutoffs": stats["cutoffs"],
        "wins": stats["wins"],
        "losses": stats["losses"],
        "roads": stats["roads"],
        "roads_that_open_a_distance_spot": stats["roads_that_open"],
        "roads_while_settlement_legal": stats["roads_while_settlement_legal"],
        "roads_while_city_legal": stats["roads_while_city_legal"],
        "roads_that_extend_longest_route": stats["roads_with_length_gain"],
        "roads_shorter_than_another_legal_road": stats["roads_below_best_length_gain"],
        "mean_opened_spot_pips": mean(stats["opened_spot_pips"]),
        "opened_spot_pips_n": len(stats["opened_spot_pips"]),
        "opened_but_settlement_unaffordable": stats["opened_but_unaffordable_after_road"],
        "opened_with_no_settlement_left": stats["opened_with_no_settlement_piece"],
        "settlements": stats["settlements"],
        "mean_settlement_pips": mean(stats["settlement_pips"]),
        "settlements_below_best_legal_spot": stats["settlement_below_best_pips"],
        "cities": stats["cities"],
        "city_decisions": stats["city_decisions"],
        "city_skipped_when_legal": stats["city_skipped_when_legal"],
        "settlement_decisions": stats["settlement_decisions"],
        "settlement_skipped_when_legal": stats["settlement_skipped_when_legal"],
        "trades": stats["trades"],
        "trades_while_city_legal": stats["trades_while_city_legal"],
        "trades_while_settlement_legal": stats["trades_while_settlement_legal"],
        "trade_receive": dict(stats["trades_toward"]),
        "mean_terminal_own_road_length": mean([float(value) for value in stats["terminal_own_length"]]),
        "mean_terminal_opponent_road_length": mean([float(value) for value in stats["terminal_opp_length"]]),
        "learner_held_longest_road": stats["terminal_own_longest_road"],
        "opponent_held_longest_road": stats["terminal_opp_longest_road"],
        "mean_terminal_vp_margin_including_cutoffs": mean(stats["terminal_vp_margin"]),
        "mean_completed_vp_margin": mean(stats["completed_vp_margin"]),
        "mean_completed_own_road_length": mean([float(value) for value in stats["completed_own_length"]]),
        "mean_completed_opponent_road_length": mean([float(value) for value in stats["completed_opp_length"]]),
        "completed_learner_held_longest_road": stats["completed_own_longest_road"],
        "completed_opponent_held_longest_road": stats["completed_opp_longest_road"],
        "mean_production_when_settlement_placed": mean(stats["production_at_settlement"]),
        "mean_production_at_next_action": mean(stats["production_after_settlement"]),
        "timelines": timelines,
    }
