"""Phase 12 longest-road candidate.

The acceptance rule below was written before this candidate was scored.
v4 and v6 stay frozen. Cutoffs are not wins or losses.
"""

from __future__ import annotations

import time

import torch

from .coverage import PHASE6_BATCH, PHASE6_EPOCHS, with_teacher_labels
from .longest import GLOBAL_LONGEST_DIM, LONGEST_ROAD_DIM, encode_observation_v7, ensure_longest_features
from .match import MIN_COMPLETED_PAIRS, _weight_hash
from .model import PolicyValueNet
from .phase9 import CANDIDATE_DIM_V6
from .phase10 import (
    CUTOFF_RATE_MARGIN,
    V4_WEIGHT_SHA256,
    V6_WEIGHT_SHA256,
    play_frozen_game,
    summarize_policy,
)
from .tracked import FEATURE_VERSION_V6, FEATURE_VERSION_V7, GLOBAL_DIM_V4
from .train import supervised_loss

# Fixed before the phase-12 match. Do not edit these after reading the batch.
GLOBAL_DIM_V7 = GLOBAL_DIM_V4 + GLOBAL_LONGEST_DIM
CANDIDATE_DIM_V7 = CANDIDATE_DIM_V6 + LONGEST_ROAD_DIM
EPOCHS = PHASE6_EPOCHS
BATCH = PHASE6_BATCH
LEARNING_RATE = 1e-3
TORCH_SEED = 7
STRENGTH_SEEDS = tuple(f"ml-v7-strength-{index}" for index in range(200))
SMOKE_SEEDS = STRENGTH_SEEDS[:2]
VP_DROP_MAX = 1.0
BANNED_SEED_PREFIXES = (
    "ml-v6-strength-",
    "ml-v7-strength-",
    "ml-v4-match-",
    "ml-holdout-",
    "ml-fidelity-",
    "ml-graph-",
)


def assert_training_rows(examples: list[dict]) -> None:
    for example in examples:
        seed = str(example.get("seed") or "")
        if any(seed.startswith(prefix) for prefix in BANNED_SEED_PREFIXES):
            raise RuntimeError(f"training row reuses a reserved seed {seed}")


def assert_strength_seeds(seeds: tuple[str, ...] | list[str]) -> None:
    allowed = set(STRENGTH_SEEDS)
    for seed in seeds:
        if seed not in allowed:
            raise RuntimeError(f"seed {seed} is outside ml-v7-strength")
        if any(seed.startswith(prefix) for prefix in BANNED_SEED_PREFIXES if prefix != "ml-v7-strength-"):
            raise RuntimeError(f"seed {seed} reuses an earlier split")


def transfer_v6_to_v7(source: PolicyValueNet, target: PolicyValueNet) -> None:
    """Copy v6 and zero the new longest-road columns.

    New inputs do not change scores until training moves those weights.
    """
    if source.feature_version != FEATURE_VERSION_V6 or target.feature_version != FEATURE_VERSION_V7:
        raise RuntimeError("transfer is from colonist_features_v6 to colonist_features_v7 only")
    if int(source.global_dim) + GLOBAL_LONGEST_DIM != int(target.global_dim):
        raise RuntimeError("v7 global width is not v6 plus the actor road block")
    if int(source.candidate_dim) + LONGEST_ROAD_DIM != int(target.candidate_dim):
        raise RuntimeError("v7 candidate width is not v6 plus the longest-road block")
    target.value_head.load_state_dict(source.value_head.state_dict())
    with torch.no_grad():
        target.encoder[0].weight.zero_()
        target.encoder[0].weight[:, : source.encoder[0].weight.shape[1]] = source.encoder[0].weight
        target.encoder[0].bias.copy_(source.encoder[0].bias)
        target.encoder[2].load_state_dict(source.encoder[2].state_dict())
        target.candidate_encoder.weight.zero_()
        target.candidate_encoder.weight[:, : source.candidate_encoder.weight.shape[1]] = source.candidate_encoder.weight
        target.candidate_encoder.bias.copy_(source.candidate_encoder.bias)


def prepare_examples(examples: list[dict]) -> list[dict]:
    assert_training_rows(examples)
    prepared = []
    for example in examples:
        copied = dict(example)
        copied["observation"] = ensure_longest_features(example["observation"])
        prepared.append(copied)
    return prepared


def _collate(examples: list[dict], device: torch.device) -> dict:
    from .coverage import _collate_v4

    batch = _collate_v4(examples, device)
    global_x = torch.zeros(len(examples), GLOBAL_DIM_V7, device=device)
    candidates = torch.zeros(len(examples), batch["candidates"].shape[1], CANDIDATE_DIM_V7, device=device)
    for index, example in enumerate(examples):
        one_global, one_candidates, _ids = encode_observation_v7(example["observation"], device)
        if one_global.numel() != GLOBAL_DIM_V7 or one_candidates.size(1) != CANDIDATE_DIM_V7:
            raise RuntimeError("v7 feature width drifted")
        global_x[index] = one_global
        candidates[index, : one_candidates.size(0)] = one_candidates
    batch["global_x"] = global_x
    batch["candidates"] = candidates
    return batch


