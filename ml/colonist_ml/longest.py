"""Longest-road features for colonist_features_v7.

The numbers match src/analyzer/ml/longest-road-features.ts. v4 and v6 encoders
do not read them. Lengths use the same walk as phase11.road_length. The award
rule matches updateLongestRoadAward: minimum 5, incumbent keeps a tie, and a
tie among challengers leaves the award unclaimed.

Candidate tail, after the eight v6 expansion numbers:
  road_length_now / 15
  road_length_after / 15
  road_length_delta / 15
  gain, retain, lose, otherwise

Summary tail, after the v4 vector:
  actor road_length / 15
  actor has_longest_road

A road the actor places cannot shorten that actor's route. lose stays available
so a hypothetical that drops the award is explicit rather than folded into otherwise.
Non-roads are zeros, including the otherwise flag.
"""

from __future__ import annotations

import torch

from .phase11 import road_length
from .roads import ROAD_TYPES, encode_observation_v6

LONGEST_ROAD_MIN = 5
LONGEST_ROAD_DIM = 7
GLOBAL_LONGEST_DIM = 2
LENGTH_SCALE = 15.0


def longest_road_holder(lengths: dict[str, int], incumbent: str | None) -> str | None:
    if not lengths:
        return None
    maximum = max(lengths.values())
    if maximum < LONGEST_ROAD_MIN:
        return None
    if incumbent is not None and lengths.get(incumbent) == maximum:
        return incumbent
    leaders = [player for player, length in lengths.items() if length == maximum]
    return leaders[0] if len(leaders) == 1 else None


def _players(observation: dict) -> list[str]:
    found = [str(observation.get("actor_id") or "")]
    for placed in (observation.get("placements") or {}).get("edges") or []:
        owner = placed.get("owner")
        if owner and owner not in found:
            found.append(str(owner))
    for placed in (observation.get("placements") or {}).get("corners") or []:
        owner = placed.get("owner")
        if owner and owner not in found:
            found.append(str(owner))
    return [player for player in found if player]


def _lengths(observation: dict, actor: str | None = None, extra_edge: str | None = None) -> dict[str, int]:
    lengths = {}
    for player in _players(observation):
        lengths[player] = road_length(observation, player, extra_edge if player == actor else None)
    return lengths


def _stored_incumbent(observation: dict) -> str | None:
    actor_id = str(observation.get("actor_id") or "")
    actor = observation.get("actor") or {}
    if actor.get("has_longest_road") is True:
        return actor_id
    holders = [str(opponent.get("id")) for opponent in observation.get("opponents") or [] if opponent.get("has_longest_road")]
    if len(holders) == 1:
        return holders[0]
    return None


def actor_longest_road(observation: dict) -> tuple[int, bool]:
    """Public actor length and award.

    Stored actor fields win. Older rows omitted them. Those rows use the
    opponent flags plus the board: a tie with no stored holder stays unclaimed.
    """
    actor = observation.get("actor") or {}
    if "road_length" in actor and "has_longest_road" in actor:
        return int(actor["road_length"]), bool(actor["has_longest_road"])
    if not (observation.get("board") or {}).get("edges"):
        raise ValueError("longest-road features need the actor fields or the public board")
    lengths = _lengths(observation)
    actor_id = str(observation.get("actor_id") or "")
    length = int(lengths.get(actor_id, 0))
    if any(opponent.get("has_longest_road") for opponent in observation.get("opponents") or []):
        return length, False
    holder = longest_road_holder(lengths, None)
    return length, holder == actor_id


def features_for_edge(observation: dict, edge_index: int) -> dict[str, int]:
    if not (observation.get("board") or {}).get("edges"):
        raise ValueError("hypothetical road length needs the public board")
    actor = str(observation.get("actor_id") or "")
    before = _lengths(observation)
    after = _lengths(observation, actor, f"e{edge_index}")
    incumbent = _stored_incumbent(observation)
    if "has_longest_road" not in (observation.get("actor") or {}):
        incumbent = longest_road_holder(before, incumbent)
    before_holder = longest_road_holder(before, incumbent)
    after_holder = longest_road_holder(after, incumbent)
    now = int(before.get(actor, 0))
    nxt = int(after.get(actor, 0))
    had = before_holder == actor
    has = after_holder == actor
    return {
        "road_length_now": now,
        "road_length_after": nxt,
        "road_length_delta": nxt - now,
        "longest_road_gain": 1 if not had and has else 0,
        "longest_road_retain": 1 if had and has else 0,
        "longest_road_lose": 1 if had and not has else 0,
        "longest_road_otherwise": 1 if not had and not has else 0,
    }


def _empty() -> dict[str, int]:
    return {
        "road_length_now": 0,
        "road_length_after": 0,
        "road_length_delta": 0,
        "longest_road_gain": 0,
        "longest_road_retain": 0,
        "longest_road_lose": 0,
        "longest_road_otherwise": 0,
    }


def ensure_longest_features(observation: dict) -> dict:
    """Fill actor and road fields. Does not mutate the caller's observation."""
    copied = dict(observation)
    copied["actor"] = dict(observation.get("actor") or {})
    copied["candidates"] = []
    length, holds = actor_longest_road(observation)
    if "road_length" not in copied["actor"]:
        copied["actor"]["road_length"] = length
    if "has_longest_road" not in copied["actor"]:
        copied["actor"]["has_longest_road"] = holds
    for candidate in observation.get("candidates") or []:
        item = dict(candidate)
        public = dict(candidate.get("public_features") or {})
        action_type = str(item.get("type") or "")
        if action_type in ROAD_TYPES and "road_length_now" not in public:
            edge_index = int(public.get("edge_index", -1))
            public.update(features_for_edge(copied, edge_index))
        item["public_features"] = public
        copied["candidates"].append(item)
    return copied


def global_longest_tail(observation: dict) -> list[float]:
    length, holds = actor_longest_road(observation)
    return [float(length) / LENGTH_SCALE, 1.0 if holds else 0.0]


def longest_tail(candidate: dict) -> list[float]:
    action_type = str(candidate.get("type") or "")
    if action_type not in ROAD_TYPES:
        return [0.0] * LONGEST_ROAD_DIM
    public = candidate.get("public_features") or {}
    if "road_length_now" not in public:
        raise ValueError("road candidate is missing longest-road features")
    return [
        float(public.get("road_length_now") or 0) / LENGTH_SCALE,
        float(public.get("road_length_after") or 0) / LENGTH_SCALE,
        float(public.get("road_length_delta") or 0) / LENGTH_SCALE,
        float(public.get("longest_road_gain") or 0),
        float(public.get("longest_road_retain") or 0),
        float(public.get("longest_road_lose") or 0),
        float(public.get("longest_road_otherwise") or 0),
    ]


def encode_observation_v7(observation: dict, device):
    ensured = ensure_longest_features(observation)
    global_x, candidates, ids = encode_observation_v6(ensured, device)
    tail = torch.tensor(global_longest_tail(ensured), dtype=torch.float32, device=device)
    if candidates.size(0) == 0:
        extra = torch.zeros(0, LONGEST_ROAD_DIM, dtype=torch.float32, device=device)
    else:
        extra = torch.tensor([longest_tail(candidate) for candidate in ensured["candidates"]], dtype=torch.float32, device=device)
    return torch.cat([global_x, tail], dim=0), torch.cat([candidates, extra], dim=1), ids
