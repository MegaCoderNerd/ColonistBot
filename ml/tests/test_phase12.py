import json
from pathlib import Path

import pytest
import torch

from colonist_ml.checkpoint import load_checkpoint, save_checkpoint
from colonist_ml.longest import ensure_longest_features, features_for_edge, longest_road_holder
from colonist_ml.phase10 import V4_WEIGHT_SHA256, V6_WEIGHT_SHA256
from colonist_ml.phase12 import (
    CANDIDATE_DIM_V7,
    GLOBAL_DIM_V7,
    SMOKE_SEEDS,
    transfer_v6_to_v7,
)
from colonist_ml.match import _weight_hash
from colonist_ml.model import PolicyValueNet
from colonist_ml.phase9 import CANDIDATE_DIM_V6, score_v6
from colonist_ml.phase12 import score_v7
from colonist_ml.roads import encode_observation_v6
from colonist_ml.tracked import FEATURE_VERSION_V4, FEATURE_VERSION_V6, FEATURE_VERSION_V7, GLOBAL_DIM_V4


ROOT = Path(__file__).resolve().parents[2]


def test_award_rule_matches_the_engine_cases():
    assert longest_road_holder({"c1": 4, "c2": 4}, "c1") is None
    assert longest_road_holder({"c1": 5, "c2": 5}, "c1") == "c1"
    assert longest_road_holder({"c1": 5, "c2": 5}, None) is None
    assert longest_road_holder({"c1": 6, "c2": 5}, "c2") == "c1"
    assert longest_road_holder({"c1": 3, "c2": 6}, "c1") == "c2"


def test_fixture_matches_the_typescript_stamp():
    path = ROOT / "ml" / "fixtures" / "longest_road_cases.json"
    if not path.is_file():
        pytest.skip("run the TypeScript longest-road test to write the fixture")
    observation = json.loads(path.read_text(encoding="utf-8"))["gain_tie"]
    ensured = ensure_longest_features(observation)
    assert ensured["actor"]["road_length"] == observation["actor"]["road_length"]
    assert ensured["actor"]["has_longest_road"] == observation["actor"]["has_longest_road"]
    for candidate in observation["candidates"]:
        if candidate["type"] not in {"buildRoad", "placeFreeRoad", "placeSetupRoad"}:
            public = candidate["public_features"]
            assert public["road_length_now"] == 0
            assert public["longest_road_otherwise"] == 0
            continue
        recomputed = features_for_edge(observation, int(candidate["public_features"]["edge_index"]))
        for key, value in recomputed.items():
            assert candidate["public_features"][key] == value
    global_x, candidates, ids = encode_observation_v6(observation, torch.device("cpu"))
    assert global_x.numel() == GLOBAL_DIM_V4
    assert candidates.size(1) == CANDIDATE_DIM_V6
    assert "devDeckOrder" not in json.dumps(observation)


def test_v4_and_v6_checkpoints_are_rejected_as_v7():
    v6 = ROOT / "ml" / "runs" / "phase9" / "road_v6.pt"
    v4 = ROOT / "ml" / "runs" / "phase6" / "summary_v4.pt"
    with pytest.raises(ValueError, match="not colonist_features_v7"):
        load_checkpoint(str(v6), torch.device("cpu"), expected_version=FEATURE_VERSION_V7)
    with pytest.raises(ValueError, match="not colonist_features_v7"):
        load_checkpoint(str(v4), torch.device("cpu"), expected_version=FEATURE_VERSION_V7)
    loaded, _optimizer, _payload = load_checkpoint(str(v6), torch.device("cpu"))
    assert loaded.feature_version == FEATURE_VERSION_V6
    assert _weight_hash(loaded) == V6_WEIGHT_SHA256
    v4_model, _opt, _payload = load_checkpoint(str(v4), torch.device("cpu"))
    assert v4_model.feature_version == FEATURE_VERSION_V4
    assert _weight_hash(v4_model) == V4_WEIGHT_SHA256


def test_zero_init_matches_v6_scores_and_a_saved_v7_file_will_not_load_as_v6(tmp_path):
    source, _optimizer, _payload = load_checkpoint(str(ROOT / "ml" / "runs" / "phase9" / "road_v6.pt"), torch.device("cpu"))
    target = PolicyValueNet(global_dim=GLOBAL_DIM_V7, feature_version=FEATURE_VERSION_V7, candidate_dim=CANDIDATE_DIM_V7)
    transfer_v6_to_v7(source, target)
    path = ROOT / "ml" / "fixtures" / "longest_road_cases.json"
    if not path.is_file():
        pytest.skip("run the TypeScript longest-road test to write the fixture")
    observation = json.loads(path.read_text(encoding="utf-8"))["gain_tie"]
    assert score_v6(source, observation, torch.device("cpu")) == score_v7(target, observation, torch.device("cpu"))
    destination = tmp_path / "v7.pt"
    save_checkpoint(str(destination), target, torch.optim.Adam(target.parameters(), lr=1e-3), 0, 7, {"feature_version": FEATURE_VERSION_V7})
    with pytest.raises(ValueError, match="not colonist_features_v6"):
        load_checkpoint(str(destination), torch.device("cpu"), expected_version=FEATURE_VERSION_V6)
    reloaded, optimizer, payload = load_checkpoint(str(destination), torch.device("cpu"), expected_version=FEATURE_VERSION_V7)
    assert payload["global_dim"] == GLOBAL_DIM_V7
    assert int(reloaded.candidate_dim) == CANDIDATE_DIM_V7
    assert optimizer is not None


def test_strength_seeds_are_unused_by_training_namespaces():
    assert SMOKE_SEEDS[0] == "ml-v7-strength-0"
    assert len({f"ml-v7-strength-{index}" for index in range(200)}) == 200
    assert not any(seed.startswith("ml-v6-strength-") for seed in SMOKE_SEEDS)