def train_v7(examples: list[dict], source: PolicyValueNet, device: torch.device, epochs: int = EPOCHS, on_epoch=None) -> tuple[PolicyValueNet, torch.optim.Optimizer, dict]:
    labeled = with_teacher_labels(prepare_examples(examples))
    model = PolicyValueNet(global_dim=GLOBAL_DIM_V7, feature_version=FEATURE_VERSION_V7, candidate_dim=CANDIDATE_DIM_V7).to(device)
    transfer_v6_to_v7(source, model)
    torch.manual_seed(TORCH_SEED)
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    model.train()
    started = time.perf_counter()
    last = {"policy": 0.0, "value": 0.0, "loss": 0.0}
    best_loss = None
    for epoch in range(epochs):
        epoch_started = time.perf_counter()
        for start in range(0, len(labeled), BATCH):
            chunk = labeled[start : start + BATCH]
            batch = _collate(chunk, device)
            optimizer.zero_grad(set_to_none=True)
            logits, values = model(batch["global_x"], batch["candidates"], batch["mask"])
            loss, last = supervised_loss(logits, values, batch)
            loss.backward()
            optimizer.step()
        improved = best_loss is None or last["loss"] < best_loss
        if improved:
            best_loss = last["loss"]
        if on_epoch is not None:
            on_epoch({
                "epoch": epoch + 1,
                "loss": last,
                "improved": improved,
                "epoch_seconds": time.perf_counter() - epoch_started,
                "examples": len(labeled),
            })
    model.eval()
    return model, optimizer, {"seconds": time.perf_counter() - started, "loss": last, "rows": len(labeled), "best_loss": best_loss}


def score_v7(model: PolicyValueNet, observation: dict, device: torch.device) -> list[tuple[str, float]]:
    model.eval()
    with torch.inference_mode():
        global_x, candidates, ids = encode_observation_v7(observation, device)
        if global_x.numel() != GLOBAL_DIM_V7 or candidates.size(1) != CANDIDATE_DIM_V7:
            raise RuntimeError("refusing to score v7 with the wrong width")
        mask = torch.ones(1, candidates.size(0), dtype=torch.bool, device=device)
        logits, _value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
        return [(action_id, float(logits[0, index].item())) for index, action_id in enumerate(ids)]


def interpret(v7: dict, v6: dict) -> dict:
    """Positive only when the pair interval is entirely above even, cutoffs are not materially worse, and completed VP does not drop by more than 1."""
    if int(v7["pairs_completed"]) < MIN_COMPLETED_PAIRS:
        return {"decision": "inconclusive", "reasons": [f"completed pairs {v7['pairs_completed']}"]}
    interval = v7["pair_score_minus_even"]
    low = interval.get("low")
    high = interval.get("high")
    above = low is not None and float(low) > 0
    below = high is not None and float(high) < 0
    cutoff_v7 = float(v7["cutoff_games"]) / float(v7["games_launched"])
    cutoff_v6 = float(v6["cutoff_games"]) / float(v6["games_launched"])
    cutoff_worse = cutoff_v7 > cutoff_v6 + CUTOFF_RATE_MARGIN
    vp_v7 = v7.get("mean_vp_among_completed")
    vp_v6 = v6.get("mean_vp_among_completed")
    vp_regression = vp_v7 is not None and vp_v6 is not None and float(vp_v7) < float(vp_v6) - VP_DROP_MAX
    if below:
        return {"decision": "negative", "reasons": ["paired interval is entirely below even"]}
    if cutoff_worse:
        return {"decision": "negative", "reasons": [f"cutoff rate {cutoff_v7:.3f} exceeds v6 {cutoff_v6:.3f} by more than {CUTOFF_RATE_MARGIN}"]}
    if above and not vp_regression:
        return {"decision": "positive", "reasons": []}
    if above and vp_regression:
        return {"decision": "inconclusive", "reasons": ["interval is above even and completed VP regressed by more than 1"]}
    return {"decision": "inconclusive", "reasons": ["paired interval includes an even result"]}


