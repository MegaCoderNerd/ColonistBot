"""Public road-expansion features. The numbers match src/analyzer/ml/road-features.ts.

reach 0 means a distance-open corner touches the road or the current network.
It is not a legal settlement by itself: a settlement also needs a remaining
piece and the settlement cost. 99 means no such corner within 3 additional roads.
"""

from __future__ import annotations

ROAD_TYPES = {"buildRoad", "placeFreeRoad", "placeSetupRoad"}
ROAD_EXPANSION_DIM = 8


def _empty() -> dict:
    return {
        "reach_before": 0,
        "reach_after": 0,
        "reach_delta": 0,
        "reach_before_known": 0,
        "reach_after_known": 0,
        "opens_settlement": 0,
        "newly_opened": 0,
        "connects_network": 0,
    }


def _parse_board(observation: dict) -> dict:
    board = observation.get("board") or {}
    edges = board.get("edges") or []
    corners = board.get("corners") or []
    if not edges or not corners:
        raise ValueError("observation has no public board")
    corner_count = len(corners)
    edge_corners: list[tuple[int, int] | None] = []
    incident: list[list[tuple[int, int]]] = [[] for _ in range(corner_count)]
    for edge in edges:
        index = int(str(edge["id"])[1:])
        left = int(str(edge["corners"][0])[1:])
        right = int(str(edge["corners"][1])[1:])
        while len(edge_corners) <= index:
            edge_corners.append(None)
        edge_corners[index] = (left, right)
        incident[left].append((index, right))
        incident[right].append((index, left))
    owners = [None] * corner_count
    pieces = [0] * corner_count
    for placed in (observation.get("placements") or {}).get("corners") or []:
        index = int(str(placed["id"])[1:])
        owners[index] = placed.get("owner")
        pieces[index] = 2 if placed.get("piece") == "city" else 1
    edge_owners: list[str | None] = [None] * len(edge_corners)
    for placed in (observation.get("placements") or {}).get("edges") or []:
        index = int(str(placed["id"])[1:])
        edge_owners[index] = placed.get("owner")
    return {
        "incident": incident,
        "edge_corners": edge_corners,
        "owners": owners,
        "pieces": pieces,
        "edge_owners": edge_owners,
    }


def _distance_open(board: dict, corner: int) -> bool:
    if board["pieces"][corner] != 0:
        return False
    for _edge, neighbor in board["incident"][corner]:
        if board["pieces"][neighbor] > 0:
            return False
    return True


def _connects(board: dict, player: str, edge_index: int) -> bool:
    ends = board["edge_corners"][edge_index]
    if ends is None:
        return False
    for corner in ends:
        if board["owners"][corner] == player:
            return True
        touches = any(edge != edge_index and board["edge_owners"][edge] == player for edge, _neighbor in board["incident"][corner])
        if touches and board["owners"][corner] is None:
            return True
    return False


def _newly_opened(board: dict, player: str, edge_index: int) -> int:
    ends = board["edge_corners"][edge_index]
    if ends is None:
        return 0
    count = 0
    for corner in ends:
        if not _distance_open(board, corner):
            continue
        already = any(board["edge_owners"][edge] == player for edge, _neighbor in board["incident"][corner])
        if not already:
            count += 1
    return count


def _reach_before(board: dict, player: str, max_depth: int = 3) -> int:
    dist: dict[int, int] = {}
    deque: list[int] = []

    def relax(corner: int, nxt: int, front: bool) -> None:
        if nxt > max_depth:
            return
        previous = dist.get(corner)
        if previous is not None and previous <= nxt:
            return
        dist[corner] = nxt
        if front:
            deque.insert(0, corner)
        else:
            deque.append(corner)

    for corner, owner in enumerate(board["owners"]):
        if owner == player:
            relax(corner, 0, True)
    for edge_index, owner in enumerate(board["edge_owners"]):
        if owner != player:
            continue
        ends = board["edge_corners"][edge_index]
        if ends is None:
            continue
        relax(ends[0], 0, True)
        relax(ends[1], 0, True)
    best = 99
    while deque:
        corner = deque.pop(0)
        current = dist[corner]
        if _distance_open(board, corner):
            best = min(best, current)
        if current >= max_depth:
            continue
        owner = board["owners"][corner]
        if owner is not None and owner != player:
            continue
        for edge_index, neighbor in board["incident"][corner]:
            edge_owner = board["edge_owners"][edge_index]
            if edge_owner is not None and edge_owner != player:
                continue
            step = 0 if edge_owner == player else 1
            relax(neighbor, current + step, step == 0)
    return best


