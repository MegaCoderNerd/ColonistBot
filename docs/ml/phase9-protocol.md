# Phase 9 protocol

Written before the v6 candidate was scored. Thresholds below stay fixed after the run.

## Settlement reach

`minAdditionalRoadsToOpenSettlementFromEdge` is the baseline's after-placement distance. It pretends the candidate edge belongs to the acting player and searches from that edge's two endpoints. A distance of 0 means an endpoint is empty and no adjacent corner has a building. It does not mean a settlement can be bought, and it does not look at settlements remaining. Owned edges cost 0. Empty edges cost 1. Opponent-owned edges are blocked. The search does not expand through an opponent building. The depth cap is 3. 99 means no distance-open corner was found within the cap.

`settlementReachFromNetwork` is the before-placement distance. It starts at corners the player occupies and at corners that already touch the player's roads, with the same blocking rules and the same cap. 0 means a distance-open corner already touches that network.

`reach_delta` is before minus after when both values are inside the cap, and 0 otherwise. A positive delta means this road shortens the capped distance.

`opens_settlement` and `newly_opened` count endpoints that are distance-open and do not already touch the player's road. That is a new connection created by this edge. It is not affordability. The acting player's hand and the settlement cost stay in the existing global and cost features.

`connects_network` is the existing legal-road rule: the edge touches the player's building, or an empty corner that already touches the player's road. An opponent building on that corner blocks the connection.

These facts use the public board only. They are computed for every legal road, free road, and setup road. Non-roads are stored as zeros, so a zero known-flag is not coded as reach 0. The teacher action is not an input.

`colonist_observation_v2` stays the observation schema. The new numbers are optional public candidate fields. `colonist_features_v4` does not read them.

## Candidate

- Schema: `colonist_features_v6`.
- Architecture: the v4 summary network. Global width stays 75. Eight road features are appended to each candidate.
- Initialization: copy `summary_v4.pt` and set the eight new columns to zero, so scores match v4 at step 0. The Phase 8 ordinary candidate is a comparison model only. Its phase-6 validation top-1 is 0.804, already under the regression guard, so it is not the initial weights.
- Loss: unweighted cross-entropy on `baseline_heuristic_v1`, plus value loss only on completed games. No extra end-turn penalty.
- Optimizer: Adam, learning rate 1e-3. Torch seed 7 after the weight copy. 12 epochs, batch 64.
- Data: the phase-6 training corpus, re-encoded from its public board, plus the phase-8 aggregation-training seeds `ml-v4-agg-train-0` through `ml-v4-agg-train-31`, regenerated with the frozen v4 policy so the same trajectories carry the new fields. Each row once, weight 1.
- Fresh final trajectories: `ml-v6-final-0` through `ml-v6-final-7`, both seats, profile `colonist_benchmark_1v1_v1`. Not used to choose the candidate. Phase 8 final seeds are not reused. Phase-6 validation is only the regression guard.

## Gate

On the fresh final trajectories, for the v6 candidate:

- Teacher-road exact top-1 at least 0.35, with at least 40 rows.
- End-turn-versus-road exact recovery at least 0.35, with at least 40 rows.
- End-turn-versus-trade exact recovery at least 0.25, with at least 40 rows.
- Bank-trade within-type at least 0.35, with at least 40 rows.
- No illegal predictions.

On phase-6 validation:

- Top-1 at least 0.826.
- Multi-legal top-1 at least 0.650.

Report v4 and the Phase 8 ordinary candidate on the same final rows. Meeting the gate does not establish playing strength. Missing it does not authorize matched play or PPO.

## Results

Recorded after the single training run. The thresholds above were not changed.

Checkpoint `ml/runs/phase9/road_v6.pt`, schema `colonist_features_v6`, candidate width 65. Weight SHA-256, using the same parameter hash as the frozen v4 reference: `371636b728ae6e9f40e840fcbc04bd2d2db35079b0f53bda4afab164dd078b9d`. The frozen v4 weight hash remains `ed099144448aee98ba9d43b95fee2f6875aa8f4cb2ffc567b7d4d7c6abead710`.

Training used 37,493 phase-6 rows plus 5,955 regenerated aggregation-training rows. It took 141.6 seconds. The fresh final set is `ml-v6-final-0` through `ml-v6-final-7`, 16 games, 5 completed, 1,539 decisions. Phase-6 validation remained the regression guard (8,759 decisions).

The predeclared gate is met: teacher-road exact 0.396 (n=106), end-turn-versus-road exact 0.434 (n=83), end-turn-versus-trade exact 0.430 (n=121), bank-trade within-type 0.524 (n=227), illegal predictions 0, phase-6 top-1 0.841, phase-6 multi-legal 0.659. Setup settlement (n=32) and discard (n=17) stay unmeasured.

This is an action-selection result. It does not establish playing strength. A later phase may run matched play on seeds that are not `ml-v6-final-*`. PPO stays unauthorized.
