import json
from pathlib import Path

import torch

from colonist_ml.checkpoint import load_checkpoint, save_checkpoint
from colonist_ml.coverage import graph_replaces_summary, ready_for_strength
from colonist_ml.features import FEATURE_VERSION, GLOBAL_DIM
from colonist_ml.graph import GRAPH_FEATURE_VERSION
from colonist_ml.model import PolicyValueNet
from colonist_ml.tracked import FEATURE_VERSION_V4, FEATURE_VERSION_V5, GLOBAL_DIM_V4, global_vector_v4, tracked_tail


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "tracked_tail.json"


def _within(n, score):
    return {"n": n, "within_type": score, "measured": n >= 40}


def test_typescript_and_python_tracked_tails_match():
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert tracked_tail(payload) == payload["expected_tail"]


def test_uncertain_bank_is_not_encoded_as_an_empty_exact_bank():
    observation = {
        "phase": "main",
        "dice_mode": "balanced",
        "victory_points_to_win": 10,
        "bank_exact": False,
        "bank": None,
        "robber_resource": "desert",
        "actor": {
            "hand": {"lumber": 1, "brick": 0, "wool": 0, "grain": 0, "ore": 0},
            "dev_cards": {},
            "public_vp": 2,
            "settlements_left": 5,
            "cities_left": 4,
            "roads_left": 15,
            "production": {},
        },
        "opponents": [
            {
                "tracked_resources": {
                    "lumber": 3,
                    "brick": 0,
                    "wool": 0,
                    "grain": 0,
                    "ore": 0,
                    "unknown": 1,
                    "exact": False,
                }
            }
        ],
    }
    vector = global_vector_v4(observation)
    assert len(vector) == GLOBAL_DIM_V4
    assert vector[26:31] == [0.0, 0.0, 0.0, 0.0, 0.0]
    assert vector[-1] == 0.0
    assert vector[-15] == 0.3
    privileged = dict(observation)
    privileged["bank"] = {"lumber": 0, "brick": 0, "wool": 0, "grain": 0, "ore": 1}
    try:
        global_vector_v4(privileged)
    except ValueError as error:
        assert "uncertain bank" in str(error)
    else:
        raise AssertionError("privileged bank counts were encoded")


def test_v2_checkpoint_does_not_load_as_v4(tmp_path):
    device = torch.device("cpu")
    model = PolicyValueNet()
    path = tmp_path / "v2.pt"
    save_checkpoint(str(path), model, torch.optim.Adam(model.parameters()), 0, 1, {})
    loaded, _optimizer, payload = load_checkpoint(str(path), device)
    assert payload["feature_version"] == FEATURE_VERSION
    assert loaded.global_dim == GLOBAL_DIM
    tracked = PolicyValueNet(global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V4)
    tracked_path = tmp_path / "v4.pt"
    save_checkpoint(str(tracked_path), tracked, torch.optim.Adam(tracked.parameters()), 0, 1, {})
    reloaded, _optimizer, payload_v4 = load_checkpoint(str(tracked_path), device)
    assert payload_v4["feature_version"] == FEATURE_VERSION_V4
    assert payload_v4["observation_version"] == "colonist_observation_v2"
    assert reloaded.global_dim == GLOBAL_DIM_V4
    assert reloaded.feature_version != GRAPH_FEATURE_VERSION
    assert FEATURE_VERSION_V5 != FEATURE_VERSION


def test_graph_replaces_summary_only_when_every_hard_category_improves():
    summary = {name: _within(40, 0.20) for name in ("buildRoad", "bankTrade", "moveRobber", "placeSetupSettlement")}
    graph = {name: _within(40, 0.30) for name in summary}
    assert graph_replaces_summary(summary, graph, 0.40, 0.40, 0) is True
    short = dict(graph)
    short["buildRoad"] = _within(10, 0.90)
    assert graph_replaces_summary(summary, short, 0.40, 0.40, 0) is False
    assert ready_for_strength(summary) is False
    strong = {name: _within(40, 0.35) for name in summary}
    assert ready_for_strength(strong) is True
