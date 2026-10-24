"""Board-aware policy. Feature schema colonist_features_v3.

Hexes, intersections, and edges stay in separate tensors. Two rounds of
message passing let a road see the intersections it joins and the tiles
those intersections touch. The scalar player vector is kept beside that
board summary. Each legal candidate is scored from the shared state, its
action type, the entity it touches, and its resource payload. The legal
list remains the only source of executable actions.

This is not a drop-in replacement for colonist_features_v2. Checkpoints
record the feature schema and will not load across schemas.
"""

from __future__ import annotations

import torch
from torch import nn

from .features import ACTIONS, GLOBAL_DIM, global_vector

GRAPH_FEATURE_VERSION = "colonist_features_v3"
HEXES = 19
CORNERS = 54
EDGES = 72
NODE_DIM = 32
HEX_IN = 8
VERT_IN = 17
EDGE_IN = 3
PAYLOAD_DIM = 20


def _require_board(observation: dict) -> tuple[list, list, list]:
    board = observation.get("board") or {}
    hexes = list(board.get("hexes") or [])
    corners = list(board.get("corners") or [])
    edges = list(board.get("edges") or [])
    if len(hexes) != HEXES or len(corners) != CORNERS or len(edges) != EDGES:
        raise ValueError(
            f"graph model requires the full board ({HEXES} hexes, {CORNERS} corners, {EDGES} edges); "
            "a summary observation is not this schema"
        )
    return hexes, corners, edges


def _port_one_hot(port: object) -> list[float]:
    names = ("none", "any", "lumber", "brick", "wool", "grain", "ore")
    if port in (None, "", "none"):
        key = "none"
    else:
        key = str(port)
    return [1.0 if name == key else 0.0 for name in names]


def board_tensors(observation: dict) -> dict[str, torch.Tensor]:
    """Public board tensors for one decision. Opponent hands are not read."""
    hexes, corners, edges = _require_board(observation)
    resources = ("lumber", "brick", "wool", "grain", "ore")
    robber = str(observation.get("robber_hex_id", ""))
    placements = observation.get("placements") or {}
    corner_owner = {}
    corner_piece = {}
    for placed in placements.get("corners") or []:
        corner_owner[str(placed.get("id"))] = str(placed.get("owner"))
        corner_piece[str(placed.get("id"))] = str(placed.get("piece"))
    edge_owner = {str(placed.get("id")): str(placed.get("owner")) for placed in placements.get("edges") or []}
    actor = str(observation.get("actor_id", ""))

    hex_rows = []
    hex_id_to_index = {}
    for index, hex_tile in enumerate(hexes):
        hex_id = str(hex_tile.get("id"))
        hex_id_to_index[hex_id] = index
        resource = hex_tile.get("resource")
        one_hot = [1.0 if resource == name else 0.0 for name in resources]
        one_hot.append(1.0 if not resource else 0.0)
        hex_rows.append(
            [
                *one_hot,
                float(hex_tile.get("pips") or 0) / 5.0,
                1.0 if hex_id == robber else 0.0,
            ]
        )

    hex_pips = []
    for hex_tile in hexes:
        resource = hex_tile.get("resource")
        pips = float(hex_tile.get("pips") or 0)
        blocked = str(hex_tile.get("id")) == robber
        counts = []
        for name in resources:
            counts.append(0.0 if blocked or resource != name else pips)
        hex_pips.append(counts)

    vert_rows = []
    vert_hex = []
    vert_edge = []
    corner_id_to_index = {}
    edge_id_to_corners: dict[str, list[int]] = {}
    corner_to_edges: dict[int, list[int]] = {index: [] for index in range(len(corners))}
    for index, corner in enumerate(corners):
        corner_id = str(corner.get("id"))
        corner_id_to_index[corner_id] = index
    for edge_index, edge in enumerate(edges):
        linked = []
        for corner_id in edge.get("corners") or []:
            corner_index = corner_id_to_index.get(str(corner_id), -1)
            linked.append(corner_index)
            if corner_index >= 0:
                corner_to_edges[corner_index].append(edge_index)
        edge_id_to_corners[str(edge.get("id"))] = linked

    for index, corner in enumerate(corners):
        corner_id = str(corner.get("id"))
        owner = corner_owner.get(corner_id)
        if owner == actor:
            owner_bits = [1.0, 0.0, 0.0]
        elif owner:
            owner_bits = [0.0, 1.0, 0.0]
        else:
            owner_bits = [0.0, 0.0, 1.0]
        piece = corner_piece.get(corner_id)
        piece_bits = [1.0 if piece == "settlement" else 0.0, 1.0 if piece == "city" else 0.0]
        production = [0.0, 0.0, 0.0, 0.0, 0.0]
        hex_links = []
        for hex_id in corner.get("hex_ids") or []:
            hex_index = hex_id_to_index.get(str(hex_id))
            if hex_index is None:
                continue
            hex_links.append(hex_index)
            for resource_index, value in enumerate(hex_pips[hex_index]):
                production[resource_index] += value
        production = [value / 10.0 for value in production]
        vert_rows.append([*owner_bits, *piece_bits, *_port_one_hot(corner.get("port")), *production])
        vert_hex.append(_pad(hex_links, 3))
        vert_edge.append(_pad(corner_to_edges[index], 3))

    edge_rows = []
    edge_vert = []
    for edge in edges:
        edge_id = str(edge.get("id"))
        owner = edge_owner.get(edge_id)
        if owner == actor:
            bits = [1.0, 0.0, 0.0]
        elif owner:
            bits = [0.0, 1.0, 0.0]
        else:
            bits = [0.0, 0.0, 1.0]
        edge_rows.append(bits)
        edge_vert.append(_pad(edge_id_to_corners.get(edge_id, []), 2))

    hex_vert: list[list[int]] = [[] for _ in hexes]
    for corner_index, links in enumerate(vert_hex):
        for hex_index in links:
            if hex_index >= 0:
                hex_vert[hex_index].append(corner_index)
    hex_vert = [_pad(links, 6) for links in hex_vert]

    return {
        "hex_x": torch.tensor(hex_rows, dtype=torch.float32),
        "vert_x": torch.tensor(vert_rows, dtype=torch.float32),
        "edge_x": torch.tensor(edge_rows, dtype=torch.float32),
        "vert_hex": torch.tensor(vert_hex, dtype=torch.long),
        "vert_edge": torch.tensor(vert_edge, dtype=torch.long),
        "edge_vert": torch.tensor(edge_vert, dtype=torch.long),
        "hex_vert": torch.tensor(hex_vert, dtype=torch.long),
    }


