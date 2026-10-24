"""Checkpoint save and resume. Weights stay outside the Firefox extension."""

from __future__ import annotations

from pathlib import Path

import torch

from .features import FEATURE_VERSION
from .graph import GRAPH_FEATURE_VERSION, GraphPolicyValueNet
from .model import PolicyValueNet
from .features import CANDIDATE_DIM
from .roads import ROAD_EXPANSION_DIM
from .tracked import FEATURE_VERSION_V4, FEATURE_VERSION_V5, FEATURE_VERSION_V6, GLOBAL_DIM_V4

CHECKPOINT_V1 = "colonist_checkpoint_v1"
CHECKPOINT_V2 = "colonist_checkpoint_v2"


def save_checkpoint(
    path: str,
    model: PolicyValueNet,
    optimizer: torch.optim.Optimizer,
    epoch: int,
    seed: int,
    manifest: dict,
    step: int = 0,
    algorithm: dict | None = None,
    next_launch_index: int = 0,
    completed_trajectories: int = 0,
    decisions_used: int = 0,
) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    version = getattr(model, "feature_version", FEATURE_VERSION)
    observation_version = "colonist_observation_v2" if version in (FEATURE_VERSION_V4, FEATURE_VERSION_V5, FEATURE_VERSION_V6) else "colonist_observation_v1"
    torch.save(
        {
            "schema_version": CHECKPOINT_V2,
            "observation_version": observation_version,
            "feature_version": version,
            "candidate_dim": int(getattr(model, "candidate_dim", CANDIDATE_DIM)),
            "hidden": model.hidden,
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "epoch": epoch,
            "step": step,
            "seed": seed,
            "algorithm": algorithm or {"name": "unspecified"},
            "next_launch_index": next_launch_index,
            "completed_trajectories": completed_trajectories,
            "decisions_used": decisions_used,
            "torch_rng_state": torch.get_rng_state(),
            "dataset_manifest": manifest,
        },
        target,
    )


def load_checkpoint(path: str, device: torch.device, restore_rng: bool = False) -> tuple[PolicyValueNet, torch.optim.Optimizer, dict]:
    payload = torch.load(path, map_location=device)
    if payload.get("schema_version") not in (CHECKPOINT_V1, CHECKPOINT_V2):
        raise ValueError("checkpoint schema")
    version = payload.get("feature_version")
    hidden = int(payload.get("hidden", 64))
    if version == GRAPH_FEATURE_VERSION:
        model = GraphPolicyValueNet(hidden=hidden).to(device)
    elif version == FEATURE_VERSION_V5:
        model = GraphPolicyValueNet(hidden=hidden, global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V5).to(device)
    elif version == FEATURE_VERSION:
        model = PolicyValueNet(hidden=hidden).to(device)
    elif version == FEATURE_VERSION_V4:
        model = PolicyValueNet(hidden=hidden, global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V4).to(device)
    elif version == FEATURE_VERSION_V6:
        width = int(payload.get("candidate_dim", CANDIDATE_DIM + ROAD_EXPANSION_DIM))
        if width != CANDIDATE_DIM + ROAD_EXPANSION_DIM:
            raise ValueError(f"colonist_features_v6 candidate width {width} is not {CANDIDATE_DIM + ROAD_EXPANSION_DIM}")
        model = PolicyValueNet(hidden=hidden, global_dim=GLOBAL_DIM_V4, feature_version=FEATURE_VERSION_V6, candidate_dim=width).to(device)
    else:
        raise ValueError("checkpoint features")
    candidate_weight = payload["model"].get("candidate_encoder.weight")
    if candidate_weight is not None and int(candidate_weight.shape[1]) != int(model.candidate_dim):
        raise ValueError(
            f"checkpoint candidate width {int(candidate_weight.shape[1])} does not match {version} width {int(model.candidate_dim)}"
        )
    model.load_state_dict(payload["model"])
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    if "optimizer" in payload:
        optimizer.load_state_dict(payload["optimizer"])
    if restore_rng and payload.get("torch_rng_state") is not None:
        rng_state = payload["torch_rng_state"]
        if hasattr(rng_state, "cpu"):
            rng_state = rng_state.cpu()
        torch.set_rng_state(rng_state)
    return model, optimizer, payload
