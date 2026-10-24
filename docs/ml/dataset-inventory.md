# Dataset inventory

No external Colonist game archive is a training source. The learner uses the repository simulator and hand-built fixtures only.

Downloaded Colonist games: **0**. Games approved for training: **0**. Verified-expert games in hand: **0**.

The machine-readable copy of this finding is `ml/sources/manifest.json`.

## Sources that were not used

| Source | What it claims | Decision |
| --- | --- | --- |
| OrgadYron/catan_43k_games_dataset and theocaplan-del/Catan-dataset | About 43,947 four-player Colonist games, with a download cited from Catan-data/dataset | Blocked. The cited release is not an available approved download. The repository copies that were inspected do not contain the game files. Colonist terms require the company's prior written permission before service data is used to train an AI model. Nothing was downloaded. |
| sousa16/catan-analyzer | Aggregates derived from the same Colonist corpus | Blocked. Not downloaded. |
| Kaggle PlayCatan "50 games" | 2014 post-game totals under a non-commercial license | Not usable for action-level training. Not downloaded. |
| bcollazo/catanatron | GPL-3.0 program that can emit heuristic games | Not vendored and not downloaded. Its output would be heuristic play, not human play. |
| Edinburgh CIG 2015 tournament write-up | 59 tournament games described in a paper | No game file was located. Not downloaded. |

A later request for written permission can proceed on its own. It does not gate synthetic self-play.

## Sources this learner does use

Every example records the generating policy, model checkpoint (or null), seed, game id, ruleset, player count, completion status, and target provenance.

1. **Synthetic fixtures** (`synthetic_fixture`). Hand-built states in `ml/fixtures/synthetic_decisions.jsonl`. They check schema, masking, and the loss. They are not evidence of strategic skill.
2. **Heuristic demonstrations** (`heuristic_demonstration`). Actions chosen by named policies in `POLICY_POOL`, including `baseline_heuristic_v1`. The chosen action is that policy's behavior. It is not a ground-truth optimal move.
3. **Synthetic self-play** (`synthetic_self_play`). Games in which the current network plays one or both seats through the simulator bridge. A game that hits the turn or action limit stays incomplete.
4. **Reinforcement targets** (`reinforcement_target`). The acting player's outcome on a completed game: 1 win, 0.5 draw, 0 loss. Cutoffs are stored as self-play records and are excluded from the gradient. No bootstrap value is written at a cutoff.
5. **Search targets** (`search_target`). Reserved. No search algorithm is implemented, so this provenance is not produced.

## Simulator limits that travel with the data

The generator records these on each heuristic example:

- Domestic trades are not offered.
- Dice mode is `balanced`, using the engine's approximate 24-of-36 shoe, not an exact claim about Colonist dice.
- Boards come from `buildGeneratedOpening`. They are not Colonist map seeds.
- The smoke uses a victory-point target and turn limit that are shorter than the 10-point, 70-turn cross-play benchmark. Counts from the smoke are not 10-point strength.
- A game that stops for `max_turns_reached` or `max_actions_reached` has `actor_win: null`. That is not a loss.

The opponent pool is `baseline_heuristic_v1`, `baseline_distance_only_v1`, `aggressive_dev_heuristic_v1`, `longest_road_heuristic_v1`, `settlement_racer_v1`, and `random_legal_diagnostic_v1`. `random_legal_diagnostic_v1` is a diagnostic opponent, not a teacher of good play. `production_aware_dev_card_v1` is an unadopted experiment and is not in the pool.

Held-out seeds are `ml-holdout-0` and `ml-holdout-1`. Self-play seeds are `ml-rl-0` through `ml-rl-3`. Training refuses a file that contains a held-out seed.
