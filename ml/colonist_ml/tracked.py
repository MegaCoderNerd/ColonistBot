"""Resource-count features from the live card counter.

colonist_features_v2 stays the previous summary schema. It cannot tell an
unknown bank from an empty one, and it does not see tracked opponent cards.
colonist_features_v4 is that same summary scorer with those counts added.
colonist_features_v5 is the v3 board encoder with the same added counts.
Neither loads a checkpoint from the other schema.
"""

from __future__ import annotations

import torch

from .features import GLOBAL_DIM, global_vector

FEATURE_VERSION_V4 = "colonist_features_v4"
FEATURE_VERSION_V5 = "colonist_features_v5"
FEATURE_VERSION_V6 = "colonist_features_v6"
FEATURE_VERSION_V7 = "colonist_features_v7"
RESOURCES = ("lumber", "brick", "wool", "grain", "ore")
# Two opponents: five known resources, unnamed cards, and an exactness flag. Then the bank flag.
TRACKED_EXTRA = 2 * (len(RESOURCES) + 2) + 1
GLOBAL_DIM_V4 = GLOBAL_DIM + TRACKED_EXTRA


def tracked_tail(observation: dict) -> list[float]:
    opponents = list(observation.get("opponents") or [])[:2]
    while len(opponents) < 2:
        opponents.append({})
    tail: list[float] = []
    for opponent in opponents:
        tracked = opponent.get("tracked_resources") or {}
        tail.extend(float(tracked.get(name, 0)) / 10.0 for name in RESOURCES)
        tail.append(float(tracked.get("unknown", 0)) / 10.0)
        tail.append(1.0 if tracked.get("exact") else 0.0)
    tail.append(1.0 if observation.get("bank_exact") else 0.0)
    if len(tail) != TRACKED_EXTRA:
        raise RuntimeError(f"tracked tail {len(tail)} != {TRACKED_EXTRA}")
    return tail


def global_vector_v4(observation: dict) -> list[float]:
    bank_exact = bool(observation.get("bank_exact"))
    bank = observation.get("bank")
    if bank_exact and not isinstance(bank, dict):
        raise ValueError("exact bank missing")
    if not bank_exact and bank not in (None, {}):
        raise ValueError("uncertain bank included counts")
    payload = dict(observation)
    if not bank_exact:
        payload["bank"] = {}
    vector = global_vector(payload)
    vector.extend(tracked_tail(observation))
    if len(vector) != GLOBAL_DIM_V4:
        raise RuntimeError(f"tracked global width {len(vector)} != {GLOBAL_DIM_V4}")
    return vector


def encode_observation_v4(observation: dict, device: torch.device):
    from .features import candidate_matrix

    rows, ids = candidate_matrix(observation)
    global_x = torch.tensor(global_vector_v4(observation), dtype=torch.float32, device=device)
    candidates = torch.tensor(rows, dtype=torch.float32, device=device)
    return global_x, candidates, ids
