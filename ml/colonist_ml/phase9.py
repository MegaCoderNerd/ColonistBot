"""Phase 9 road-expansion candidate.

The acceptance numbers were fixed before this candidate was scored.
colonist_features_v4 stays loadable. This candidate does not overwrite it.
"""

from __future__ import annotations

import time

import torch

from .coverage import PHASE6_BATCH, PHASE6_EPOCHS
from .features import CANDIDATE_DIM
from .model import PolicyValueNet
from .roads import ROAD_EXPANSION_DIM, ensure_road_features
from .tracked import FEATURE_VERSION_V4, FEATURE_VERSION_V6, GLOBAL_DIM_V4
from .train import supervised_loss

# Written before the phase-9 candidate was scored. Do not lower these.
ROAD_EXACT_MIN = 0.35
TRADE_EXACT_MIN = 0.25
TRADE_WITHIN_MIN = 0.35
PHASE6_TOP1_MIN = 0.826
PHASE6_MULTI_MIN = 0.650
MEASURED_MIN = 40
FINAL_SEED_COUNT = 8
FINAL_SEEDS = tuple(f"ml-v6-final-{index}" for index in range(FINAL_SEED_COUNT))
CANDIDATE_DIM_V6 = CANDIDATE_DIM + ROAD_EXPANSION_DIM
EPOCHS = PHASE6_EPOCHS
BATCH = PHASE6_BATCH
LEARNING_RATE = 1e-3
TORCH_SEED = 7


def assert_final_seeds(seeds: tuple[str, ...] | list[str]) -> None:
    allowed = set(FINAL_SEEDS)
    banned = (
        "ml-v4-match-",
        "ml-v4-agg-",
        "ml-phase6-",
        "ml-fidelity-",
        "ml-graph-",
        "ml-rl-",
        "ml-holdout-",
    )
    for seed in seeds:
        if seed not in allowed:
            raise RuntimeError(f"seed {seed} is outside ml-v6-final")
        if any(seed.startswith(prefix) for prefix in banned):
            raise RuntimeError(f"seed {seed} reuses an earlier split")


def transfer_v4_weights(source: PolicyValueNet, target: PolicyValueNet) -> None:
    """Copy v4 weights and zero the new road-feature columns.

    The product scorer then matches v4 until training moves those columns.
    Phase 8 ordinary is not the source: its phase-6 validation top-1 is already
    below the 0.826 regression guard.
    """
    if source.feature_version != FEATURE_VERSION_V4 or target.feature_version != FEATURE_VERSION_V6:
        raise RuntimeError("transfer is from colonist_features_v4 to colonist_features_v6 only")
    if source.candidate_encoder.weight.shape[1] + ROAD_EXPANSION_DIM != target.candidate_encoder.weight.shape[1]:
        raise RuntimeError("candidate widths are not a v4 tail plus the road expansion block")
    target.encoder.load_state_dict(source.encoder.state_dict())
    target.value_head.load_state_dict(source.value_head.state_dict())
    with torch.no_grad():
        target.candidate_encoder.weight.zero_()
        target.candidate_encoder.weight[:, : source.candidate_encoder.weight.shape[1]] = source.candidate_encoder.weight
        target.candidate_encoder.bias.copy_(source.candidate_encoder.bias)


def prepare_examples(examples: list[dict]) -> list[dict]:
    prepared = []
    for example in examples:
        copied = dict(example)
        observation = dict(example["observation"])
        observation["candidates"] = [dict(candidate) for candidate in example["observation"]["candidates"]]
        copied["observation"] = ensure_road_features(observation)
        prepared.append(copied)
    return prepared


def _collate(examples: list[dict], device: torch.device) -> dict:
    from .coverage import _collate_v4
    from .roads import encode_observation_v6

    # Reuse the v4 collation bookkeeping, then replace the candidate tensor.
    batch = _collate_v4(examples, device)
    width = CANDIDATE_DIM_V6
    candidates = torch.zeros(len(examples), batch["candidates"].shape[1], width, device=device)
    for index, example in enumerate(examples):
        _global_x, one, _ids = encode_observation_v6(example["observation"], device)
        count = one.size(0)
        candidates[index, :count] = one
        if one.size(1) != width:
            raise RuntimeError("v6 candidate width drifted")
    batch["candidates"] = candidates
    return batch


