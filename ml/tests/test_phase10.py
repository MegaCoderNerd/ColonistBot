import pytest

from colonist_ml.match import MATCH_SEEDS, MIN_COMPLETED_PAIRS
from colonist_ml.phase10 import (
    CUTOFF_RATE_MARGIN,
    SMOKE_SEEDS,
    STRENGTH_SEEDS,
    V4_WEIGHT_SHA256,
    V6_WEIGHT_SHA256,
    VP_DROP_MAX,
    assert_strength_seeds,
    interpret,
    trade_newly_affordable,
)
from colonist_ml.phase9 import FINAL_SEEDS


def _report(pairs: int, low: float, high: float, cutoffs: int, vp: float) -> dict:
    return {
        "pairs_completed": pairs,
        "pair_score_minus_even": {"low": low, "high": high, "mean": (low + high) / 2},
        "cutoff_games": cutoffs,
        "games_launched": 400,
        "mean_vp_among_completed": vp,
    }


def test_strength_seeds_do_not_reuse_earlier_splits():
    assert len(STRENGTH_SEEDS) == 200
    assert STRENGTH_SEEDS[0] == "ml-v6-strength-0"
    assert STRENGTH_SEEDS[-1] == "ml-v6-strength-199"
    assert SMOKE_SEEDS == STRENGTH_SEEDS[:2]
    assert set(STRENGTH_SEEDS).isdisjoint(MATCH_SEEDS)
    assert set(STRENGTH_SEEDS).isdisjoint(FINAL_SEEDS)
    assert_strength_seeds(STRENGTH_SEEDS)
    assert V6_WEIGHT_SHA256 != V4_WEIGHT_SHA256
    assert MIN_COMPLETED_PAIRS == 30
    assert CUTOFF_RATE_MARGIN == 0.05
    assert VP_DROP_MAX == 1.0
    for seed in ("ml-v6-final-0", "ml-v4-match-0", "ml-v4-agg-train-0", "ml-phase6-final-0", "ml-fidelity-fit-0", "ml-graph-final-0"):
        with pytest.raises(RuntimeError):
            assert_strength_seeds((seed,))


def test_interpretation_is_locked():
    assert interpret(_report(40, 0.02, 0.10, 200, 6.0), _report(40, -0.4, -0.2, 210, 5.5))["decision"] == "positive"
    assert interpret(_report(40, -0.20, -0.01, 200, 4.0), _report(40, -0.4, -0.2, 210, 5.0))["decision"] == "negative"
    assert interpret(_report(40, -0.02, 0.02, 200, 5.0), _report(40, -0.4, -0.2, 200, 5.0))["decision"] == "inconclusive"
    assert interpret(_report(29, 0.10, 0.20, 100, 8.0), _report(29, 0.0, 0.1, 100, 5.0))["decision"] == "inconclusive"
    stalled = interpret(_report(40, 0.05, 0.15, 250, 6.0), _report(40, -0.2, -0.1, 200, 5.0))
    assert stalled["decision"] == "negative"


def test_a_bank_trade_records_only_newly_affordable_builds():
    hand = {"lumber": 1, "brick": 0, "wool": 1, "grain": 1, "ore": 4}
    features = {"give_ore": 4, "receive_brick": 1}
    assert trade_newly_affordable(hand, features) == ["road", "settlement"]
