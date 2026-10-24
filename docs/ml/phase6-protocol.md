# Phase 6 protocol

These rules were fixed before the phase-6 corpus was trained or scored. They are diagnostics. They do not authorize PPO, and they are not a playing-strength claim.

## Profile

Every row in this corpus uses `colonist_benchmark_1v1_v1`: 2 players, 10 victory points, discard at 9, friendly robber, the balanced 24-of-36 dice approximation, no domestic trades, the generated board, and a horizon of 70 turns or 450 actions. `colonist_live_1v1_v1` (15 victory points) is a different profile and is not mixed into these files. The published benchmark command is unchanged.

## Seeds and labels

- Training seeds: `ml-phase6-train-0` upward, until 100 completed games or 400 seeds.
- Validation seeds: `ml-phase6-val-0` upward, until 25 completed games or 400 seeds.
- Final seeds: `ml-phase6-final-0` upward, until 50 completed games or 400 seeds. They are not read until after the architecture choice.

Seat policies rotate through the existing heuristics, including the random diagnostic, and the seats swap on odd seeds. The action that was played keeps `generating_policy`. The imitation label is a separate call to `baseline_heuristic_v1` on that state. A move by another policy is not relabeled as a baseline move. Cutoff trajectories keep their decisions and have a null outcome. Heuristic labels are behavior, not optimal moves.

## Observation

`colonist_observation_v2` carries the live card counter. Opponent dev faces, the dev deck order, and future dice stay out. A bank object is present only when `bank_exact` is true. `colonist_features_v2` and `colonist_features_v3` checkpoints do not load as `colonist_features_v4` or `colonist_features_v5`.

## Coverage

A category is measured on a split only when that split has at least 40 baseline labels of that type. Below that, the category is unverified. Counted types: setup settlements, setup roads, paid roads, settlements, cities, bank trades, robber moves, discards, development-card purchases, and single-legal decisions. Single-legal decisions are reported separately from multi-legal decisions.

## Model choice

Train both models for 12 epochs, batch 64, Adam learning rate 0.001, torch seed 7. The 64-example subset fit still uses the existing 40-epoch bar of 0.90 top-1. That bar is not lowered.

On validation only, the graph model replaces the summary model when all of the following hold:

- Within-type agreement on paid roads, bank trades, robber moves, and setup settlements is each at least 0.05 above the summary model.
- Each of those four categories has at least 40 validation decisions.
- Multi-legal top-1 is not more than 0.01 below the summary model.
- The graph model emits no illegal action.

Otherwise the summary model stays. The final seeds are scored once, after that choice, and are not used to switch models or to change a threshold.

## What the scores allow

A retained model is a candidate for a later matched-play diagnostic only if, on the untouched final test, within-type top-1 is at least 0.35 on each of those four categories and each category has at least 40 decisions. Missing that bar means the representation or the labels are not yet enough for a strength experiment.

PPO stays unauthorized either way. Imitation of the baseline is not evidence that the learner plays better than the baseline.

## Results, recorded after the run

The thresholds above were not changed.

The corpus reached the completed-game targets: 100 training games (106 cut off, 37,493 decisions), 25 validation games (24 cut off, 8,759 decisions), and 50 final games (56 cut off, 19,161 decisions). Every counted category had at least 40 baseline labels on each split. About half of validation decisions were single-legal, and those were exact.

The 64-example subset fit reached top-1 0.56, below the unchanged 0.90 bar. Full training did not close that gap by memorizing the training games: summary top-1 was 0.84 on training and 0.85 on validation.

Validation kept the summary model. The graph model was higher on which road to rank inside the road candidates (0.47 against 0.38) and did not clear the 0.05 margin on robber hexes, bank trades, or setup settlements. It was also slower (369 seconds and 28,033 parameters against 70 seconds and 12,801) and worse at actually selecting a paid road (exact top-1 0.03 against 0.12).

On the untouched final test the summary model’s within-type scores were 0.41 roads, 0.38 bank trades, 0.69 robber placements, and 0.68 setup settlements. That meets the predeclared 0.35 bar, so a later matched-play diagnostic is allowed. Exact agreement on those same decisions was 0.14, 0.21, 0.69, and 0.68. Discards stayed at 0.12 exact. This is not a strength result, and PPO stays unauthorized.

