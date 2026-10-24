# Phase 8 protocol

Written before any aggregated candidate was scored. The thresholds below stay fixed after the run.

Summary v4 remains the frozen generator (`ml/runs/phase6/summary_v4.pt`, `colonist_features_v4`, `colonist_observation_v2`). It is not updated. Graph v5 is not trained or promoted. The live coach and `baseline_heuristic_v1` stay as they are. PPO stays stopped. This phase does not run a matched-play batch.

## Seeds

| Split | Seeds | Role |
|---|---|---|
| Diagnosis | `ml-v4-match-0` … `ml-v4-match-199` | Score audit only. Not training or final-test evidence. |
| Timing | `ml-v4-agg-timing-0`, `ml-v4-agg-timing-1` | Runtime check. Excluded from train, validation, and final. |
| Train | `ml-v4-agg-train-0` … `ml-v4-agg-train-31` | Learner-state rows mixed into training. |
| Validation | `ml-v4-agg-val-0` … `ml-v4-agg-val-7` | Variant choice only. |
| Final | `ml-v4-agg-final-0` … `ml-v4-agg-final-7` | Read after the variant is frozen. |

Both seats are played on every seed. Profile `colonist_benchmark_1v1_v1`: 10 VP, discard at 9, friendly robber, balanced dice, no domestic trades, 70 turns, 450 actions.

## Labels and mixture

The frozen network chooses every learner action. `baseline_heuristic_v1` is queried on that state before the action is applied. The network’s own action is not the imitation target. Completed and cutoff games both contribute decisions. A cutoff stores `actor_win: null` and is not a value target.

Every original phase-6 training row and every new aggregated row is used once, at weight 1. Rows where the learner ends the turn and the teacher chooses a paid road or bank trade are flagged `diagnostic_slice` and are not duplicated or reweighted. That flag is an evaluation slice.

The candidate is a new network of the same summary architecture, initialized with torch seed 7, not a continuation of the frozen weights. Training is 12 epochs, batch 64, Adam learning rate 1e-3.

## Loss

The first candidate uses the existing unweighted cross-entropy.

A second candidate, `pairwise_endturn_margin_v1`, is trained only if the pre-audit rule fires: on phase-6 validation rows whose teacher action is a road or a bank trade and `endTurn` is legal, frozen v4 scores `endTurn` above the teacher on more than half of either group. The extra term is `relu(endTurn logit - teacher logit + 1)` on those teacher labels only. It is not a class weight on roads and it is not applied when the teacher chose `endTurn`.

Validation picks the variant. Ordinary wins if it meets the gate. Pairwise is selected only when ordinary misses the gate, pairwise meets it, and pairwise multi-legal top-1 is within 0.02 of ordinary. Otherwise the reported candidate stays ordinary. The final test is not used to choose.

## Action-selection gate

On the aggregated final test, against frozen v4 on the same rows:

- The end-turn-versus-road slice and the end-turn-versus-trade slice each have at least 40 rows.
- Exact teacher-road recovery on that road slice rises by at least 0.15 and reaches at least 0.25.
- Exact teacher-trade recovery on that trade slice rises by at least 0.10 and reaches at least 0.25.
- Natural-distribution top-1 and multi-legal top-1 each fall by at most 0.02.
- Illegal predictions stay at 0.
- Within-type agreement on roads, bank trades, robber moves, and setup settlements stays at least 0.35 where that category has at least 40 rows. The 0.35 bar is unchanged.
- Robber, setup-settlement, and discard top-1 each fall by at most 0.05 where the frozen model has at least 40 rows.
- The same 0.02 top-1 and multi-legal limits also apply on the existing phase-6 validation file, as a teacher-distribution control.

Meeting the gate preserves the candidate for a later match on fresh seeds. It does not claim playing strength. Missing the gate does not authorize another seed batch or PPO.

## Results, recorded after the run

Thresholds above were not changed.

The score audit authorized the pairwise variant: on phase-6 validation, frozen v4 scored `endTurn` above the teacher on 178/233 road rows (0.764) and 403/644 trade rows (0.626). On the `ml-v4-match-*` diagnosis replay, the same model scored `endTurn` above the teacher on all 2,108 end-turn-versus-road states and all 3,643 end-turn-versus-trade states. Median teacher-minus-endTurn margins were −2.59 and −1.56. Full candidate-feature aliases were 0. Of the skipped roads, 2,013 had settlement reach 0 and all 2,108 were affordable, with no settlement currently legal. 6,524 learner decisions agreed with an `endTurn` label.

Timing was 0.14 seconds per game, under the 3-second cap. Aggregation used 64 train games (5,955 decisions, 277 road disagreements, 689 trade disagreements, 23 completed), 16 validation games (1,443 decisions, 56 and 150 disagreements, 9 completed), and 16 final games (1,476 decisions, 101 and 192 disagreements, 5 completed). The mixture was 37,493 original rows plus 5,955 aggregated rows, each at weight 1.

Validation rejected both variants. Ordinary missed exact trade recovery 0.240, bank-trade within-type 0.329, and the phase-6 validation control. Pairwise was lower on natural top-1 (0.666 versus 0.694) and was not selected. The frozen comparison is ordinary cross-entropy.

On the final test the ordinary candidate did not meet the gate. Exact road recovery on the disagreement slice rose from 0 to 0.406. Exact trade recovery rose from 0 to 0.224, short of 0.25. Bank-trade within-type was 0.338, short of 0.35. Phase-6 validation top-1 moved from 0.846 to 0.804 and multi-legal top-1 from 0.670 to 0.580. No matched-play test is authorized. PPO stays stopped.
