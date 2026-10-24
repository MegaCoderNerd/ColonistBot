# Research review for the offline learner

This note records what was read, what does not transfer to our rules, and which ideas this phase actually tests. None of these projects is evidence that a method will make a strong Colonist coach. No code was copied from the GPL repositories, and neither Catanatron nor AlgoCatan is imported by this application or the Firefox extension.

The clone used for the throughput check lives outside this repository, in a separate virtual environment. It is not a dependency.

## 1. Cross-dimensional networks

Source: Quentin Gendre and Tomoyuki Kaneko, “Playing Catan with Cross-dimensional Neural Network,” arXiv:2008.07079.

What they did:

- Two-player Catan, first to 10 victory points, no player-to-player trade. Development cards and bank trades are in the action space.
- The board is not a square image. Hexes, paths, and intersections are different kinds of cells. A plain convolutional net that treats them as one grid lagged the cross-dimensional net in their early curves.
- Spatial channels and scalar player features are processed side by side. Scalar values are inflated into channels, and channels are deflated to a mean and a variance, then added before the activation.
- Outputs are also split: spatial heads for roads, settlements, cities, and the robber, and a separate vector for dice, end turn, trades, discards, and development cards.
- Reward is terminal: +0.75 / −0.75 for win or loss, plus 0.02 times the victory-point difference. That second term is their design, not a result we are adopting in this phase.
- Training opponents are past copies of the learner, staggered so only one of 16 workers updates its opponent every 50 steps. An ablation against one fixed strong opponent learned more slowly and then played poorly against jsettler, an agent it had not trained against.
- They report about 56.5% wins for one 8-layer model against jsettler after a very large self-play run in their own engine. jsettler’s rules are not ours, and the run is not a result for this repository.

What we take from it, and what we do not:

- Keep spatial entities in separate tensors, and keep the player vector beside them. The candidate in `colonist_features_v3` does that with two rounds of message passing and a pooled board vector, instead of their brick-coordinate CNN.
- Score each legal candidate from the shared state, the action type, the entity that candidate touches, and the resource payload. We do not emit a free spatial map and then hope it is legal. The legal list stays authoritative.
- Diverse opponents matter, and a single frozen opponent is a poor training distribution. That informs the league design. It is not implemented as a training run here.
- Their victory-point-difference reward is a hypothesis for a later controlled experiment against our current terminal win or loss. It is not enabled.

## 2. BenjaminL1/catan_rl

Source: the repository README, `docs/1v1_rules.md`, and the architecture description there. The engine is adapted from another project. This review did not vendor that code.

Relevant design:

- A 1v1 Colonist-style environment with a tile encoder plus a graph encoder, a 512-wide trunk, and six masked action heads: type, corner, edge, tile, and two resources.
- Heuristic bootstrap, then a snapshot league. A heuristic-weight floor is there so self-play does not drop the baseline opponent.
- Opponent identity is an input. Hidden development-card types are an auxiliary belief target, not an observation.
- Rules are versioned. Their R0 and R1 epochs are not cross-compared. A checkpoint carries its epoch.

What does not transfer:

- Their win target is 15 victory points. Our published benchmark is 10. Those games are different lengths and are not one leaderboard.
- Their friendly-robber rule blocks a hex next to a player under 3 visible victory points. Our simulator uses the same numeric threshold (`friendlyRobberMinVisibleVp` 3). That part matches. Their dice do not: they use a 36-outcome bag, a noise swap, and a 20% forced 7. Our learner uses `balanced_24_of_36_shoe_approx`, with no karma 7.
- They track the opponent’s hand exactly because player trades are off and every resource change is public. Our observation still hides opponent resource types. Copying their hand tracker would change the information boundary.
- The six-head action space can name illegal pairs unless every conditional mask is right. Our measured failures were about ranking real legal roads, trades, and robber hexes, so this phase keeps the legal-candidate scorer and gives it a real entity embedding. A factorized head is not assumed to be better.
- Their trunk is about 1.5 million parameters and their PPO run is about 50 million steps. That scale is not this phase.

