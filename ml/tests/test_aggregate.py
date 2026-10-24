from pathlib import Path

import pytest
import torch

from colonist_ml.aggregate import (
    FINAL_SEED_COUNT,
    OPPONENT,
    TARGET_MIN_N,
    TRAIN_SEED_COUNT,
    VAL_SEED_COUNT,
    WITHIN_TYPE_READY,
    assert_agg_seeds,
    build_example,
    choose_variant,
    disagreement_kind,
    meets_action_criteria,
    mix_corpora,
    seeds_for,
    trade_effect,
)


def _observation(action_ids: list[str]) -> dict:
    return {
        "schema_version": "colonist_observation_v2",
        "phase": "main",
        "actor": {
            "hand": {"lumber": 1, "brick": 0, "wool": 0, "grain": 4, "ore": 0},
            "production": {"lumber": 4, "brick": 0, "wool": 1, "grain": 3, "ore": 0},
            "public_vp": 2,
            "settlements_left": 3,
        },
        "opponents": [
            {
                "id": "c2",
                "public_vp": 2,
                "hand_size": 3,
                "tracked_resources": {
                    "lumber": 0,
                    "brick": 0,
                    "wool": 0,
                    "grain": 0,
                    "ore": 0,
                    "unknown": 3,
                    "exact": False,
                },
            }
        ],
        "bank_exact": False,
        "bank": None,
        "candidates": [
            {"action_id": action_id, "type": action_id.split(":", 1)[0], "public_features": {"edge_index": index, "edge_pips": 4}}
            for index, action_id in enumerate(action_ids)
        ],
    }


def _example(learner: str, teacher: str, completed: bool = False) -> dict:
    return build_example(
        game_id="selfplay:ml-v4-agg-train-0",
        seed="ml-v4-agg-train-0",
        decision_index=3,
        observation=_observation(["endTurn", "buildRoad:e4", "bankTrade:grain:4:brick:1"]),
        learner_action=learner,
        teacher_action=teacher,
        checkpoint_hash="abc",
        checkpoint_path="ml/runs/phase6/summary_v4.pt",
        completion_status="completed" if completed else "incomplete",
        cutoff_reason=None if completed else "max_turns_reached",
        actor_win=0 if completed else None,
        teacher_diagnostic={"explanation_available": False, "road_reach": {"dist": 1, "opens_settlement_now": False}},
        learner_seat="c1",
    )


def test_teacher_label_must_be_the_legal_candidate_on_that_state():
    example = _example("endTurn", "buildRoad:e4")
    assert example["teacher_action_id"] == "buildRoad:e4"
    assert example["chosen_action_id"] == "endTurn"
    assert example["teacher_policy"] == "baseline_heuristic_v1"
    assert example["diagnostic_slice"] == "endturn_vs_road"
    assert example["sample_weight"] == 1
    assert example["actor_win"] is None
    assert example["simulator"]["rule_profile"] == "colonist_benchmark_1v1_v1"
    assert "hand" not in example["observation"]["opponents"][0]
    with pytest.raises(RuntimeError):
        _example("endTurn", "buildRoad:e99")
    with pytest.raises(RuntimeError):
        build_example(
            game_id="g",
            seed="ml-v4-agg-train-0",
            decision_index=0,
            observation=_observation(["endTurn"]),
            learner_action="endTurn",
            teacher_action="endTurn",
            checkpoint_hash="abc",
            checkpoint_path="ml/runs/phase6/summary_v4.pt",
            completion_status="incomplete",
            cutoff_reason="max_turns_reached",
            actor_win=1,
            teacher_diagnostic=None,
            learner_seat="c1",
        )


def test_hidden_hand_is_rejected():
    observation = _observation(["endTurn"])
    observation["opponents"][0]["hand"] = {"lumber": 1}
    with pytest.raises(RuntimeError):
        build_example(
            game_id="g",
            seed="ml-v4-agg-train-0",
            decision_index=0,
            observation=observation,
            learner_action="endTurn",
            teacher_action="endTurn",
            checkpoint_hash="abc",
            checkpoint_path="frozen",
            completion_status="incomplete",
            cutoff_reason="max_turns_reached",
            actor_win=None,
            teacher_diagnostic=None,
            learner_seat="c2",
        )


def test_trade_conversion_uses_the_tracked_hand_only():
    effect = trade_effect({"lumber": 1, "brick": 0, "wool": 0, "grain": 4, "ore": 0}, "bankTrade:grain:4:brick:1")
    assert effect["affordable_give"] is True
    assert "road" in effect["newly_affordable"]
    assert disagreement_kind("endTurn", "bankTrade:grain:4:brick:1") == "endturn_vs_trade"
    assert disagreement_kind("buildRoad:e4", "buildRoad:e4") is None


