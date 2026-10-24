"""Frozen phase-2 protocol.

Training seeds, development seeds, and final evaluation seeds are disjoint.
Diagnostic cutoff probes are disjoint from all three. The retention rule reads
only the development comparison. Final seeds are not an input to it.

The launch budget is filled in after a throughput measurement and before any
comparative outcome is used. `budget_frozen` stays false until that number is
written down.
"""

from __future__ import annotations

ALGORITHM = {
    "name": "terminal_return_ppo",
    "clip_eps": 0.2,
    "value_coef": 0.5,
    "entropy_coef": 0.01,
    "max_grad_norm": 0.5,
    "ppo_epochs": 2,
    "minibatch_size": 256,
    "learning_rate": 3.0e-4,
    "advantage": "terminal_return_minus_value_standardized_once_per_update",
    "gamma": 1.0,
    "bootstrap_cutoffs": False,
    "heuristic_actions_are_optimal": False,
}

EVAL_RULES = {"victory_points_to_win": 10, "max_turns": 70, "max_actions": 450}
DEV_SEED_COUNT = 16
FINAL_SEED_COUNT = 200
DIAGNOSTIC_SEED_COUNT = 4
SUPERVISED_EPOCHS = 2
UPDATE_EVERY_COMPLETED = 8
CUTOFF_SLACK = 0.15
MIN_PAIRS_TO_ADOPT = 8

DEV_SEEDS = tuple(f"ml-rl-dev-{index}" for index in range(DEV_SEED_COUNT))
FINAL_SEEDS = tuple(f"ml-rl-final-{index}" for index in range(FINAL_SEED_COUNT))
DIAGNOSTIC_SEEDS = tuple(f"ml-cutoff-probe-{index}" for index in range(DIAGNOSTIC_SEED_COUNT))
HEURISTIC_SEEDS = tuple(f"ml-rl-heuristic-{index}" for index in range(8))
TRAIN_PREFIX = "ml-rl-phase2-"
SMOKE_PREFIX = "ml-rl-smoke-"

# One self-play seat in eight. The other seven are distinct named policies,
# with the baseline on both seats. The experimental dev-card policy is absent.
OPPONENT_MIXTURE = (
    {"learner": "c1", "opponent": "baseline_heuristic_v1"},
    {"learner": "c2", "opponent": "baseline_heuristic_v1"},
    {"learner": "c1", "opponent": "baseline_distance_only_v1"},
    {"learner": "c2", "opponent": "aggressive_dev_heuristic_v1"},
    {"learner": "c1", "opponent": "longest_road_heuristic_v1"},
    {"learner": "c2", "opponent": "settlement_racer_v1"},
    {"learner": "c1", "opponent": "random_legal_diagnostic_v1"},
    {"learner": "both", "opponent": "neural_self_play"},
)

# The completed-trajectory target is 500. A first launch ceiling of 900 assumed
# the two baseline probe games were typical of the mixture. The mixture cuts off
# more often than that probe, at about 0.06 seconds per launch, so 500 completed
# games remain practical. The ceiling is 4000 launches. It was raised before
# development or final evaluation.
budget_frozen = True
COMPLETED_TARGET = 500
MAX_LAUNCHES = 4000


def reserved_seeds() -> set[str]:
    from .rl import EVAL_SEEDS, TRAIN_SEEDS

    return set(DEV_SEEDS) | set(FINAL_SEEDS) | set(DIAGNOSTIC_SEEDS) | set(HEURISTIC_SEEDS) | set(EVAL_SEEDS) | set(TRAIN_SEEDS)


def assert_launch_seed(seed: str, prefix: str) -> None:
    if seed in reserved_seeds() or not seed.startswith(prefix):
        raise ValueError(f"seed {seed} is outside the {prefix} training namespace")


def retention_decision(difference: dict, self_play_cutoff: float, supervised_cutoff: float) -> dict:
    """Keep self-play only when the development interval is above zero and cutoffs did not jump."""
    reasons = []
    low = difference.get("low")
    if difference.get("n", 0) < MIN_PAIRS_TO_ADOPT or low is None or low <= 0:
        reasons.append("development interval does not lie entirely above 0")
    if self_play_cutoff > supervised_cutoff + CUTOFF_SLACK:
        reasons.append("self-play cutoff rate exceeds the supervised checkpoint by more than 0.15")
    adopt = not reasons
    return {
        "retained": "self_play" if adopt else "supervised",
        "adopted_self_play": adopt,
        "reason": "development interval lies above 0 and the cutoff rate is within 0.15" if adopt else "; ".join(reasons),
    }
