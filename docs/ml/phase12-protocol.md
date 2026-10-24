# Phase 12 protocol

Written before the v7 candidate was scored. The decision rule below stays fixed.

## Intervention

Schema `colonist_features_v7`. v4 and v6 encoders, race weights, the live coach, and `baseline_heuristic_v1` stay as they are.

The summary vector keeps its v4 order and appends two public numbers:

- the acting player's current road length, divided by 15
- 1 when that player holds Longest Road, otherwise 0

Every legal road, free road, and setup road appends seven numbers after the eight v6 expansion features:

- current length / 15
- length after this road / 15
- difference / 15
- gain, retain, lose, otherwise

Exactly one of those four flags is 1 on a road. A non-road is zeros. Lengths use `computeRoadLengthOnTopology`. The award uses the same rule as `updateLongestRoadAward`: minimum 5, the incumbent keeps a tie, and a tie among challengers leaves the award unclaimed. The hypothetical placement copies the edge owners and does not write back to the live state.

v7 is initialized from frozen `road_v6.pt`. The new columns start at zero, so scores match v6 before training. Training is ordinary unweighted cross-entropy on the phase-6 teacher rows and the phase-8 aggregation seeds, with value loss only on completed games. The stored aggregation file is a summary and has no board, so those 32 seeds were replayed with the frozen v4 policy and the board kept in `data/ml/generated/agg_train_v7.jsonl`. That replay has the same 5,955 decisions. `agg_train.jsonl` was not overwritten. `ml-v6-strength-*` and `ml-v7-strength-*` are not training rows.

## Acceptance

Fresh seeds `ml-v7-strength-0` through `ml-v7-strength-199`, both seats, `colonist_benchmark_1v1_v1`. Play frozen v7 and frozen v6 against `baseline_heuristic_v1` on those seeds. Cutoffs are not wins or losses. Fewer than 30 completed pairs is inconclusive.

- Positive: v7's completed-pair interval lies entirely above an even score, its cutoff rate exceeds v6's on these seeds by at most 0.05, and completed mean VP is at least v6's completed mean VP minus 1.
- Negative: the interval lies entirely below an even score, or the cutoff rate exceeds v6 by more than 0.05.
- Inconclusive: any other result, including an interval that includes an even score.

Report road length, Longest Road, settlements, cities, VP margin, and the v7-minus-v6 pair difference on seeds where both policies completed both seats. A positive result still does not authorize a large PPO run or a four-player model.

## Result

The rule above was not changed after the match.

v7 weight SHA-256 is `b5e9deb59b1647860a3fcecdc6f6ce46fd46ed848a20035945e42fe6fc2e336d`. Frozen v4 remained `ed099144448aee98ba9d43b95fee2f6875aa8f4cb2ffc567b7d4d7c6abead710`. Frozen v6 remained `371636b728ae6e9f40e840fcbc04bd2d2db35079b0f53bda4afab164dd078b9d`.

800 games, 0 illegal actions, 0 simulator failures. v7 completed 183 and cut off 217 (rate 0.5425). v6 completed 178 and cut off 222 (rate 0.555). Completed pairs: v7 52, v6 41. v7 pair score 0.337, interval of (score − 0.5) [−0.231, −0.096]. v6 pair score 0.207, interval [−0.378, −0.207].

Decision: negative. The v7 interval lies entirely below an even score. The cutoff rate is not worse than v6.

On the 24 seeds where both policies completed both seats, v7 minus v6 averaged +0.125 with interval [0.021, 0.250]. That is a comparison between the two networks, not a win against the heuristic. Longest Road was more common for v7 than for v6, and the completed games were still losses on average. No RL pilot was started.