def test_splits_do_not_reuse_match_or_phase6_seeds():
    assert seeds_for("train")[0] == "ml-v4-agg-train-0"
    assert len(seeds_for("train")) == TRAIN_SEED_COUNT
    assert len(seeds_for("val")) == VAL_SEED_COUNT
    assert len(seeds_for("final")) == FINAL_SEED_COUNT
    assert_agg_seeds(seeds_for("train"), "train")
    assert_agg_seeds(seeds_for("final"), "final")
    for seed in ("ml-v4-match-0", "ml-phase6-train-0", "ml-phase6-final-0", "ml-fidelity-fit-0", "ml-graph-final-0", "ml-v4-agg-timing-0"):
        with pytest.raises(RuntimeError):
            assert_agg_seeds((seed,), "train")
    with pytest.raises(RuntimeError):
        assert_agg_seeds(("ml-v4-agg-val-0",), "train")


def test_mixture_keeps_every_row_once_at_weight_one():
    original = [_example("endTurn", "endTurn")]
    original[0]["diagnostic_slice"] = None
    aggregated = [_example("endTurn", "buildRoad:e4")]
    mixed = mix_corpora(original, aggregated)
    assert len(mixed) == 2
    assert all(row.get("sample_weight", 1) == 1 for row in mixed)
    assert mixed[1]["diagnostic_slice"] == "endturn_vs_road"
    aggregated[0]["sample_weight"] = 4
    with pytest.raises(RuntimeError):
        mix_corpora(original, aggregated)


def _view(road: float, trade: float, top1: float = 0.80, multi: float = 0.70, within: float = 0.50, robber: float = 0.60) -> dict:
    types = {
        "moveRobber": {"n": 50, "top1": robber, "top3": robber},
        "placeSetupSettlement": {"n": 50, "top1": 0.70, "top3": 0.80},
        "discard": {"n": 50, "top1": 0.40, "top3": 0.50},
    }
    return {
        "natural": {"top1": top1, "multi_legal_top1": multi, "invalid_predictions": 0, "by_action_type": types},
        "within_by_type": {
            name: {"n": 50, "within_type": within}
            for name in ("buildRoad", "bankTrade", "moveRobber", "placeSetupSettlement")
        },
        "targeted": {
            "endturn_vs_road": {"n": TARGET_MIN_N, "exact": road},
            "endturn_vs_trade": {"n": TARGET_MIN_N, "exact": trade},
        },
    }


def test_action_criteria_were_locked_before_candidate_scores():
    assert WITHIN_TYPE_READY == 0.35
    assert OPPONENT == "baseline_heuristic_v1"
    baseline = _view(0.05, 0.10)
    ready = _view(0.30, 0.30)
    assert meets_action_criteria(baseline, ready)["met"] is True
    short = _view(0.30, 0.30)
    short["targeted"]["endturn_vs_road"]["n"] = 10
    assert meets_action_criteria(baseline, short)["met"] is False
    weak = _view(0.10, 0.30)
    assert meets_action_criteria(baseline, weak)["met"] is False
    regress = _view(0.30, 0.30, top1=0.70)
    assert meets_action_criteria(baseline, regress)["met"] is False
    unmeasured_within = _view(0.30, 0.30, within=0.10)
    assert meets_action_criteria(baseline, unmeasured_within)["met"] is False
    assert choose_variant(True, True, 0.70, 0.90) == "ordinary"
    assert choose_variant(False, True, 0.70, 0.69) == "pairwise"
    assert choose_variant(False, True, 0.70, 0.60) == "ordinary"
    assert choose_variant(False, False, 0.70, 0.90) == "ordinary"


def test_fixed_seed_and_frozen_checkpoint_repeat():
    root = Path(__file__).resolve().parents[2]
    checkpoint = root / "ml" / "runs" / "phase6" / "summary_v4.pt"
    if not checkpoint.exists():
        pytest.skip("frozen summary v4 checkpoint is not in the workspace")
    from colonist_ml.aggregate import game_fingerprint
    from colonist_ml.checkpoint import load_checkpoint
    from colonist_ml.rl import SimulatorBridge

    model, _optimizer, payload = load_checkpoint(str(checkpoint), torch.device("cpu"))
    assert payload["feature_version"] == "colonist_features_v4"
    assert payload["dataset_manifest"]["frozen"] is True
    bridge = SimulatorBridge(root)
    try:
        first = game_fingerprint(bridge, model, torch.device("cpu"), "ml-v4-agg-timing-0", "c1", str(checkpoint))
        second = game_fingerprint(bridge, model, torch.device("cpu"), "ml-v4-agg-timing-0", "c1", str(checkpoint))
    finally:
        bridge.close()
    assert first == second
    assert first
    status = {row[3] for row in first}
    assert status <= {"completed", "incomplete"}
    assert all(row[4] is None for row in first if row[3] == "incomplete")
    assert all(row[2] for row in first)