def _pad(values: list[int], width: int) -> list[int]:
    trimmed = list(values)[:width]
    return trimmed + [-1] * (width - len(trimmed))


def candidate_parts(observation: dict) -> dict[str, torch.Tensor]:
    _require_board(observation)
    types = []
    nodes = []
    payloads = []
    ids = []
    type_index = {name: index for index, name in enumerate(ACTIONS)}
    for candidate in observation["candidates"]:
        action_type = str(candidate.get("type", "other"))
        one_hot = [0.0] * (len(ACTIONS) + 1)
        one_hot[type_index.get(action_type, len(ACTIONS))] = 1.0
        public = candidate.get("public_features") or {}
        corner = int(public.get("corner_index", -1))
        edge = int(public.get("edge_index", -1))
        hex_index = int(public.get("hex_index", -1))
        if corner >= 0:
            kind, index = 1, corner
        elif edge >= 0:
            kind, index = 2, edge
        elif hex_index >= 0:
            kind, index = 3, hex_index
        else:
            kind, index = 0, -1
        payload = [float(public.get(f"{name}_pips", 0)) / 10.0 for name in ("lumber", "brick", "wool", "grain", "ore")]
        payload.extend(float(public.get(f"give_{name}", 0)) / 10.0 for name in ("lumber", "brick", "wool", "grain", "ore"))
        payload.extend(float(public.get(f"receive_{name}", 0)) / 4.0 for name in ("lumber", "brick", "wool", "grain", "ore"))
        payload.extend(float(public.get(f"cost_{name}", 0)) / 3.0 for name in ("lumber", "brick", "wool", "grain", "ore"))
        types.append(one_hot)
        nodes.append([kind, index])
        payloads.append(payload)
        ids.append(str(candidate["action_id"]))
    return {
        "type": torch.tensor(types, dtype=torch.float32),
        "node": torch.tensor(nodes, dtype=torch.long),
        "payload": torch.tensor(payloads, dtype=torch.float32),
        "ids": ids,
    }


def _gather_mean(source: torch.Tensor, index: torch.Tensor) -> torch.Tensor:
    """source [B, S, D], index [Dest, K] with -1 padding. Returns [B, Dest, D]."""
    safe = index.clamp(min=0)
    picked = source[:, safe, :]
    mask = (index >= 0).to(source.dtype).view(1, index.size(0), index.size(1), 1)
    summed = (picked * mask).sum(dim=2)
    denom = mask.sum(dim=2).clamp(min=1.0)
    return summed / denom


