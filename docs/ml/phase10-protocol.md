# Phase 10 protocol

Written before the matched-play batch was scored. The cutoffs below stay fixed after the run.

## Artifacts

- Candidate: `ml/runs/phase9/road_v6.pt`, `colonist_features_v6`, `colonist_observation_v2`, weight SHA-256 `371636b728ae6e9f40e840fcbc04bd2d2db35079b0f53bda4afab164dd078b9d`.
- Reference: `ml/runs/phase6/summary_v4.pt`, `colonist_features_v4`, `colonist_observation_v2`, weight SHA-256 `ed099144448aee98ba9d43b95fee2f6875aa8f4cb2ffc567b7d4d7c6abead710`.
- Opponent: `baseline_heuristic_v1`.

Each checkpoint is loaded with its own encoder. Weights are not updated. A hash or schema mismatch stops that evaluation.

## Seeds

`ml-v6-strength-0` through `ml-v6-strength-199`. Both seats. Both neural policies. 200 seeds, 400 games per policy, 800 games.

These seeds do not overlap `ml-v4-match-*`, `ml-v6-final-*`, `ml-phase6-*`, `ml-fidelity-*`, `ml-graph-*`, `ml-v4-agg-*`, `ml-rl-*`, or `ml-holdout-*`.

The board and development deck come from `deriveTrialSeed(seed, 0, "ml-synth")` and `deriveTrialSeed(trialSeed, 0, "deck")`. Dice, theft, and heuristic tie breaks start from `deriveTrialSeed(seed, 0, "ml-session")` with suffixes `rollout-dice`, `rollout-theft`, and `rollout-policy`. The teacher label uses `ml-teacher` and is not applied. Seat swaps and the two neural policies consume the heuristic stream on different turns, so they are not identical trajectories.

Rules stay `colonist_benchmark_1v1_v1`: 2 players, 10 VP, discard at 9, friendly robber, balanced dice, no domestic trades, 70 turns, 450 actions. Selection is greedy argmax over the legal list.

## Smoke

Seeds `ml-v6-strength-0` and `ml-v6-strength-1`, both seats, both checkpoints, run twice. The second run must reproduce completion, score, length, and the first chosen actions. Smoke does not change either model.

## Interpretation

A completed pair is the mean of the two seat scores. Win is 1, draw is 0.5, loss is 0. A cutoff is omitted from the pair. Fewer than 30 completed pairs is inconclusive. The bootstrap is the completed-pair score minus 0.5 and is conditional on finished pairs.

- Positive: at least 30 v6 pairs, the v6 interval lies entirely above 0, the v6 cutoff rate exceeds v4 by at most 0.05, and v6 mean completed VP is at least v4 mean completed VP minus 1.
- Negative: at least 30 v6 pairs and the v6 interval lies entirely below 0, or the v6 cutoff rate exceeds v4 by more than 0.05.
- Inconclusive: fewer than 30 pairs, or the interval includes 0 and the cutoff rate is not materially worse.

The v6-minus-v4 pair difference is reported only on seeds where both policies completed both seats. It is not a score against the heuristic. A positive result does not authorize PPO and does not establish professional strength.

## Results

Recorded after the batch. The rules above were not changed.

Both weight hashes matched before and after the run. Smoke on `ml-v6-strength-0` and `ml-v6-strength-1` repeated exactly. The full batch launched 400 games per policy. Neither policy produced an illegal action or a simulator failure. Every cutoff was `max_turns_reached`.

v6 completed 192 games and 51 pairs. Pair score 0.235, score minus 0.5 mean −0.265, interval [−0.343, −0.176]. Wins/losses among completed games were 37/155. Cutoff rate 0.520.

v4 completed 160 games and 39 pairs. Pair score 0.077, score minus 0.5 mean −0.423, interval [−0.474, −0.359]. Wins/losses were 10/150. Cutoff rate 0.600.

On the 21 seeds where both policies completed both seats, the v6 pair score exceeded v4 by 0.024, interval [0.000, 0.071].

The predeclared rule returns negative because the v6 interval lies entirely below an even result. v6 cut off less often than v4 and finished with more roads and settlements, and that was not enough to beat the heuristic. PPO stays unauthorized. A wider opponent pool is not justified.
