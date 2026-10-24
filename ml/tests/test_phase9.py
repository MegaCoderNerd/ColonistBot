import json
from pathlib import Path

import pytest
import torch

from colonist_ml.aggregate import _score
from colonist_ml.features import CANDIDATE_DIM
from colonist_ml.model import PolicyValueNet
from colonist_ml.phase9 import (
    CANDIDATE_DIM_V6,
    FINAL_SEEDS,
    PHASE6_MULTI_MIN,
    PHASE6_TOP1_MIN,
    ROAD_EXACT_MIN,
    TRADE_EXACT_MIN,
    TRADE_WITHIN_MIN,
    assert_final_seeds,
    meets_v6_gate,
    score_v6,
    transfer_v4_weights,
)
from colonist_ml.roads import ensure_road_features, expansion_for_edge
from colonist_ml.tracked import FEATURE_VERSION_V4, FEATURE_VERSION_V6, GLOBAL_DIM_V4, encode_observation_v4


def _board(pieces=None, edge_owners=None) -> dict:
    pieces = pieces or {}
    edge_owners = edge_owners or {}
    corners = [{"id": f"c{index}", "hex_ids": [], "port": None} for index in range(4)]
    edges = [
        {"id": "e0", "corners": ["c0", "c1"]},
        {"id": "e1", "corners": ["c1", "c2"]},
        {"id": "e2", "corners": ["c2", "c3"]},
    ]
    placed_corners = [{"id": f"c{index}", "owner": owner, "piece": "settlement"} for index, owner in pieces.items()]
    placed_edges = [{"id": f"e{index}", "owner": owner} for index, owner in edge_owners.items()]
    return {
        "actor_id": "c1",
        "board": {"corners": corners, "edges": edges, "hexes": []},
        "placements": {"corners": placed_corners, "edges": placed_edges},
    }


def test_two_roads_differ_and_an_opponent_building_blocks_the_spot():
    connected = expansion_for_edge(_board(edge_owners={0: "c1"}), "c1", 1)
    disconnected = expansion_for_edge(_board(edge_owners={0: "c1"}), "c1", 2)
    assert connected["connects_network"] == 1
    assert disconnected["connects_network"] == 0
    assert connected["newly_opened"] != disconnected["newly_opened"]
    blocked = expansion_for_edge(_board(pieces={2: "c2"}, edge_owners={0: "c1"}), "c1", 1)
    assert blocked["newly_opened"] == 0
    assert blocked["opens_settlement"] == 0


def test_feature_order_does_not_change_an_action_score_and_v4_ignores_the_tail():
    observation = _board(edge_owners={0: "c1"})
    observation.update(
        {
            "schema_version": "colonist_observation_v2",
            "phase": "main",
            "dice_mode": "balanced",
            "victory_points_to_win": 10,
            "bank_exact": False,
            "bank": None,
            "robber_resource": "desert",
            "actor": {
                "hand": {"lumber": 1, "brick": 1, "wool": 0, "grain": 0, "ore": 0},
                "dev_cards": {},
                "production": {},
                "public_vp": 2,
                "settlements_left": 3,
                "cities_left": 4,
                "roads_left": 12,
            },
            "opponents": [
                {
                    "id": "c2",
                    "public_vp": 2,
                    "hand_size": 0,
                    "settlements": 1,
                    "cities": 0,
                    "road_length": 1,
                    "knights_played": 0,
                    "has_longest_road": False,
                    "has_largest_army": False,
                    "tracked_resources": {"lumber": 0, "brick": 0, "wool": 0, "grain": 0, "ore": 0, "unknown": 0, "exact": True},
                }
            ],
            "candidates": [
                {"action_id": "buildRoad:e1", "type": "buildRoad", "public_features": {"edge_index": 1, "edge_pips": 4}},
                {"action_id": "endTurn", "type": "endTurn", "public_features": {}},
                {"action_id": "buildRoad:e2", "type": "buildRoad", "public_features": {"edge_index": 2, "edge_pips": 1}},
            ],
        }
    )
    ensured = ensure_road_features(observation)
    roads = [candidate for candidate in ensured["candidates"] if candidate["type"] == "buildRoad"]
    assert roads[0]["public_features"]["connects_network"] != roads[1]["public_features"]["connects_network"]
    torch.manual_seed(1)
    source = PolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V4)
    target = PolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V6, candidate_dim=CANDIDATE_DIM_V6)
    transfer_v4_weights(source, target)
    device = torch.device("cpu")
    forward = score_v6(target, ensured, device)
    assert dict(forward) == pytest.approx(dict(_score(source, ensured, device)))
    reversed_observation = dict(ensured)
    reversed_observation["candidates"] = list(reversed(ensured["candidates"]))
    backward = dict(score_v6(target, reversed_observation, device))
    assert {action: score for action, score in forward} == pytest.approx(backward)
    plain = encode_observation_v4(ensured, device)
    stripped = dict(ensured)
    stripped["candidates"] = []
    for candidate in ensured["candidates"]:
        public = {key: value for key, value in candidate["public_features"].items() if not str(key).startswith("reach") and key not in {"opens_settlement", "newly_opened", "connects_network"}}
        stripped["candidates"].append({**candidate, "public_features": public})
    again = encode_observation_v4(stripped, device)
    assert torch.allclose(plain[0], again[0])
    assert torch.allclose(plain[1], again[1])
    assert plain[1].shape[1] == CANDIDATE_DIM