class GraphPolicyValueNet(nn.Module):
    def __init__(self, hidden: int = 64, global_dim: int = GLOBAL_DIM, feature_version: str = GRAPH_FEATURE_VERSION):
        super().__init__()
        self.feature_version = feature_version
        self.global_dim = global_dim
        self.hidden = hidden
        self.hex_enc = nn.Linear(HEX_IN, NODE_DIM)
        self.vert_enc = nn.Linear(VERT_IN, NODE_DIM)
        self.edge_enc = nn.Linear(EDGE_IN, NODE_DIM)
        self.vert_msg = nn.Linear(NODE_DIM * 3, NODE_DIM)
        self.edge_msg = nn.Linear(NODE_DIM * 2, NODE_DIM)
        self.hex_msg = nn.Linear(NODE_DIM * 2, NODE_DIM)
        self.fuse = nn.Sequential(
            nn.Linear(global_dim + NODE_DIM * 3, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
        )
        self.candidate = nn.Linear(NODE_DIM + len(ACTIONS) + 1 + PAYLOAD_DIM, hidden)
        self.value_head = nn.Linear(hidden, 1)

    def encode_board(
        self,
        hex_x: torch.Tensor,
        vert_x: torch.Tensor,
        edge_x: torch.Tensor,
        vert_hex: torch.Tensor,
        vert_edge: torch.Tensor,
        edge_vert: torch.Tensor,
        hex_vert: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        hex_h = torch.relu(self.hex_enc(hex_x))
        vert_h = torch.relu(self.vert_enc(vert_x))
        edge_h = torch.relu(self.edge_enc(edge_x))
        for _round in range(2):
            vert_h = torch.relu(self.vert_msg(torch.cat([
                vert_h,
                _gather_mean(hex_h, vert_hex),
                _gather_mean(edge_h, vert_edge),
            ], dim=-1)))
            edge_h = torch.relu(self.edge_msg(torch.cat([
                edge_h,
                _gather_mean(vert_h, edge_vert),
            ], dim=-1)))
            hex_h = torch.relu(self.hex_msg(torch.cat([
                hex_h,
                _gather_mean(vert_h, hex_vert),
            ], dim=-1)))
        return hex_h, vert_h, edge_h

    def forward_decision(
        self,
        global_x: torch.Tensor,
        hex_h: torch.Tensor,
        vert_h: torch.Tensor,
        edge_h: torch.Tensor,
        cand_type: torch.Tensor,
        cand_node: torch.Tensor,
        cand_payload: torch.Tensor,
        mask: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        pooled = torch.cat([hex_h.mean(dim=1), vert_h.mean(dim=1), edge_h.mean(dim=1)], dim=-1)
        state = self.fuse(torch.cat([global_x, pooled], dim=-1))
        node = _select_entity(hex_h, vert_h, edge_h, cand_node)
        projected = self.candidate(torch.cat([node, cand_type, cand_payload], dim=-1))
        logits = (state.unsqueeze(1) * projected).sum(dim=-1)
        logits = logits.masked_fill(~mask, -1.0e9)
        value = torch.sigmoid(self.value_head(state)).squeeze(-1)
        return logits, value


def _select_entity(hex_h: torch.Tensor, vert_h: torch.Tensor, edge_h: torch.Tensor, cand_node: torch.Tensor) -> torch.Tensor:
    """cand_node [B, N, 2] is (kind, index). kind 1 vertex, 2 edge, 3 hex."""
    batch, count, _two = cand_node.shape
    device = hex_h.device
    batch_index = torch.arange(batch, device=device).unsqueeze(1).expand(batch, count)
    kind = cand_node[:, :, 0]
    raw = cand_node[:, :, 1].clamp(min=0)
    vert_index = torch.where(kind == 1, raw, torch.zeros_like(raw)).clamp(max=vert_h.size(1) - 1)
    edge_index = torch.where(kind == 2, raw, torch.zeros_like(raw)).clamp(max=edge_h.size(1) - 1)
    hex_index = torch.where(kind == 3, raw, torch.zeros_like(raw)).clamp(max=hex_h.size(1) - 1)
    zeros = torch.zeros(batch, count, NODE_DIM, device=device, dtype=hex_h.dtype)
    vert = vert_h[batch_index, vert_index]
    edge = edge_h[batch_index, edge_index]
    hex_picked = hex_h[batch_index, hex_index]
    picked = torch.where((kind == 1).unsqueeze(-1), vert, zeros)
    picked = torch.where((kind == 2).unsqueeze(-1), edge, picked)
    picked = torch.where((kind == 3).unsqueeze(-1), hex_picked, picked)
    return picked


def collate_graph(
    examples: list[dict],
    device: torch.device,
    global_fn=None,
    global_dim: int = GLOBAL_DIM,
) -> dict[str, torch.Tensor | list]:
    encode_global = global_fn or global_vector
    encoded = [board_tensors(example["observation"]) for example in examples]
    parts = [candidate_parts(example["observation"]) for example in examples]
    width = max(part["type"].size(0) for part in parts)
    batch = len(examples)
    hex_x = torch.stack([item["hex_x"] for item in encoded]).to(device)
    vert_x = torch.stack([item["vert_x"] for item in encoded]).to(device)
    edge_x = torch.stack([item["edge_x"] for item in encoded]).to(device)
    adjacency = encoded[0]
    for item in encoded[1:]:
        if not torch.equal(item["edge_vert"], adjacency["edge_vert"]):
            raise ValueError("a batch mixed two board topologies")
    cand_type = torch.zeros(batch, width, len(ACTIONS) + 1, device=device)
    cand_payload = torch.zeros(batch, width, PAYLOAD_DIM, device=device)
    cand_node = torch.zeros(batch, width, 2, dtype=torch.long, device=device)
    mask = torch.zeros(batch, width, dtype=torch.bool, device=device)
    chosen = torch.zeros(batch, dtype=torch.long, device=device)
    wins = torch.zeros(batch, device=device)
    completed = torch.zeros(batch, dtype=torch.bool, device=device)
    ids: list[list[str]] = []
    global_x = torch.zeros(batch, global_dim, device=device)
    for index, example in enumerate(examples):
        count = parts[index]["type"].size(0)
        cand_type[index, :count] = parts[index]["type"].to(device)
        cand_payload[index, :count] = parts[index]["payload"].to(device)
        cand_node[index, :count] = parts[index]["node"].to(device)
        mask[index, :count] = True
        action_ids = parts[index]["ids"]
        ids.append(action_ids)
        if example["chosen_action_id"] not in action_ids:
            raise ValueError("chosen action is not legal")
        chosen[index] = action_ids.index(example["chosen_action_id"])
        global_x[index] = torch.tensor(encode_global(example["observation"]), dtype=torch.float32, device=device)
        if example["completion_status"] == "completed" and example["actor_win"] is not None:
            completed[index] = True
            wins[index] = float(example["actor_win"])
    return {
        "hex_x": hex_x,
        "vert_x": vert_x,
        "edge_x": edge_x,
        "vert_hex": adjacency["vert_hex"].to(device),
        "vert_edge": adjacency["vert_edge"].to(device),
        "edge_vert": adjacency["edge_vert"].to(device),
        "hex_vert": adjacency["hex_vert"].to(device),
        "global_x": global_x,
        "cand_type": cand_type,
        "cand_node": cand_node,
        "cand_payload": cand_payload,
        "mask": mask,
        "chosen": chosen,
        "wins": wins,
        "completed": completed,
        "ids": ids,
    }


def graph_logits(model: GraphPolicyValueNet, batch: dict, device: torch.device | None = None) -> tuple[torch.Tensor, torch.Tensor]:
    del device
    hex_h, vert_h, edge_h = model.encode_board(
        batch["hex_x"], batch["vert_x"], batch["edge_x"],
        batch["vert_hex"], batch["vert_edge"], batch["edge_vert"], batch["hex_vert"],
    )
    return model.forward_decision(
        batch["global_x"], hex_h, vert_h, edge_h,
        batch["cand_type"], batch["cand_node"], batch["cand_payload"], batch["mask"],
    )


def score_graph(model: GraphPolicyValueNet, observation: dict, device: torch.device) -> list[tuple[str, float]]:
    model.eval()
    example = {
        "observation": observation,
        "chosen_action_id": observation["candidates"][0]["action_id"],
        "completion_status": "incomplete",
        "actor_win": None,
        "cutoff_reason": "diagnostic",
    }
    with torch.no_grad():
        from .tracked import FEATURE_VERSION_V5, GLOBAL_DIM_V4, global_vector_v4

        if model.feature_version == FEATURE_VERSION_V5:
            batch = collate_graph([example], device, global_fn=global_vector_v4, global_dim=GLOBAL_DIM_V4)
        else:
            batch = collate_graph([example], device)
        logits, _value = graph_logits(model, batch)
        ids = batch["ids"][0]
        return [(action_id, float(logits[0, index].item())) for index, action_id in enumerate(ids)]