What we test: separate hex, vertex, and edge features; a shared state vector; candidate scoring that names the touched entity. What we record for later: snapshot league, baseline floor, rules-epoch stamps, and train/eval separation.

## 3. Catanatron

Sources: https://github.com/bcollazo/catanatron (README and `catanatron/catanatron/game.py`), https://docs.catanatron.com/, and the license file. The license is GPL-3.0. AlgoCatan extends this code and is also GPL-3.0.

The library can play games from Python, mask actions through the list of playable actions, and expose a Gymnasium environment (`catanatron/Catanatron-v0`) as an extra install. The CLI `catanatron-play` batches players. Defaults in `Game` are 10 victory points, discard at 7 cards, friendly robber off, up to 4 players, and a 1000-turn cap. Player-to-player trade offers exist. Map numbers have an official-spiral placement mode.

Those defaults are not the Colonist benchmark profile and not the live 1v1 profile. A faster simulator with different discard, robber, trade, dice, and player-count rules would not be a drop-in source of training rows. It could still host a separate pretraining experiment or a separate benchmark if a later phase writes an explicit profile and keeps those games out of the Colonist logs. This phase does not switch the live engine.

The Medium article linked from the Catanatron README (Bryan Collazo, “5 Ways NOT to Build a Catan AI”) returned 403 to a direct fetch. The public text of that article, plus the repository’s own benchmark notes, supports these lessons:

- Random-play supervised data and a flattened action space of thousands of ids produced policies that ended the turn. End turn is a large share of decisions.
- A hand-built value function beat random and weighted-random baselines. A shallow alpha-beta search on that value function was their strongest early result. Plain MCTS was slow, and high-branching spots (monopoly, late road building) dominated the time.
- Class imbalance and an action encoding that cannot tell two roads apart will look like a learning failure even when the update rule is fine.

That matches what this repository already measured: exact agreement was high on one-action decisions and on roll dice, and weak on which road, which bank trade, and which robber hex.

## 4. AlgoCatan

Source: https://github.com/AlgoCatan/RLCatan README, `src/rlcatan/training/league.py`, and `src/rlcatan/training/curriculum.py`. GPL-3.0, built on Catanatron. Not imported.

What is relevant as a design, not as a result:

- Elo league with persisted snapshots, a softmax over rating distance, and a fixed chance to face a value-function baseline and a random baseline (their sample defaults are about 20% value function and 5% random).
- Pruning that always keeps baselines, recent snapshots, and the highest-rated snapshots.
- Curriculum phases that lower the victory-point target and can disable action types until a metric clears a threshold. Their example phase uses 3 victory points and turns the robber and development cards off.
- Checkpoint-versus-checkpoint matches are a separate command from the training loop. Their sample commands also change victory points and discard limit between runs, which means those numbers are not one population.

We do not adopt a curriculum that deletes action types. The learner has to see roads, trades, and the robber. A lower victory-point target would also be a different rule profile from the 10-point benchmark. The Elo idea is used only as the later rating mechanism in the league proposal.

## 5. Rule profiles in this repository

Two profiles are explicit. Rows from one are not training data for the other.

`colonist_benchmark_1v1_v1` is the comparison profile already used by cross-play and by the phase-2 evaluation:

- 2 players, first to 10 victory points.
- Discard limit 9. Friendly robber on, and the concrete simulator’s threshold is `friendlyRobberMinVisibleVp` 3 (a player below 3 visible victory points is protected).
- Dice mode `balanced`, model `balanced_24_of_36_shoe_approx`.
- Domestic trades are not offered by the learner generator.
- Boards come from `buildGeneratedOpening`. That is not a Colonist map seed.
- The published horizon is 70 turns and 450 actions. A game that hits either limit is incomplete. It is not a loss.

`colonist_live_1v1_v1` is the coach default when a table does not send settings:

- `COLONIST_1V1_RULES` and the state reader default to 15 victory points, discard 9, friendly robber on.
- The same state reader sets the friendly-robber minimum to 3 even when the snapshot only sends a boolean. `rules.ts` names `friendlyRobberMaxVp: 2`, which is the same protection expressed as a maximum protected total, not a second threshold.
- The live decision path can see a table’s own `victoryPointsToWin` and discard limit. A 3- or 4-player table is a further profile. The current feature encoder keeps two opponent slots, and the learner games are created with `c1` and `c2` only.

Unresolved, and left unresolved on purpose:

- `COLONIST_1V1_RULES.hiddenBank` is true, while the concrete simulator’s default `hideBankCards` is false and the learner observation includes bank counts. A future live network would have to decide which of those is the table’s real information. This phase does not change the observation.
- Live games can contain player-to-player trade actions. The learner generator does not offer them. Those actions are not in the benchmark profile.
- `catan_rl`’s 15-point, karma-dice, perfect-hand setting is a third ruleset. It is not either profile above.

New heuristic exports stamp `simulator.rule_profile`. A 10-point export is the benchmark profile. A 15-point export is the live 1v1 profile. Anything else is named as a custom victory-point profile and is not pooled with the benchmark.

## 6. What this phase tests

Control: `colonist_features_v2`, the summary network. Its checkpoints stay loadable and are not treated as `colonist_features_v3`.

Candidate: `GraphPolicyValueNet`. Hex, vertex, and edge features are encoded separately. Two message-passing rounds update each from its neighbors. The player vector is concatenated with the mean of each entity type. A legal candidate is scored by a product of that state and a projection of the touched entity, the action type, and the give, receive, cost, and production payload. A summary observation with an empty board is rejected, so the graph path cannot silently train on zeros.

The comparison uses fresh seeds `ml-graph-train-0` and `ml-graph-val-0`. `ml-graph-final-0` and `ml-graph-final-1` are reserved and are not read. The earlier fidelity seeds are refused if they appear in this comparison. Both models see the same completed decisions, for 8 epochs, at batch size 32, seed 7. A third run uses the same graph architecture with stratified batches that round-robin action types without duplicating examples. Held-out metrics are on the natural validation games.

The imitation bars from the previous phase stay where they were: 0.90 top-1 on a 64-example overfit subset, and held-out top-1 of at least 0.40 and at least 0.20 above chance. They are diagnostics. Clearing them would not be a claim of stronger play.

## 7. League and reward proposal, not a run

`ml/colonist_ml/league.py` records the next training configuration and raises if something tries to start it.

- Initialize from a teacher-imitation checkpoint once a board-aware model has beaten the summary model on multi-action held-out decisions, including roads, bank trades, robber moves, and setup settlements. Until that happens, more PPO will train a policy that still does not name those actions.
- Opponents, in order: the baseline and the distance-only heuristic; then the wider heuristic pool; then frozen snapshots of the learner, at about half the launches, with the baseline still present.
- At least 25% of launches face `baseline_heuristic_v1` in every stage.
- A snapshot is stored every 25 completed games, capped at 8, and is not updated in place.
- Promotion uses repeated matched games, both seats, on development seeds, with at least 8 completed pairs and the same cutoff slack already used in phase 2. Held-out seeds do not choose the checkpoint.
- The objective stays the acting player’s terminal result on completed games. Cutoffs stay unlabeled. A victory-point-difference term, of the kind Gendre and Kaneko added, is a separate later experiment against this objective. It is not turned on here.

`RUN_AUTHORIZED` is false.

## 8. Licensing

Catanatron and AlgoCatan are GPL-3.0. Using them as a library inside this extension, or copying their engine into this repository, would make that code subject to GPL distribution terms. This phase reads them and, for Catanatron only, runs an isolated virtual environment outside the repo. No file from either project is added here. `catan_rl` was read as an architectural reference and was not copied. The Gendre and Kaneko paper is an arXiv preprint; their network was reimplemented only in the small form described above, not by importing their Rust engine.