def _reach_after(board: dict, player: str, edge_index: int, max_depth: int = 3) -> int:
    """Same search as minAdditionalRoadsToOpenSettlementFromEdge, without the corner score."""
    ends = board["edge_corners"][edge_index]
    if ends is None:
        return 99
    best = 99
    queue = [(ends[0], 0), (ends[1], 0)]
    visited = {ends[0]: 0, ends[1]: 0}
    while queue:
        corner, current = queue.pop(0)
        if current > best:
            break
        if _distance_open(board, corner) and current < best:
            best = current
        if current >= max_depth:
            continue
        owner = board["owners"][corner]
        if owner is not None and owner != player:
            continue
        for edge, neighbor in board["incident"][corner]:
            edge_owner = player if edge == edge_index else board["edge_owners"][edge]
            if edge_owner is not None and edge_owner != player:
                continue
            step = 0 if edge_owner == player else 1
            nxt = current + step
            if nxt > max_depth:
                continue
            previous = visited.get(neighbor)
            if previous is None or nxt < previous:
                visited[neighbor] = nxt
                queue.append((neighbor, nxt))
    return best


def expansion_for_edge(observation: dict, player: str, edge_index: int) -> dict:
    board = _parse_board(observation)
    before = _reach_before(board, player)
    after = _reach_after(board, player, edge_index)
    before_known = 1 if before <= 3 else 0
    after_known = 1 if after <= 3 else 0
    opened = _newly_opened(board, player, edge_index)
    return {
        "reach_before": before if before_known else 99,
        "reach_after": after if after_known else 99,
        "reach_delta": before - after if before_known and after_known else 0,
        "reach_before_known": before_known,
        "reach_after_known": after_known,
        "opens_settlement": 1 if opened > 0 else 0,
        "newly_opened": opened,
        "connects_network": 1 if _connects(board, player, edge_index) else 0,
    }


def encode_observation_v6(observation: dict, device):
    import torch

    from .tracked import encode_observation_v4

    ensured = ensure_road_features(observation)
    global_x, candidates, ids = encode_observation_v4(ensured, device)
    if candidates.size(0) == 0:
        extra = torch.zeros(0, ROAD_EXPANSION_DIM, dtype=torch.float32, device=device)
    else:
        extra = torch.tensor([expansion_tail(candidate) for candidate in ensured["candidates"]], dtype=torch.float32, device=device)
    return global_x, torch.cat([candidates, extra], dim=1), ids


def expansion_tail(candidate: dict) -> list[float]:
    action_type = str(candidate.get("type") or "")
    public = candidate.get("public_features") or {}
    if action_type not in ROAD_TYPES:
        return [0.0] * ROAD_EXPANSION_DIM
    if "reach_before_known" not in public:
        raise ValueError("road candidate is missing expansion features")
    before_known = float(public.get("reach_before_known") or 0)
    after_known = float(public.get("reach_after_known") or 0)
    before = int(public.get("reach_before") or 0)
    after = int(public.get("reach_after") or 0)
    return [
        before_known,
        (before / 3.0) if before_known else 0.0,
        after_known,
        (after / 3.0) if after_known else 0.0,
        float(public.get("reach_delta") or 0) / 3.0,
        float(public.get("opens_settlement") or 0),
        float(public.get("newly_opened") or 0) / 2.0,
        float(public.get("connects_network") or 0),
    ]


def ensure_road_features(observation: dict) -> dict:
    """Fill missing road features from the public board. Summary rows must already carry them."""
    missing = [
        candidate
        for candidate in observation.get("candidates") or []
        if str(candidate.get("type")) in ROAD_TYPES and "reach_before_known" not in (candidate.get("public_features") or {})
    ]
    if not missing:
        return observation
    player = str(observation.get("actor_id") or "")
    for candidate in missing:
        public = dict(candidate.get("public_features") or {})
        edge_index = int(public.get("edge_index", -1))
        public.update(expansion_for_edge(observation, player, edge_index))
        candidate["public_features"] = public
    return observation
