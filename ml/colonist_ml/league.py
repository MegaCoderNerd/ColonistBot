"""League design for a later self-play phase. Calling the runner raises.

The mixture below is a proposal, not an authorization to train. It keeps a
floor of games against the heuristic baseline, mixes frozen checkpoints, and
rates promotion on repeated matched games. Cutoff games stay unlabeled.
"""

from __future__ import annotations

RUN_AUTHORIZED = False
ALGORITHM = "terminal_return_ppo"
REWARD = "terminal_actor_win"
AUXILIARY_VP_DIFFERENTIAL = "not_enabled"

# Share of launches that must face the current heuristic baseline.
BASELINE_FLOOR = 0.25
# Frozen snapshots are added on a fixed schedule and never trained in place.
SNAPSHOT_EVERY_COMPLETED = 25
SNAPSHOT_POOL_LIMIT = 8
# Promotion requires this many completed matched pairs, both seats, on development seeds.
MIN_PAIRS_TO_PROMOTE = 8
# Held-out seeds are not used to choose the promoted checkpoint.
HOLDOUT_USED_FOR_PROMOTION = False

# Familiar opponents first. The baseline floor applies inside every stage.
STAGES = (
    {"name": "heuristic_bootstrap", "opponents": ("baseline_heuristic_v1", "baseline_distance_only_v1"), "snapshot_weight": 0.0},
    {"name": "mixed_heuristics", "opponents": ("baseline_heuristic_v1", "aggressive_dev_heuristic_v1", "settlement_racer_v1", "longest_road_heuristic_v1"), "snapshot_weight": 0.0},
    {"name": "snapshot_league", "opponents": ("baseline_heuristic_v1",), "snapshot_weight": 0.5},
)


def refuse_large_run() -> None:
    if not RUN_AUTHORIZED:
        raise RuntimeError(
            "The league configuration is a design record. Large PPO is not authorized, "
            "and cutoff games are not labeled as wins or losses."
        )
