"""Masked policy and value network. It scores legal candidates. It does not invent actions."""

from __future__ import annotations

import torch
from torch import nn

from .features import CANDIDATE_DIM, FEATURE_VERSION, GLOBAL_DIM


class PolicyValueNet(nn.Module):
    def __init__(self, hidden: int = 64, global_dim: int = GLOBAL_DIM, feature_version: str = FEATURE_VERSION, candidate_dim: int = CANDIDATE_DIM):
        super().__init__()
        self.feature_version = feature_version
        self.global_dim = global_dim
        self.candidate_dim = candidate_dim
        self.hidden = hidden
        self.encoder = nn.Sequential(
            nn.Linear(global_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
        )
        # A linear layer on concat(state, candidate) adds the same state term to
        # every candidate, so the ranking cannot depend on the hand or the phase.
        # The product lets the state change which candidate wins. Hidden width stays 64.
        self.candidate_encoder = nn.Linear(candidate_dim, hidden)
        self.value_head = nn.Linear(hidden, 1)

    def forward(self, global_x: torch.Tensor, candidates: torch.Tensor, mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        hidden = self.encoder(global_x)
        projected = self.candidate_encoder(candidates)
        logits = (hidden.unsqueeze(1) * projected).sum(dim=-1)
        logits = logits.masked_fill(~mask, -1.0e9)
        value = torch.sigmoid(self.value_head(hidden)).squeeze(-1)
        return logits, value
