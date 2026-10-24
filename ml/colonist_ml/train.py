"""Supervised update on labeled synthetic examples.

Heuristic chosen actions are imitation targets only. They are not optimal labels.
Value loss uses actor_win only when the simulated game completed.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F

from .features import CANDIDATE_DIM, GLOBAL_DIM, encode_observation
from .model import PolicyValueNet


def collate(examples: list[dict], device: torch.device) -> dict[str, torch.Tensor]:
    width = max(len(example["observation"]["candidates"]) for example in examples)
    global_x = torch.zeros(len(examples), GLOBAL_DIM, device=device)
    candidates = torch.zeros(len(examples), width, CANDIDATE_DIM, device=device)
    mask = torch.zeros(len(examples), width, dtype=torch.bool, device=device)
    chosen = torch.zeros(len(examples), dtype=torch.long, device=device)
    wins = torch.zeros(len(examples), device=device)
    completed = torch.zeros(len(examples), dtype=torch.bool, device=device)
    for index, example in enumerate(examples):
        one_global, one_candidates, ids = encode_observation(example["observation"], device)
        global_x[index] = one_global
        count = one_candidates.size(0)
        candidates[index, :count] = one_candidates
        mask[index, :count] = True
        if example["chosen_action_id"] not in ids:
            raise ValueError("chosen action is not legal")
        chosen[index] = ids.index(example["chosen_action_id"])
        if example["completion_status"] == "completed" and example["actor_win"] is not None:
            completed[index] = True
            wins[index] = float(example["actor_win"])
    return {"global_x": global_x, "candidates": candidates, "mask": mask, "chosen": chosen, "wins": wins, "completed": completed}


def behavior_weights(examples: list[dict], cap: float = 5.0) -> list[float]:
    """Upweight rare action types. Mean weight is 1. This does not relabel the teacher."""
    from collections import Counter

    counts = Counter(str(example["chosen_action_id"]).split(":", 1)[0] for example in examples)
    raw = [min(cap, (len(examples) / counts[str(example["chosen_action_id"]).split(":", 1)[0]]) ** 0.5) for example in examples]
    mean = sum(raw) / len(raw)
    return [value / mean for value in raw]


def supervised_loss(logits: torch.Tensor, values: torch.Tensor, batch: dict[str, torch.Tensor]) -> tuple[torch.Tensor, dict[str, float]]:
    per_example = F.cross_entropy(logits, batch["chosen"], reduction="none")
    if "weight" in batch:
        policy = (per_example * batch["weight"]).sum() / batch["weight"].sum().clamp_min(1e-8)
    else:
        policy = per_example.mean()
    if bool(batch["completed"].any()):
        value = F.mse_loss(values[batch["completed"]], batch["wins"][batch["completed"]])
    else:
        value = values.sum() * 0.0
    loss = policy + value
    return loss, {"policy": float(policy.detach()), "value": float(value.detach()), "loss": float((policy + value).detach())}


def parameter_vector(model: PolicyValueNet) -> torch.Tensor:
    return torch.cat([parameter.detach().reshape(-1) for parameter in model.parameters()])


def stratified_examples(examples: list[dict], seed: int) -> list[dict]:
    """One pass that round-robins action types. Examples are not duplicated."""
    import random
    from collections import defaultdict

    buckets: dict[str, list[dict]] = defaultdict(list)
    for example in examples:
        buckets[str(example["chosen_action_id"]).split(":", 1)[0]].append(example)
    rng = random.Random(seed)
    for bucket in buckets.values():
        rng.shuffle(bucket)
    ordered: list[dict] = []
    while any(buckets.values()):
        for action_type in sorted(buckets):
            if buckets[action_type]:
                ordered.append(buckets[action_type].pop())
    return ordered


def train_steps(
    model: PolicyValueNet,
    optimizer: torch.optim.Optimizer,
    examples: list[dict],
    device: torch.device,
    epochs: int,
    batch_size: int = 16,
    weights: list[float] | None = None,
) -> dict[str, float]:
    if not examples:
        raise ValueError("no training examples")
    if weights is not None and len(weights) != len(examples):
        raise ValueError("weight list does not match the examples")
    last = {"policy": 0.0, "value": 0.0, "loss": 0.0}
    model.train()
    for _ in range(epochs):
        for start in range(0, len(examples), batch_size):
            batch_examples = examples[start : start + batch_size]
            batch = collate(batch_examples, device)
            if weights is not None:
                batch["weight"] = torch.tensor(weights[start : start + len(batch_examples)], dtype=torch.float32, device=device)
            optimizer.zero_grad(set_to_none=True)
            logits, values = model(batch["global_x"], batch["candidates"], batch["mask"])
            loss, last = supervised_loss(logits, values, batch)
            loss.backward()
            optimizer.step()
    return last


def score_candidates(model: PolicyValueNet, observation: dict, device: torch.device) -> list[tuple[str, float]]:
    """Legal candidates only, scored with the same encoder training uses."""
    model.eval()
    with torch.no_grad():
        global_x, candidates, ids = encode_observation(observation, device)
        if candidates.size(0) == 0:
            raise RuntimeError("policy has no legal action")
        mask = torch.ones(1, candidates.size(0), dtype=torch.bool, device=device)
        logits, _value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
        return [(action_id, float(logits[0, index].item())) for index, action_id in enumerate(ids)]


def predict_action(model: PolicyValueNet, observation: dict, device: torch.device) -> str:
    ranked = sorted(score_candidates(model, observation, device), key=lambda item: item[1], reverse=True)
    if not ranked:
        raise RuntimeError("policy has no legal action")
    return ranked[0][0]
