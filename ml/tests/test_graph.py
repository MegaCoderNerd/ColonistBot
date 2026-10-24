"""Board-aware schema, permutation, and the refusal to mix rule profiles or final seeds."""

import copy

import torch

from colonist_ml.checkpoint import load_checkpoint, save_checkpoint
from colonist_ml.graph import GRAPH_FEATURE_VERSION, GraphPolicyValueNet, board_tensors, score_graph
from colonist_ml.league import RUN_AUTHORIZED, refuse_large_run
from colonist_ml.model import PolicyValueNet
from colonist_ml.rules import BENCHMARK_PROFILE, GRAPH_FINAL_SEEDS, LIVE_1V1_PROFILE, PROFILES, assert_comparison_seeds
from colonist_ml.train import stratified_examples


def _board_observation() -> dict:
    hexes = []
    for index in range(19):
        resource = None if index == 0 else ("lumber", "brick", "wool", "grain", "ore")[index % 5]
        hexes.append({"id": f"h{index}", "resource": resource, "pips": 0 if resource is None else (index % 5) + 1})
    corners = [{"id": f"c{index}", "hex_ids": [f"h{index % 19}"], "port": "any" if index == 3 else None} for index in range(54)]
    edges = [{"id": f"e{index}", "corners": [f"c{index % 54}", f"c{(index + 1) % 54}"]} for index in range(72)]
    return {
        "phase": "main",
        "dice_mode": "balanced",
        "victory_points_to_win": 10,
        "robber_resource": "lumber",
        "robber_hex_id": "h1",
        "actor_id": "c1",
        "actor": {
            "hand": {"lumber": 1, "brick": 1, "wool": 0, "grain": 0, "ore": 0},
            "dev_cards": {},
            "production": {"lumber": 2, "brick": 0, "wool": 0, "grain": 0, "ore": 0},
            "public_vp": 2,
            "settlements_left": 3,
            "cities_left": 4,
            "roads_left": 13,
        },
        "opponents": [{"public_vp": 2, "hand_size": 2, "settlements": 2, "cities": 0, "road_length": 2, "knights_played": 0, "has_longest_road": False, "has_largest_army": False}],
        "bank": {"lumber": 19, "brick": 19, "wool": 19, "grain": 19, "ore": 19},
        "board": {"hexes": hexes, "corners": corners, "edges": edges},
        "placements": {
            "corners": [{"id": "c0", "owner": "c1", "piece": "settlement"}],
            "edges": [{"id": "e0", "owner": "c1"}],
        },
        "candidates": [
            {"action_id": "buildRoad:e1", "type": "buildRoad", "public_features": {"corner_index": -1, "edge_index": 1, "hex_index": -1, "cost_lumber": 1, "cost_brick": 1, "lumber_pips": 2}},
            {"action_id": "buildRoad:e4", "type": "buildRoad", "public_features": {"corner_index": -1, "edge_index": 4, "hex_index": -1, "cost_lumber": 1, "cost_brick": 1, "lumber_pips": 4}},
            {"action_id": "endTurn", "type": "endTurn", "public_features": {"corner_index": -1, "edge_index": -1, "hex_index": -1}},
        ],
    }


def test_summary_board_is_rejected_and_owned_edges_differ():
    observation = _board_observation()
    summary = copy.deepcopy(observation)
    summary["board"] = {"hexes": [], "corners": [], "edges": []}
    try:
        board_tensors(summary)
    except ValueError as error:
        assert "summary" in str(error)
    else:
        raise AssertionError("summary board was encoded as a graph")
    encoded = board_tensors(observation)
    assert not torch.equal(encoded["edge_x"][0], encoded["edge_x"][1])


def test_graph_scores_follow_the_action_not_the_list_position():
    observation = _board_observation()
    model = GraphPolicyValueNet()
    device = torch.device("cpu")
    original = dict(score_graph(model, observation, device))
    flipped = copy.deepcopy(observation)
    flipped["candidates"] = list(reversed(flipped["candidates"]))
    reordered = dict(score_graph(model, flipped, device))
    assert set(original) == set(reordered)
    for action_id, score in original.items():
        assert abs(score - reordered[action_id]) < 1e-5
    assert original["buildRoad:e1"] != original["buildRoad:e4"]


def test_feature_schemas_do_not_cross_load(tmp_path):
    device = torch.device("cpu")
    summary = PolicyValueNet()
    graph = GraphPolicyValueNet()
    save_checkpoint(str(tmp_path / "v2.pt"), summary, torch.optim.Adam(summary.parameters()), epoch=0, seed=1, manifest={"external_colonist_games": 0})
    save_checkpoint(str(tmp_path / "v3.pt"), graph, torch.optim.Adam(graph.parameters()), epoch=0, seed=1, manifest={"external_colonist_games": 0})
    loaded_v2, _opt, payload_v2 = load_checkpoint(str(tmp_path / "v2.pt"), device)
    loaded_v3, _opt3, payload_v3 = load_checkpoint(str(tmp_path / "v3.pt"), device)
    assert payload_v2["feature_version"] != GRAPH_FEATURE_VERSION
    assert payload_v3["feature_version"] == GRAPH_FEATURE_VERSION
    assert isinstance(loaded_v2, PolicyValueNet)
    assert isinstance(loaded_v3, GraphPolicyValueNet)
    assert not isinstance(loaded_v3, PolicyValueNet)


def test_rule_profiles_stay_separate_and_the_league_runner_is_closed():
    assert PROFILES[BENCHMARK_PROFILE]["victory_points_to_win"] == 10
    assert PROFILES[LIVE_1V1_PROFILE]["victory_points_to_win"] == 15
    assert PROFILES[BENCHMARK_PROFILE]["comparable_with_previous_benchmark"] is True
    assert PROFILES[LIVE_1V1_PROFILE]["comparable_with_previous_benchmark"] is False
    try:
        assert_comparison_seeds([{"seed": GRAPH_FINAL_SEEDS[0]}], frozenset(GRAPH_FINAL_SEEDS))
    except RuntimeError as error:
        assert "final" in str(error)
    else:
        raise AssertionError("a final seed was accepted for architecture comparison")
    examples = [{"chosen_action_id": "buildRoad:e1"}, {"chosen_action_id": "endTurn"}, {"chosen_action_id": "endTurn"}]
    ordered = stratified_examples(examples, seed=1)
    assert len(ordered) == len(examples)
    assert {item["chosen_action_id"].split(":")[0] for item in ordered[:2]} == {"buildRoad", "endTurn"}
    assert RUN_AUTHORIZED is False
    try:
        refuse_large_run()
    except RuntimeError as error:
        assert "not authorized" in str(error)
    else:
        raise AssertionError("league runner started")
