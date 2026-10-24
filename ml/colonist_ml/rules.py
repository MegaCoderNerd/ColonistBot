"""Rule profiles for the offline learner.

Records from different profiles are not pooled. The benchmark profile is the
one used by the existing cross-play comparison. The live 1v1 profile is the
coach's default when a table does not send its own settings. A 3- or 4-player
table is a different profile and is not represented here.
"""

from __future__ import annotations

BENCHMARK_PROFILE = "colonist_benchmark_1v1_v1"
LIVE_1V1_PROFILE = "colonist_live_1v1_v1"

# Seeds already used to inspect imitation. They are not final evidence for a new model.
INSPECTED_FIDELITY_SEEDS = frozenset(
    {
        "ml-fidelity-fit-0",
        "ml-fidelity-fit-1",
        "ml-fidelity-holdout-0",
        "ml-fidelity-holdout-1",
        "ml-fidelity-trace-0",
    }
)

# Held out from architecture choices in this phase. Do not train or validate on them.
GRAPH_FINAL_SEEDS = ("ml-graph-final-0", "ml-graph-final-1")
GRAPH_TRAIN_SEEDS = ("ml-graph-train-0",)
GRAPH_VAL_SEEDS = ("ml-graph-val-0",)

PROFILES = {
    BENCHMARK_PROFILE: {
        "players": 2,
        "victory_points_to_win": 10,
        "discard_limit": 9,
        "friendly_robber": True,
        "friendly_robber_min_visible_vp": 3,
        "dice_model": "balanced_24_of_36_shoe_approx",
        "domestic_trades": "not_offered",
        "board": "generated_opening_not_colonist_map_seed",
        "horizon_turns": 70,
        "horizon_actions": 450,
        "comparable_with_previous_benchmark": True,
    },
    LIVE_1V1_PROFILE: {
        "players": 2,
        "victory_points_to_win": 15,
        "discard_limit": 9,
        "friendly_robber": True,
        "friendly_robber_min_visible_vp": 3,
        "dice_model": "balanced_24_of_36_shoe_approx",
        "domestic_trades": "not_offered_by_the_learner_generator",
        "board": "table_or_generated",
        "horizon_turns": None,
        "horizon_actions": None,
        "comparable_with_previous_benchmark": False,
    },
}


def assert_comparison_seeds(examples: list[dict], allowed: frozenset[str]) -> None:
    seeds = {example["seed"] for example in examples}
    if not seeds:
        raise RuntimeError("no examples")
    if not seeds <= allowed:
        raise RuntimeError(f"unexpected seeds {sorted(seeds - allowed)}")
    banned = seeds & (INSPECTED_FIDELITY_SEEDS | set(GRAPH_FINAL_SEEDS))
    if banned:
        raise RuntimeError(f"refusing inspected or final seeds {sorted(banned)}")