def matched_difference(v7: dict, v6: dict, seeds: tuple[str, ...]) -> dict:
    from .algorithm import bootstrap_mean

    left = v7["pair_values_by_seed"]
    right = v6["pair_values_by_seed"]
    shared = [seed for seed in seeds if left.get(seed) is not None and right.get(seed) is not None]
    diffs = [float(left[seed]) - float(right[seed]) for seed in shared]
    return {
        "seeds": len(shared),
        "mean_v7_minus_v6": None if not diffs else sum(diffs) / len(diffs),
        "interval": bootstrap_mean(diffs, seed="ml-v7-strength-diff-bootstrap-v1"),
        "note": "Seeds where both policies completed both seats. This is not the score against the heuristic.",
    }


def _run_once(bridge, models: dict, device: torch.device, seeds: tuple[str, ...]) -> dict:
    from .phase10 import _blank_diag

    reports = {}
    for name, spec in models.items():
        rows = []
        failures = []
        illegal = 0
        samples = []
        diag = _blank_diag()
        started = time.perf_counter()
        for seed in seeds:
            for learner in ("c1", "c2"):
                played = play_frozen_game(bridge, spec["model"], device, seed, learner, spec["checkpoint"], spec["version"])
                illegal += int(played.get("illegal") or 0)
                if not played.get("ok"):
                    failures.append({"seed": seed, "learner": learner, "message": played.get("message")})
                    rows.append({
                        "seed": seed,
                        "learner": learner,
                        "policy": name,
                        "checkpoint": spec["checkpoint"],
                        "completion_status": "incomplete",
                        "cutoff_reason": "simulator_failure",
                        "actor_win": None,
                        "scores": None,
                        "turns": None,
                        "actions": None,
                        "winner_id": None,
                        "first_actions": played.get("first_actions") or [],
                        "decision_count": played.get("decision_count") or 0,
                    })
                    continue
                terminal = played["terminal"]
                score = terminal["actor_win"][learner] if terminal["completion_status"] == "completed" else None
                rows.append({
                    "seed": seed,
                    "learner": learner,
                    "policy": name,
                    "checkpoint": spec["checkpoint"],
                    "feature_version": spec["version"],
                    "completion_status": terminal["completion_status"],
                    "cutoff_reason": terminal["cutoff_reason"],
                    "actor_win": score,
                    "scores": terminal.get("scores"),
                    "turns": terminal.get("turns"),
                    "actions": terminal.get("actions"),
                    "winner_id": terminal.get("winner_id"),
                    "first_actions": played["first_actions"],
                    "decision_count": played["decision_count"],
                })
                for key, value in played["diag"].items():
                    if hasattr(value, "update") and not isinstance(value, (int, float)):
                        diag[key].update(value)
                    elif isinstance(value, list):
                        diag[key].extend(value)
                    else:
                        diag[key] += value
                if seed in SMOKE_SEEDS:
                    samples.append({
                        "seed": seed,
                        "learner": learner,
                        "checkpoint": spec["checkpoint"],
                        "feature_version": spec["version"],
                        "completion_status": terminal["completion_status"],
                        "cutoff_reason": terminal["cutoff_reason"],
                        "actor_win": score,
                        "scores": terminal.get("scores"),
                        "turns": terminal.get("turns"),
                        "actions": terminal.get("actions"),
                        "decision_count": played["decision_count"],
                        "decisions": played["decisions"][:8],
                    })
        reports[name] = summarize_policy(
            rows,
            seeds,
            diag,
            spec["version"],
            spec["checkpoint"],
            "ml-v7-strength-bootstrap-v1" if name == "v7" else "ml-v7-strength-v6-bootstrap-v1",
            time.perf_counter() - started,
            failures,
            illegal,
            samples,
        )
        reports[name]["weight_sha256"] = spec["hash"]
    return reports


def run_strength(bridge, models: dict, device: torch.device, seeds: tuple[str, ...]) -> dict:
    assert_strength_seeds(seeds)
    reports = _run_once(bridge, models, device, seeds)
    reports["matched_v7_minus_v6"] = matched_difference(reports["v7"], reports["v6"], seeds)
    reports["interpretation"] = interpret(reports["v7"], reports["v6"])
    reports["ppo_authorized"] = False
    reports["playing_strength_claim"] = reports["interpretation"]["decision"] == "positive"
    reports["professional_strength_claim"] = False
    reports["frozen_v4_sha256"] = V4_WEIGHT_SHA256
    reports["frozen_v6_sha256"] = V6_WEIGHT_SHA256
    reports["stochastic_note"] = (
        "The same seed rebuilds the board and development deck. Dice, theft, and heuristic tie breaks "
        "start from the same derived streams. Those streams are consumed as actions occur, so a seat swap "
        "and a different neural policy do not replay one trajectory. The network always takes the highest legal score."
    )
    reports["interval_note"] = (
        "Each bootstrap interval is conditional on seeds whose two seat assignments both finished. "
        "A cutoff drops the whole pair. The interval does not represent unfinished games."
    )
    return reports


def weight_hash(model: PolicyValueNet) -> str:
    return _weight_hash(model)
