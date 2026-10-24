# Phase 11 protocol

Written after the diagnostic replay and before any new candidate is trained. The acceptance numbers below stay fixed.

## Failure mechanism

v6 builds the city or settlement whenever that action is already legal. On the diagnostic replay it skipped neither. The settlements it places are the highest-pip legal spot, and production rises by about six pips. The extra roads usually open a distance-legal corner. That corner is not, by itself, a settlement: the distance rule does not check the remaining settlement pieces or the settlement cost. In 26 of 28 opening roads the settlement was still unaffordable after the road was paid for. Those spots were settled later.

The victories do not follow. Across the Phase 10 match the learner's longest route stays near 3 roads while about five road pieces are on the board. Longest Road is held in about 6 percent of completed games. On the diagnostic replay of `ml-v6-strength-0` through `ml-v6-strength-7`, completed games end at length 2.5 against the heuristic's 4.5. The heuristic holds Longest Road in 5 of those 8 completed games. The learner holds it in none. The completed VP margin is −2, the value of that award.

The summary vector stores the opponent's road length and Longest Road flag. It does not store the actor's road length or award. A road candidate stores settlement reach, not the change in `computeRoadLengthOnTopology`. Fourteen of 31 paid roads had another legal road with a larger length gain.

No simulator defect showed up. The skipped roads and the later dev-card buys were legal. A distance-open corner was not counted as a placed settlement.

## One intervention

Schema `colonist_features_v7`. Do not change the v4 or v6 encoders, the race weights, or the live coach.

Stamp three public numbers on every legal road, free road, and setup road, using the engine's longest-road walk:

- The actor's current road length.
- The length gain from adding that road.
- Whether that road would take or keep Longest Road against the opponent's current length.

Non-roads get zeros. Also stamp the actor's road length and Longest Road flag on the actor. Both facts are public. Summary observations must keep them, because the summary wire drops the board. v6 must ignore the new fields.

Initialize the new columns at zero from `road_v6.pt` when the extra inputs are appended. Train one ordinary cross-entropy candidate on the phase-6 corpus and the phase-8 aggregation-training seeds, re-encoded with the new fields. Do not use `ml-v6-strength-*` as training or test data.

## Acceptance

Fresh seeds `ml-v7-strength-0` through `ml-v7-strength-199`, both seats, `colonist_benchmark_1v1_v1`. Play frozen v7 and frozen v6 against `baseline_heuristic_v1` on those same seeds. Cutoffs are not wins or losses. Fewer than 30 completed pairs is inconclusive.

- Positive: v7's completed-pair interval lies entirely above an even score, and its cutoff rate exceeds v6's cutoff rate on these seeds by at most 0.05.
- Negative: the interval lies entirely below an even score, or the cutoff rate exceeds v6 by more than 0.05.
- Inconclusive: the interval includes an even score and the cutoff rate is not materially worse.

Report road length, Longest Road, settlements, cities, VP margin, and the v7-minus-v6 pair difference on seeds where both policies completed both seats. A positive result still does not authorize PPO or a four-player model.

This phase does not train v7 and does not run that match.
