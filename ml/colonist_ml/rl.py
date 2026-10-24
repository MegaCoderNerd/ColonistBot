"""Self-play against the simulator bridge.

Incomplete games are stored and then left out of the gradient. Their outcome is
not a win or a loss. No value bootstrap is applied at a cutoff.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import torch
import torch.nn.functional as F

from .algorithm import label_decision, two_player_scores_sum_to_one
from .features import encode_observation
from .model import PolicyValueNet

TRAIN_SEEDS = ("ml-rl-0", "ml-rl-1", "ml-rl-2", "ml-rl-3")
EVAL_SEEDS = ("ml-holdout-0", "ml-holdout-1")


def seed_sets_are_disjoint() -> bool:
    return set(TRAIN_SEEDS).isdisjoint(EVAL_SEEDS)


def gradient_eligible(terminal: dict, decisions: list[dict]) -> bool:
    """Completed outcomes only. A cutoff is not a win, a loss, or a bootstrapped target."""
    if terminal.get("completion_status") != "completed" or not decisions:
        return False
    scores = terminal.get("actor_win") or {}
    return all(scores.get(decision["actor_id"]) is not None for decision in decisions)


def reinforce_loss(log_probs: list[torch.Tensor], values: list[torch.Tensor], entropies: list[torch.Tensor], actor_win: float) -> torch.Tensor:
    returns = torch.tensor([actor_win], dtype=torch.float32, device=log_probs[0].device)
    stacked_values = torch.stack(values)
    stacked_logs = torch.stack(log_probs)
    advantage = (returns - stacked_values.detach())
    policy = -(stacked_logs * advantage).mean()
    value = F.mse_loss(stacked_values, returns.expand_as(stacked_values))
    entropy = torch.stack(entropies).mean()
    return policy + 0.5 * value - 0.01 * entropy


class SimulatorBridge:
    def __init__(self, repo: Path):
        self.proc = subprocess.Popen(
            ["node", "scripts/ml-engine.mjs", "bridge"],
            cwd=str(repo),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def request(self, payload: dict) -> dict:
        if self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("bridge pipes are closed")
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            error = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"bridge closed: {error}")
        return json.loads(line)

    def close(self) -> None:
        if self.proc.poll() is not None:
            return
        if self.proc.stdin:
            try:
                self.proc.stdin.write(json.dumps({"cmd": "close"}) + "\n")
                self.proc.stdin.close()
            except OSError:
                pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)


def play_game(bridge: SimulatorBridge, model: PolicyValueNet, device: torch.device, start: dict, update: bool = False, optimizer: torch.optim.Optimizer | None = None, greedy: bool = False) -> dict:
    """Play one game. Gradients are not applied here.

    `update=True` is rejected so a caller cannot fall back to the one-game
    REINFORCE step. Terminal-return PPO consumes the returned rows.
    """
    if update or optimizer is not None:
        raise RuntimeError("Policy updates belong to the PPO experiment loop, not to a single game.")
    request = {"detail": "summary", **start, "cmd": "start"}
    reply = bridge.request(request)
    decisions = []
    model_was_training = model.training
    model.eval()
    try:
        while reply.get("type") == "decision":
            observation = reply["observation"]
            with torch.inference_mode():
                global_x, candidates, ids = encode_observation(observation, device)
                mask = torch.ones(1, candidates.size(0), dtype=torch.bool, device=device)
                logits, value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
                distribution = torch.distributions.Categorical(logits=logits)
                if greedy:
                    index = torch.argmax(logits, dim=-1)
                else:
                    index = distribution.sample()
                action_index = int(index.item())
                if action_index < 0 or action_index >= len(ids):
                    raise RuntimeError("policy index escaped the legal list")
                action_id = ids[action_index]
                old_log_prob = float(distribution.log_prob(index).reshape(-1)[0])
                old_value = float(value.reshape(-1)[0])
                entropy = float(distribution.entropy().reshape(-1)[0])
            decisions.append(
                {
                    "game_id": reply["game_id"],
                    "seed": start.get("seed"),
                    "decision_index": reply["decision_index"],
                    "actor_id": reply["actor_id"],
                    "learner": start.get("learner"),
                    "chosen_action_id": action_id,
                    "action_index": action_index,
                    "legal_count": len(ids),
                    "old_log_prob": old_log_prob,
                    "old_value": old_value,
                    "entropy": entropy,
                    "model_checkpoint": start.get("checkpoint"),
                    "opponent_policy": None if start.get("learner") == "both" else start.get("opponent"),
                    "generating_policy": "neural_self_play" if start.get("learner") == "both" else "neural_vs_opponent",
                    "observation": observation,
                }
            )
            reply = bridge.request({"cmd": "act", "action_id": action_id})
            if reply.get("type") == "error":
                raise RuntimeError(reply.get("message", "bridge error"))
    finally:
        model.train(model_was_training)
    if reply.get("type") != "terminal":
        raise RuntimeError(f"bridge returned {reply.get('type')}: {reply.get('message', '')}")
    if reply.get("completion_status") == "completed" and not two_player_scores_sum_to_one(reply.get("actor_win") or {}):
        raise RuntimeError("completed two-player scores do not sum to 1")
    labeled = [label_decision(decision, reply) for decision in decisions]
    return {"terminal": reply, "decisions": labeled, "updated": False}


def slim_game(game: dict) -> dict:
    decisions = []
    for decision in game["decisions"]:
        decisions.append({key: value for key, value in decision.items() if key != "observation"})
    return {"terminal": game["terminal"], "decisions": decisions, "updated": game.get("updated", False)}


def write_replay(path: str, games: list[dict]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        for game in games:
            handle.write(json.dumps(slim_game(game)) + "\n")
