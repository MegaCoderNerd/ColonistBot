import pytest

from colonist_ml.match import MATCH_SEEDS, MIN_COMPLETED_PAIRS, assert_match_seeds, summarize_decisions


def test_match_seeds_are_disjoint_from_earlier_splits():
    assert len(MATCH_SEEDS) == 200
    assert MATCH_SEEDS[0] == "ml-v4-match-0"
    assert MATCH_SEEDS[-1] == "ml-v4-match-199"
    assert_match_seeds(MATCH_SEEDS)
    with pytest.raises(RuntimeError):
        assert_match_seeds(("ml-phase6-final-0",))
    with pytest.raises(RuntimeError):
        assert_match_seeds(("ml-fidelity-fit-0",))
    with pytest.raises(RuntimeError):
        assert_match_seeds(("ml-graph-final-0",))


def test_end_turn_with_a_legal_build_is_counted_separately_from_agreement():
    summary = summarize_decisions(
        [
            {
                "chosen": "endTurn",
                "teacher": "buildRoad:e4",
                "legal_types": ["buildRoad", "endTurn", "rollDice"],
                "phase": "main",
            },
            {
                "chosen": "placeSetupSettlement:c3",
                "teacher": "placeSetupSettlement:c3",
                "legal_types": ["placeSetupSettlement"],
                "phase": "setup_settlement",
            },
        ]
    )
    assert summary["end_turn_while_legal"]["buildRoad"] == 1
    assert summary["teacher_exact_rate"]["placeSetupSettlement"] == 1
    assert summary["teacher_exact_rate"]["buildRoad"] == 0
    assert MIN_COMPLETED_PAIRS == 30