def train_v6(examples: list[dict], source: PolicyValueNet, device: torch.device) -> tuple[PolicyValueNet, float]:
    from .coverage import with_teacher_labels

    labeled = with_teacher_labels(prepare_examples(examples))
    model = PolicyValueNet(
        global_dim=GLOBAL_DIM_V4,
        feature_version=FEATURE_VERSION_V6,
        candidate_dim=CANDIDATE_DIM_V6,
    ).to(device)
    transfer_v4_weights(source, model)
    torch.manual_seed(TORCH_SEED)
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    model.train()
    started = time.perf_counter()
    for _epoch in range(EPOCHS):
        for start in range(0, len(labeled), BATCH):
            chunk = labeled[start : start + BATCH]
            batch = _collate(chunk, device)
            optimizer.zero_grad(set_to_none=True)
            logits, values = model(batch["global_x"], batch["candidates"], batch["mask"])
            loss, _stats = supervised_loss(logits, values, batch)
            loss.backward()
            optimizer.step()
    model.eval()
    return model, time.perf_counter() - started


def score_v6(model, observation: dict, device: torch.device) -> list[tuple[str, float]]:
    from .roads import encode_observation_v6

    model.eval()
    with torch.inference_mode():
        global_x, candidates, ids = encode_observation_v6(observation, device)
        if candidates.size(1) != CANDIDATE_DIM_V6:
            raise RuntimeError("refusing to score v6 with the wrong candidate width")
        mask = torch.ones(1, candidates.size(0), dtype=torch.bool, device=device)
        logits, _value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
        return [(action_id, float(logits[0, index].item())) for index, action_id in enumerate(ids)]


def meets_v6_gate(candidate: dict, control: dict) -> dict:
    """candidate is the fresh final view. control is the phase-6 validation view."""
    reasons = []
    road = candidate["natural"]["by_action_type"].get("buildRoad") or {}
    if int(road.get("n") or 0) < MEASURED_MIN:
        reasons.append(f"teacher-road n {road.get('n')}")
    elif road.get("top1") is None or float(road["top1"]) < ROAD_EXACT_MIN:
        reasons.append(f"teacher-road exact {road.get('top1')}")
    slice_road = candidate["targeted"]["endturn_vs_road"]
    if int(slice_road["n"]) < MEASURED_MIN:
        reasons.append(f"endturn-vs-road n {slice_road['n']}")
    elif slice_road["exact"] is None or float(slice_road["exact"]) < ROAD_EXACT_MIN:
        reasons.append(f"endturn-vs-road exact {slice_road['exact']}")
    slice_trade = candidate["targeted"]["endturn_vs_trade"]
    if int(slice_trade["n"]) < MEASURED_MIN:
        reasons.append(f"endturn-vs-trade n {slice_trade['n']}")
    elif slice_trade["exact"] is None or float(slice_trade["exact"]) < TRADE_EXACT_MIN:
        reasons.append(f"endturn-vs-trade exact {slice_trade['exact']}")
    within = candidate["within_by_type"]["bankTrade"]
    if int(within["n"]) < MEASURED_MIN:
        reasons.append(f"bank-trade within-type n {within['n']}")
    elif within["within_type"] is None or float(within["within_type"]) < TRADE_WITHIN_MIN:
        reasons.append(f"bank-trade within-type {within['within_type']}")
    if int(candidate["natural"]["invalid_predictions"]) != 0:
        reasons.append("illegal predictions")
    top1 = control["natural"]["top1"]
    multi = control["natural"]["multi_legal_top1"]
    if top1 is None or float(top1) < PHASE6_TOP1_MIN:
        reasons.append(f"phase6 validation top1 {top1}")
    if multi is None or float(multi) < PHASE6_MULTI_MIN:
        reasons.append(f"phase6 validation multi-legal {multi}")
    return {"met": not reasons, "reasons": reasons}
