"""Terminal-return PPO for completed simulator games.

The behavior policy is the network. Only its actions are rows. A heuristic
opponent is part of the transition, not a labeled optimal action.

For a completed game the return of every decision by actor a is that actor's
own outcome G in {0, 0.5, 1}. It is not rewritten as 1 - opponent. A two-player
terminal happens to satisfy G_c1 + G_c2 = 1, including a 0.5/0.5 draw. The
loss does not depend on that identity, so a later player count can keep each
seat's own score.

Advantage is A = G - V_old, with V_old taken at sampling time and detached.
When the batch standard deviation is above 1e-6, A is standardized once for
the whole update. Standardization is a scale choice. It is not a terminal label
for a cutoff.

ratio = exp(log π_θ(a|s) - log π_old(a|s))
L_clip = -mean(min(ratio * A, clip(ratio, 1-ε, 1+ε) * A))
L_value = mean((V_θ(s) - G)^2)
L = L_clip + c_v * L_value - c_e * mean(entropy)

Cutoffs stay out of this loss. Time-limit bootstrapping is not used: an
untrained value would turn a truncation into a fake draw near 0.5, and that
target would be mixed with true outcomes. Rows marked bootstrap are rejected
while `allow_bootstrap` is false.

This replaces the one-game REINFORCE step. That step was a correct terminal
policy gradient, but one trajectory per update, with seat losses added rather
than averaged per decision, moves the policy too far on a single win or loss.
The clip uses the log probabilities these trajectories already store.
"""

from __future__ import annotations

import math
import random

import torch
import torch.nn.functional as F

from .features import CANDIDATE_DIM, GLOBAL_DIM, encode_observation

NEURAL_POLICIES = frozenset({"neural_vs_opponent", "neural_self_play"})
ALGORITHM_NAME = "terminal_return_ppo"
CLIP_EPS = 0.2
VALUE_COEF = 0.5
ENTROPY_COEF = 0.01
MAX_GRAD_NORM = 0.5
PPO_EPOCHS = 2
MINIBATCH_SIZE = 256
ADVANTAGE_STD_EPS = 1.0e-6


def two_player_scores_sum_to_one(actor_win: dict) -> bool:
    scores = [actor_win.get("c1"), actor_win.get("c2")]
    if any(score is None for score in scores):
        return False
    return abs(float(scores[0]) + float(scores[1]) - 1.0) < 1.0e-6


def label_decision(decision: dict, terminal: dict) -> dict:
    """Attach the acting seat's outcome. A cutoff clears it even if VP is nonzero."""
    completed = terminal.get("completion_status") == "completed"
    actor_id = decision["actor_id"]
    score = None
    if completed:
        score = (terminal.get("actor_win") or {}).get(actor_id)
    labeled = dict(decision)
    labeled["completion_status"] = terminal.get("completion_status")
    labeled["cutoff_reason"] = terminal.get("cutoff_reason")
    labeled["actor_win"] = score
    labeled["bootstrap"] = False
    labeled["target_provenance"] = "reinforcement_target" if score is not None else "synthetic_self_play"
    return labeled


def row_is_trainable(row: dict, allow_bootstrap: bool = False) -> bool:
    if row.get("generating_policy") not in NEURAL_POLICIES:
        return False
    if row.get("bootstrap") is True and not allow_bootstrap:
        return False
    if row.get("completion_status") != "completed":
        return False
    if row.get("actor_win") not in (0, 0.5, 1, 0.0, 1.0):
        return False
    return True


def advantages(returns: torch.Tensor, old_values: torch.Tensor) -> torch.Tensor:
    advantage = returns - old_values.detach()
    if advantage.numel() > 1:
        std = advantage.std(unbiased=False)
        if float(std) > ADVANTAGE_STD_EPS:
            advantage = (advantage - advantage.mean()) / std
    return advantage


def ppo_losses(
    new_log_prob: torch.Tensor,
    old_log_prob: torch.Tensor,
    entropy: torch.Tensor,
    values: torch.Tensor,
    returns: torch.Tensor,
    advantage: torch.Tensor,
    clip_eps: float = CLIP_EPS,
    value_coef: float = VALUE_COEF,
    entropy_coef: float = ENTROPY_COEF,
) -> tuple[torch.Tensor, dict[str, float]]:
    ratio = torch.exp(new_log_prob - old_log_prob.detach())
    unclipped = ratio * advantage.detach()
    clipped = torch.clamp(ratio, 1.0 - clip_eps, 1.0 + clip_eps) * advantage.detach()
    policy = -torch.min(unclipped, clipped).mean()
    value = F.mse_loss(values, returns.detach())
    entropy_mean = entropy.mean()
    total = policy + value_coef * value - entropy_coef * entropy_mean
    return total, {
        "policy": float(policy.detach()),
        "value": float(value.detach()),
        "entropy": float(entropy_mean.detach()),
        "loss": float(total.detach()),
        "ratio_mean": float(ratio.detach().mean()),
    }


