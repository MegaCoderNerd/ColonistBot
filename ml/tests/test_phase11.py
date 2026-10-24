from colonist_ml.phase11 import DIAGNOSIS_SEEDS, longest_road_length, road_length


def test_longest_road_matches_the_engine_walk():
    path = {"c0": {"c1"}, "c1": {"c0", "c2"}, "c2": {"c1", "c3"}, "c3": {"c2"}}
    assert longest_road_length(path, set()) == 3
    branched = {
        "c0": {"c1"},
        "c1": {"c0", "c2", "c4"},
        "c2": {"c1", "c3"},
        "c3": {"c2"},
        "c4": {"c1"},
    }
    assert longest_road_length(branched, set()) == 3
    assert longest_road_length(path, {"c2"}) == 2


def test_diagnosis_seeds_are_the_phase10_batch():
    assert DIAGNOSIS_SEEDS[0] == "ml-v6-strength-0"
    assert DIAGNOSIS_SEEDS[-1] == "ml-v6-strength-7"
    assert len(DIAGNOSIS_SEEDS) == 8


def test_opponent_building_breaks_the_route():
    observation = {
        "board": {
            "edges": [
                {"id": "e0", "corners": ["c0", "c1"]},
                {"id": "e1", "corners": ["c1", "c2"]},
                {"id": "e2", "corners": ["c2", "c3"]},
            ],
            "corners": [{"id": f"c{index}", "hex_ids": []} for index in range(4)],
            "hexes": [],
        },
        "placements": {
            "edges": [
                {"id": "e0", "owner": "c1"},
                {"id": "e1", "owner": "c1"},
                {"id": "e2", "owner": "c1"},
            ],
            "corners": [{"id": "c2", "owner": "c2", "piece": "settlement"}],
        },
    }
    assert road_length(observation, "c1") == 2
    assert road_length(observation, "c1", extra_edge="e0") == 2
