# Phase 2 reinforcement learning

The live coach is unchanged. This run is offline.

## Algorithm

Terminal-return PPO (`terminal_return_ppo`).

A row exists only for an action the network sampled. Heuristic opponent actions are transitions. They are not optimal labels. Supervised cloning, when it runs first, is behavior cloning and is a separate loss.

For a completed game, every decision by seat `a` has return `G = actor_win[a]` in `{0, 0.5, 1}`. The loss reads that seat's score. It does not rewrite it as `1 - opponent`. In these two-player games the two scores sum to 1, including a draw. A cutoff has no return. Bootstrap from the value head is off: the value model is not accurate enough to turn a time limit into an outcome, and a bootstrapped target would be mixed with real terminals.

Advantage is `G - V_old`, using the value stored when the action was sampled. If the batch standard deviation is above `1e-6`, advantages are standardized once for that update, then reused for every minibatch. The clip is

`L_clip = -mean(min(ratio * A, clip(ratio, 1-ε, 1+ε) * A))`

with `ratio = exp(log π_new - log π_old)` and `ε = 0.2`. Value loss is mean squared error of the current value against `G`. Entropy is subtracted with coefficient `0.01`. Gradients are clipped at global norm `0.5`. Adam's learning rate is `3e-4`. Two epochs, minibatch 256.

The previous one-game REINFORCE step had the same terminal return and a negative gradient on the log probability of a winning action. It is still checked in the tests. It is not the trainer: one trajectory per step, with the two seats' losses added, moves the shared policy too far on a single result. The clip uses log probabilities the trajectories already store.

Legal actions are the candidate list. Padding positions are masked to `-1e9` before the softmax. A sample outside that list is a failure and is counted.

## Frozen data

| Set | Seeds | Use |
| --- | --- | --- |
| Training | `ml-rl-phase2-0` onward | PPO only |
| Heuristic demonstrations | `ml-rl-heuristic-0` … `7` | Behavior cloning before PPO |
| Development | `ml-rl-dev-0` … `15` | Checkpoint retention only |
| Final | `ml-rl-final-0` … `199` | Reported comparison, both seats |
| Diagnostic | `ml-cutoff-probe-0` … `3` | Cutoff measurement, not training |

Opponent cycle, eight launches: baseline as c1, baseline as c2, distance-only, aggressive dev, longest road, settlement racer, random legal, then the network on both seats. `production_aware_dev_card_v1` is not in the cycle.

Rules for the phase-2 run and the held-out games: first to 10 VP, 70 turns, 450 actions, balanced dice, no domestic trades, generated boards. The 3 VP / 20 turn command remains a technical smoke.

Budget, frozen from the throughput measurement: **500 completed training trajectories.** The launch ceiling is **4000**. A ceiling of 900, taken from two baseline games that both finished, was raised after the mixture's cutoff rate proved higher and the measured launch time stayed near 0.06 seconds. The raise happened before development or final evaluation. The completed-game target did not change. Updates occur every 8 completed games. Retention uses the development seeds only: keep the self-play checkpoint when the bootstrap interval of its pair score minus the supervised pair score lies above 0, at least 8 pairs exist, and its cutoff rate is at most 0.15 higher. Otherwise keep the supervised checkpoint. Final seeds do not change that choice.

Checkpoints are `checkpoints/step_XXXXXX.pt` plus `latest.pt`. A new step does not delete the previous file. A resumed PPO checkpoint restores weights, Adam state, the launch index, the step, and the torch RNG state.
