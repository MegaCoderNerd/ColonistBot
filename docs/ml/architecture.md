# Offline learner

The live coach is unchanged. `baseline_heuristic_v1` remains the default benchmark policy. The network is a Python program. The Firefox extension does not import it, and nothing in this path enables autoplay.

## What a decision contains

`colonist_observation_v2` (`src/analyzer/ml/observation.ts`) is built from the concrete simulator at the moment a player must act. Resource counts come from the same card counter the live coach uses (`HandTracker`). The actor's own hand is the cards that player can see. Opponent counts are the named transfers the counter has followed. The bank is 19 minus those holdings when every count is exact, and it is omitted when a transfer was missed or unnamed. The summary control that reads this vector is `colonist_features_v4`. `colonist_features_v2` remains loadable and does not accept a v4 checkpoint.

Included: public board ids, resources, numbers, ports, ownership, the robber, the actor's own hand and dev cards, tracked opponent resource counts and their exactness, the derived bank when it is exact, and each opponent's public victory points, hand size, buildings, road length, and knights.

Omitted: opponent dev-card faces, `devDeckOrder`, future dice, and the simulator's bank or opponent hand when the counter cannot derive them. `observationLeaks` rejects an opponent `hand` and a bank object whose exactness flag is false.

Legal actions keep the simulator's own action objects and a stable `action_id`. The network scores that list. It cannot emit an edge that is absent from the list. Illegal logits are set to `-1e9` before the softmax.

## Model

`PolicyValueNet` (`colonist_features_v2`, hidden width 64) remains a loadable control for the previous observation. The phase-6 summary model is the same product scorer on `colonist_features_v4`, which adds the counter's opponent resources and a bank-exactness flag. `GraphPolicyValueNet` (`colonist_features_v3`) remains loadable. The phase-6 board model is `colonist_features_v5`: the same message passing, plus the v4 resource features. A checkpoint loads only into the schema named in its file.

- A global vector summarizes phase, the actor's hand, dev cards, and public production, the bank, the robber's resource, and up to two opponents' public stats.
- Each candidate carries its action type, board index, pip totals, per-resource pips, port, whether it touches that player's network, and the give, receive, and resource cost. Setup actions keep a zero cost, so they are not the same input as a paid build.
- The score is a product of the state embedding and a linear projection of that candidate. A linear layer on the concatenated pair cannot change its ranking when the state changes, because the state term is added to every candidate. Checkpoints tagged `colonist_features_v1` do not load into this model.
- A value head estimates the acting player's outcome in `(0, 1)`.

The v2 vector does not read the raw graph. It uses the public candidate features computed in TypeScript. The v3 model reads the hex, corner, and edge lists on a full observation and rejects a summary that has dropped them. Hidden width stays 64 in both. That is a capacity limit, not a claim that either summary is enough for strong play.

The v4 summary vector adds the counter's opponent resources and a flag for whether the bank was derived. A named steal updates those counts. An unnamed steal sets the exactness flag off and does not copy the simulator hand. Dev-card faces and the deck order stay inside the simulator. The bridge sends the learner only its own observation.

## Losses

Supervised training imitates the recorded `chosen_action_id` with a masked cross-entropy. When the generating policy is a heuristic, that target is behavioral cloning. The value term is mean squared error against `actor_win`, and only for rows whose `completion_status` is `completed`. Incomplete rows contribute no value gradient.

Self-play uses a completed-game return. For each acting player, the loss is a policy gradient on `(return - value)` plus a value loss and a small entropy bonus (coefficient 0.01). If the game is incomplete, the trajectory is written to the replay file and the gradient is skipped. There is no bootstrapped cutoff target.

Search-generated policy distributions are not part of this loop. Add them only with a documented search, under `search_target`.

## Processes

`scripts/ml-engine.mjs` bundles `src/analyzer/ml/cli.ts` with esbuild, the same way the benchmark CLI is bundled. That bundle is not the extension.

- `export` writes JSONL heuristic demonstrations.
- `bridge` reads one JSON command per line and writes one JSON reply per line. `start` opens a game. Opponent turns are applied inside the process. `act` applies one legal learner action. `terminal` reports `completion_status` and `actor_win` for each seat. A cutoff leaves those scores null.

Checkpoints (`colonist_checkpoint_v1`) store the schema version, feature version, weights, Adam state, epoch, seed, and a manifest summary. Resume loads the optimizer and continues. Checkpoints are gitignored.

## Evaluation

Held-out seeds are disjoint from self-play seeds. Evaluation plays the greedy network against `baseline_heuristic_v1` from both seats. Only completed games enter the mean score. The report sets `demonstrated_improvement` only when at least four completed games have a mean actor score above 0.5. Until that happens, the network stays offline.

## Integrity

Race weights stay 12 / 1.5 / 1.5. The production-aware dev-card rule stays opt-in and is not a training teacher. Shadow rollout stays off unless the existing option enables it. New modules under `src/analyzer/ml` are reached from the engine script and from tests, not from `helper.ts`, `decide.ts`, or `shadow.ts`.