def collate_trainable(rows: list[dict], device: torch.device) -> dict[str, torch.Tensor]:
    width = max(len(row["observation"]["candidates"]) for row in rows)
    count = len(rows)
    global_x = torch.zeros(count, GLOBAL_DIM, device=device)
    candidates = torch.zeros(count, width, CANDIDATE_DIM, device=device)
    mask = torch.zeros(count, width, dtype=torch.bool, device=device)
    chosen = torch.zeros(count, dtype=torch.long, device=device)
    returns = torch.zeros(count, device=device)
    old_log_prob = torch.zeros(count, device=device)
    old_values = torch.zeros(count, device=device)
    advantage = torch.zeros(count, device=device)
    for index, row in enumerate(rows):
        one_global, one_candidates, ids = encode_observation(row["observation"], device)
        global_x[index] = one_global
        width_i = one_candidates.size(0)
        candidates[index, :width_i] = one_candidates
        mask[index, :width_i] = True
        action_index = int(row["action_index"])
        if action_index < 0 or action_index >= len(ids):
            raise ValueError("action index is outside the legal list")
        chosen[index] = action_index
        returns[index] = float(row["actor_win"])
        old_log_prob[index] = float(row["old_log_prob"])
        old_values[index] = float(row["old_value"])
        advantage[index] = float(row["advantage"])
    return {
        "global_x": global_x,
        "candidates": candidates,
        "mask": mask,
        "chosen": chosen,
        "returns": returns,
        "old_log_prob": old_log_prob,
        "old_values": old_values,
        "advantage": advantage,
    }


def assign_batch_advantages(rows: list[dict]) -> None:
    returns = torch.tensor([float(row["actor_win"]) for row in rows], dtype=torch.float32)
    old_values = torch.tensor([float(row["old_value"]) for row in rows], dtype=torch.float32)
    assigned = advantages(returns, old_values)
    for row, value in zip(rows, assigned.tolist()):
        row["advantage"] = float(value)


def ppo_update(model, optimizer, rows: list[dict], device: torch.device, epochs: int = PPO_EPOCHS, minibatch_size: int = MINIBATCH_SIZE) -> dict[str, float]:
    if not rows:
        raise ValueError("PPO update received no trainable rows")
    assign_batch_advantages(rows)
    model.train()
    steps = 0
    last = {"policy": 0.0, "value": 0.0, "entropy": 0.0, "loss": 0.0, "ratio_mean": 1.0, "steps": 0, "decisions": len(rows)}
    for _epoch in range(epochs):
        order = torch.randperm(len(rows)).tolist()
        for start in range(0, len(rows), minibatch_size):
            chosen_rows = [rows[index] for index in order[start : start + minibatch_size]]
            batch = collate_trainable(chosen_rows, device)
            optimizer.zero_grad(set_to_none=True)
            logits, values = model(batch["global_x"], batch["candidates"], batch["mask"])
            distribution = torch.distributions.Categorical(logits=logits)
            new_log_prob = distribution.log_prob(batch["chosen"])
            loss, last = ppo_losses(
                new_log_prob,
                batch["old_log_prob"],
                distribution.entropy(),
                values,
                batch["returns"],
                batch["advantage"],
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), MAX_GRAD_NORM)
            optimizer.step()
            steps += 1
            last["steps"] = steps
            last["decisions"] = len(rows)
    return last


def bootstrap_mean(values: list[float], draws: int = 2000, seed: str = "ml-rl-phase2-bootstrap-v1") -> dict:
    """Percentile bootstrap of a mean. Same index rule as the race-tune interval, with this seed."""
    if not values:
        return {"n": 0, "mean": None, "low": None, "high": None}
    point = sum(values) / len(values)
    rng = random.Random(seed)
    samples = []
    width = len(values)
    for _ in range(draws):
        total = 0.0
        for _index in range(width):
            total += values[rng.randrange(width)]
        samples.append(total / width)
    samples.sort()
    low_index = max(0, math.ceil(0.025 * draws) - 1)
    high_index = min(draws - 1, math.floor(0.975 * draws))
    return {"n": width, "mean": point, "low": samples[low_index], "high": samples[high_index]}


def pair_scores(rows: list[dict]) -> dict[str, float | None]:
    """Mean of the two seat scores when both seats completed. A one-seat cutoff drops the pair."""
    by_seed: dict[str, dict[str, float]] = {}
    for row in rows:
        if row.get("completion_status") != "completed" or row.get("actor_win") is None:
            continue
        seat = row.get("learner")
        if seat not in ("c1", "c2"):
            continue
        by_seed.setdefault(row["seed"], {})[seat] = float(row["actor_win"])
    scores: dict[str, float | None] = {}
    for seed, seats in by_seed.items():
        scores[seed] = (seats["c1"] + seats["c2"]) / 2 if "c1" in seats and "c2" in seats else None
    return scores


def summarize_games(games: list[dict], gradient_steps: int, decisions_used: int) -> dict:
    reasons: dict[str, int] = {}
    eligible = 0
    completed = 0
    failures = 0
    for game in games:
        terminal = game["terminal"]
        status = terminal.get("completion_status")
        if status == "completed":
            completed += 1
            if game.get("decisions"):
                eligible += 1
        else:
            reason = terminal.get("cutoff_reason") or "unknown"
            reasons[reason] = reasons.get(reason, 0) + 1
            if reason not in ("max_turns_reached", "max_actions_reached"):
                failures += 1
    return {
        "launched": len(games),
        "completed": completed,
        "incomplete": len(games) - completed,
        "cutoffs_by_reason": reasons,
        "failures": failures,
        "eligible_for_updates": eligible,
        "gradient_steps": gradient_steps,
        "decisions_used": decisions_used,
    }