def test_v4_checkpoint_does_not_load_as_v6():
    from colonist_ml.checkpoint import load_checkpoint, save_checkpoint

    path = Path(__file__).resolve().parents[1] / "runs" / "phase9" / "schema-probe.pt"
    model = PolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V4)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    save_checkpoint(str(path), model, optimizer, 0, 0, {"probe": True})
    payload = torch.load(path, map_location="cpu")
    payload["feature_version"] = FEATURE_VERSION_V6
    payload["candidate_dim"] = CANDIDATE_DIM_V6
    torch.save(payload, path)
    with pytest.raises(ValueError, match="candidate width"):
        load_checkpoint(str(path), torch.device("cpu"))


def test_gate_and_final_seeds_are_locked():
    assert ROAD_EXACT_MIN == 0.35
    assert TRADE_EXACT_MIN == 0.25
    assert TRADE_WITHIN_MIN == 0.35
    assert PHASE6_TOP1_MIN == 0.826
    assert PHASE6_MULTI_MIN == 0.650
    assert FINAL_SEEDS[0] == "ml-v6-final-0"
    assert_final_seeds(FINAL_SEEDS)
    with pytest.raises(RuntimeError):
        assert_final_seeds(("ml-v4-agg-final-0",))
    view = {
        "natural": {
            "invalid_predictions": 0,
            "by_action_type": {"buildRoad": {"n": 40, "top1": 0.35}},
        },
        "targeted": {
            "endturn_vs_road": {"n": 40, "exact": 0.35},
            "endturn_vs_trade": {"n": 40, "exact": 0.25},
        },
        "within_by_type": {"bankTrade": {"n": 40, "within_type": 0.35}},
    }
    control = {"natural": {"top1": 0.826, "multi_legal_top1": 0.650}}
    assert meets_v6_gate(view, control)["met"] is True
    view["targeted"]["endturn_vs_trade"]["exact"] = 0.24
    assert meets_v6_gate(view, control)["met"] is False


def test_typescript_fixture_matches_python():
    path = Path(__file__).resolve().parents[2] / "ml" / "fixtures" / "road_reach.json"
    if not path.exists():
        pytest.skip("road fixture is written by the TypeScript test")
    payload = json.loads(path.read_text(encoding="utf-8"))
    for candidate in payload["candidates"]:
        if candidate["type"] not in {"buildRoad", "placeFreeRoad", "placeSetupRoad"}:
            continue
        edge = int(candidate["public_features"]["edge_index"])
        computed = expansion_for_edge(payload, payload["actor_id"], edge)
        for key, value in computed.items():
            assert candidate["public_features"][key] == value
