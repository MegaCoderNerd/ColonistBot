"""Fixed feature layout for colonist_observation_v1.

colonist_features_v2 scores a candidate from its own public features. The action
id is not hashed into the vector: a hash cannot tell two roads apart in a way
that transfers to a new board. Location, production, cost, and network flags are
computed in TypeScript and kept on the summary wire, so training and play use
the same numbers.
"""

from __future__ import annotations

import torch

PHASES = (
    "setup_settlement",
    "setup_road",
    "pre_roll",
    "discard",
    "robber_move",
    "main",
    "road_building_1",
    "road_building_2",
    "year_of_plenty",
    "monopoly",
    "game_over",
)
ACTIONS = (
    "placeSetupSettlement",
    "placeSetupRoad",
    "rollDice",
    "discard",
    "moveRobber",
    "buildRoad",
    "buildSettlement",
    "buildCity",
    "buyDevCard",
    "playKnight",
    "playRoadBuilding",
    "placeFreeRoad",
    "playYearOfPlenty",
    "playMonopoly",
    "bankTrade",
    "playerTrade",
    "endTurn",
)
RESOURCES = ("lumber", "brick", "wool", "grain", "ore")
DEV_KEYS = ("knight", "roadBuilding", "yearOfPlenty", "monopoly", "victoryPoint")
FEATURE_VERSION = "colonist_features_v2"
CORNERS = 54
EDGES = 72
HEXES = 19
# Phase, hand, devs, pieces, bank, two opponents, dice mode, victory target,
# own production, and the robber hex resource.
GLOBAL_DIM = len(PHASES) + 1 + len(RESOURCES) * 2 + len(DEV_KEYS) + 4 + 8 * 2 + 2 + len(RESOURCES) + len(RESOURCES) + 1
# Type, location, pip totals, per-resource pips, port, network, give, receive, cost.
CANDIDATE_DIM = len(ACTIONS) + 1 + 6 + 3 + len(RESOURCES) + 7 + 3 + len(RESOURCES) * 3


def _phase(phase: str) -> list[float]:
    one_hot = [1.0 if phase == name else 0.0 for name in PHASES]
    one_hot.append(0.0 if phase in PHASES else 1.0)
    return one_hot


def _bag(values: dict, scale: float) -> list[float]:
    return [float(values.get(key, 0)) / scale for key in RESOURCES]


def global_vector(observation: dict) -> list[float]:
    actor = observation["actor"]
    vector = _phase(str(observation.get("phase", "other")))
    vector.extend(_bag(actor.get("hand", {}), 10.0))
    vector.extend(float(actor.get("dev_cards", {}).get(key, 0)) / 5.0 for key in DEV_KEYS)
    vector.append(float(actor.get("public_vp", 0)) / 10.0)
    vector.append(float(actor.get("settlements_left", 0)) / 5.0)
    vector.append(float(actor.get("cities_left", 0)) / 4.0)
    vector.append(float(actor.get("roads_left", 0)) / 15.0)
    vector.extend(_bag(observation.get("bank", {}), 19.0))
    opponents = list(observation.get("opponents", []))[:2]
    while len(opponents) < 2:
        opponents.append({})
    for opponent in opponents:
        vector.extend(
            [
                float(opponent.get("public_vp", 0)) / 10.0,
                float(opponent.get("hand_size", 0)) / 10.0,
                float(opponent.get("settlements", 0)) / 5.0,
                float(opponent.get("cities", 0)) / 4.0,
                float(opponent.get("road_length", 0)) / 15.0,
                float(opponent.get("knights_played", 0)) / 3.0,
                1.0 if opponent.get("has_longest_road") else 0.0,
                1.0 if opponent.get("has_largest_army") else 0.0,
            ]
        )
    vector.append(1.0 if observation.get("dice_mode") == "balanced" else 0.0)
    vector.append(float(observation.get("victory_points_to_win", 10)) / 15.0)
    vector.extend(_bag(actor.get("production") or {}, 20.0))
    robber = observation.get("robber_resource")
    vector.extend(1.0 if robber == name else 0.0 for name in (*RESOURCES, "desert"))
    if len(vector) != GLOBAL_DIM:
        raise RuntimeError(f"global feature width {len(vector)} != {GLOBAL_DIM}")
    return vector


def _action_one_hot(action_type: str) -> list[float]:
    one_hot = [1.0 if action_type == name else 0.0 for name in ACTIONS]
    one_hot.append(0.0 if action_type in ACTIONS else 1.0)
    return one_hot


def _present_index(value: object, width: int) -> tuple[float, float]:
    try:
        index = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0, 0.0
    if index < 0:
        return 0.0, 0.0
    return 1.0, min(1.0, index / float(width))


def _candidate_row(candidate: dict) -> list[float]:
    public = candidate.get("public_features") or {}
    corner_present, corner_index = _present_index(public.get("corner_index", -1), CORNERS)
    edge_present, edge_index = _present_index(public.get("edge_index", -1), EDGES)
    hex_present, hex_index = _present_index(public.get("hex_index", -1), HEXES)
    row = _action_one_hot(str(candidate.get("type", "other")))
    row.extend([corner_present, edge_present, hex_present, corner_index, edge_index, hex_index])
    row.extend(
        [
            float(public.get("corner_pips", 0)) / 10.0,
            float(public.get("edge_pips", 0)) / 20.0,
            float(public.get("hex_pips", 0)) / 5.0,
        ]
    )
    row.extend(float(public.get(f"{name}_pips", 0)) / 10.0 for name in RESOURCES)
    row.extend(float(public.get(f"port_{name}", 0)) for name in ("none", "any", *RESOURCES))
    row.extend(float(public.get(name, 0)) for name in ("touches_own_building", "touches_own_road", "touches_opponent"))
    row.extend(float(public.get(f"give_{name}", 0)) / 10.0 for name in RESOURCES)
    row.extend(float(public.get(f"receive_{name}", 0)) / 4.0 for name in RESOURCES)
    row.extend(float(public.get(f"cost_{name}", 0)) / 3.0 for name in RESOURCES)
    return row


def candidate_matrix(observation: dict) -> tuple[list[list[float]], list[str]]:
    rows = []
    ids = []
    for candidate in observation["candidates"]:
        row = _candidate_row(candidate)
        if len(row) != CANDIDATE_DIM:
            raise RuntimeError(f"candidate feature width {len(row)} != {CANDIDATE_DIM}")
        rows.append(row)
        ids.append(str(candidate["action_id"]))
    return rows, ids


def encode_observation(observation: dict, device: torch.device) -> tuple[torch.Tensor, torch.Tensor, list[str]]:
    rows, ids = candidate_matrix(observation)
    global_x = torch.tensor(global_vector(observation), dtype=torch.float32, device=device)
    candidates = torch.tensor(rows, dtype=torch.float32, device=device)
    return global_x, candidates, ids
