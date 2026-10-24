"""Action representation, permutation invariance, and the predeclared imitation bars."""

import copy
from pathlib import Path

import torch
import torch.nn.functional as F

from colonist_ml.checkpoint import load_checkpoint
from colonist_ml.features import ACTIONS, CANDIDATE_DIM, GLOBAL_DIM, candidate_matrix, encode_observation, global_vector
from colonist_ml.fidelity import HELDOUT_LIFT_OVER_CHANCE, HELDOUT_TOP1_MIN, OVERFIT_TOP1_MIN
from colonist_ml.model import PolicyValueNet
from colonist_ml.schema import load_jsonl
from colonist_ml.train import collate, predict_action, score_candidates

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "synthetic_decisions.jsonl"


def _observation(hand_lumber: int, candidates: list[dict], phase: str = "main") -> dict:
    return {
        "phase": phase,
        "dice_mode": "balanced",
        "victory_points_to_win": 10,
        "robber_resource": "ore",
        "actor": {
            "hand": {"lumber": hand_lumber, "brick": 0, "wool": 0, "grain": 0, "ore": 0},
            "dev_cards": {},
            "production": {"lumber": 1, "brick": 1, "wool": 0, "grain": 2, "ore": 0},
            "public_vp": 2,
            "settlements_left": 3,
            "cities_left": 4,
            "roads_left": 13,
        },
        "opponents": [
            {
                "public_vp": 2,
                "hand_size": 3,
                "settlements": 2,
                "cities": 0,
                "road_length": 2,
                "knights_played": 0,
                "has_longest_road": False,
                "has_largest_army": False,
            },
            {},
        ],
        "bank": {"lumber": 19, "brick": 19, "wool": 19, "grain": 19, "ore": 19},
        "candidates": candidates,
    }


def _road(index: int, own_road: int = 0) -> dict:
    return {
        "action_id": f"buildRoad:e{index}",
        "type": "buildRoad",
        "public_features": {
            "corner_index": -1,
            "edge_index": index,
            "hex_index": -1,
            "corner_pips": 0,
            "edge_pips": 4,
            "hex_pips": 0,
            "lumber_pips": 1,
            "brick_pips": 1,
            "touches_own_road": own_road,
            "cost_lumber": 1,
            "cost_brick": 1,
        },
    }


def _labeled(observation: dict, chosen: str) -> dict:
    return {
        "observation": observation,
        "chosen_action_id": chosen,
        "completion_status": "completed",
        "actor_win": 1,
    }


class _AdditiveScorer(torch.nn.Module):
    """The previous scorer: a state term added to every candidate, then a candidate term."""

    def __init__(self):
        super().__init__()
        self.encoder = torch.nn.Sequential(
            torch.nn.Linear(GLOBAL_DIM, 64),
            torch.nn.ReLU(),
            torch.nn.Linear(64, 64),
            torch.nn.ReLU(),
        )
        self.scorer = torch.nn.Linear(64 + CANDIDATE_DIM, 1)

    def forward(self, global_x, candidates, mask):
        hidden = self.encoder(global_x)
        expanded = hidden.unsqueeze(1).expand(-1, candidates.size(1), -1)
        logits = self.scorer(torch.cat([expanded, candidates], dim=-1)).squeeze(-1)
        return logits.masked_fill(~mask, -1.0e9)


def _argmax_id(model, observation) -> str:
    device = torch.device("cpu")
    global_x, candidates, ids = encode_observation(observation, device)
    mask = torch.ones(1, candidates.size(0), dtype=torch.bool)
    logits = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
    if isinstance(logits, tuple):
        logits = logits[0]
    return ids[int(torch.argmax(logits[0]).item())]


def test_acceptance_bars_stay_at_the_predeclared_values():
    assert OVERFIT_TOP1_MIN == 0.90
    assert HELDOUT_TOP1_MIN == 0.40
    assert HELDOUT_LIFT_OVER_CHANCE == 0.20


def test_each_action_type_has_a_distinct_row():
    rows = []
    for name in ACTIONS:
        observation = _observation(
            0,
            [{"action_id": name, "type": name, "public_features": {"corner_index": -1, "edge_index": -1, "hex_index": -1}}],
        )
        matrix, ids = candidate_matrix(observation)
        assert ids == [name]
        assert len(matrix[0]) == CANDIDATE_DIM
        rows.append(tuple(matrix[0][: len(ACTIONS) + 1]))
    assert len(set(rows)) == len(ACTIONS)


def test_same_pip_edges_are_different_vectors_and_setup_is_not_a_paid_build():
    left = candidate_matrix(_observation(1, [_road(3, own_road=1)]))[0][0]
    right = candidate_matrix(_observation(1, [_road(9, own_road=1)]))[0][0]
    assert left != right
    setup = {
        "action_id": "placeSetupSettlement:c4",
        "type": "placeSetupSettlement",
        "public_features": {"corner_index": 4, "edge_index": -1, "hex_index": -1, "corner_pips": 5, "cost_lumber": 0},
    }
    paid = {
        "action_id": "buildSettlement:c4",
        "type": "buildSettlement",
        "public_features": {
            "corner_index": 4,
            "edge_index": -1,
            "hex_index": -1,
            "corner_pips": 5,
            "cost_lumber": 1,
            "cost_brick": 1,
            "cost_wool": 1,
            "cost_grain": 1,
        },
    }
    setup_row = candidate_matrix(_observation(0, [setup], phase="setup_settlement"))[0][0]
    paid_row = candidate_matrix(_observation(4, [paid], phase="main"))[0][0]
    assert setup_row != paid_row


def test_opponent_hand_and_dropped_board_do_not_change_features():
    examples, _dropped = load_jsonl(str(FIXTURE), held_out_seeds=set())
    observation = examples[0]["observation"]
    original = global_vector(observation)
    leaked = copy.deepcopy(observation)
    leaked["opponents"][0]["hand"] = {"ore": 8}
    leaked["devDeckOrder"] = ["knight"]
    assert global_vector(leaked) == original
    full = copy.deepcopy(observation)
    full["board"] = {"hexes": [{"resource": "ore"}], "corners": [], "edges": []}
    full["placements"] = {"corners": [{"owner": "c2"}], "edges": []}
    full["candidates"] = [{**candidate, "simulator": {"type": "endTurn"}} for candidate in full["candidates"]]
    summary = copy.deepcopy(full)
    summary["board"] = {"hexes": [], "corners": [], "edges": []}
    summary["placements"] = {"corners": [], "edges": []}
    summary["candidates"] = [{key: value for key, value in candidate.items() if key != "simulator"} for candidate in summary["candidates"]]
    assert global_vector(full) == global_vector(summary)
    assert candidate_matrix(full)[0] == candidate_matrix(summary)[0]


def test_reordering_candidates_keeps_each_action_score():
    examples, _dropped = load_jsonl(str(FIXTURE), held_out_seeds=set())
    observation = examples[0]["observation"]
    model = PolicyValueNet()
    device = torch.device("cpu")
    original = dict(score_candidates(model, observation, device))
    flipped = copy.deepcopy(observation)
    flipped["candidates"] = list(reversed(flipped["candidates"]))
    reordered = dict(score_candidates(model, flipped, device))
    assert set(original) == set(reordered)
    for action_id, score in original.items():
        assert abs(score - reordered[action_id]) < 1e-5
    assert predict_action(model, flipped, device) == predict_action(model, observation, device)


def test_padding_cannot_win_and_train_matches_predict():
    examples, _dropped = load_jsonl(str(FIXTURE), held_out_seeds=set())
    device = torch.device("cpu")
    model = PolicyValueNet().to(device)
    model.eval()
    batch = collate(examples, device)
    logits, _values = model(batch["global_x"], batch["candidates"], batch["mask"])
    for index, example in enumerate(examples):
        legal = len(example["observation"]["candidates"])
        assert int(torch.argmax(logits[index]).item()) < legal
        chosen = predict_action(model, example["observation"], device)
        ids = [candidate["action_id"] for candidate in example["observation"]["candidates"]]
        assert chosen == ids[int(torch.argmax(logits[index]).item())]
        assert bool(batch["mask"][index, legal:].any()) is False or legal == batch["mask"].size(1)


def test_additive_scorer_cannot_change_its_ranking_with_the_state():
    candidates = [_road(3, own_road=1), _road(9, own_road=0)]
    low = _observation(0, candidates)
    high = _observation(6, candidates)
    model = _AdditiveScorer()
    assert _argmax_id(model, low) == _argmax_id(model, high)


def test_state_can_change_which_candidate_wins():
    candidates = [_road(3, own_road=1), _road(9, own_road=0)]
    examples = [
        _labeled(_observation(0, candidates), "buildRoad:e3"),
        _labeled(_observation(6, candidates), "buildRoad:e9"),
    ]
    device = torch.device("cpu")
    torch.manual_seed(7)
    model = PolicyValueNet().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=5e-2)
    for _epoch in range(80):
        batch = collate(examples, device)
        optimizer.zero_grad(set_to_none=True)
        logits, _values = model(batch["global_x"], batch["candidates"], batch["mask"])
        loss = F.cross_entropy(logits, batch["chosen"])
        loss.backward()
        optimizer.step()
    assert predict_action(model, examples[0]["observation"], device) == "buildRoad:e3"
    assert predict_action(model, examples[1]["observation"], device) == "buildRoad:e9"


def test_rare_action_types_get_a_larger_training_weight():
    from colonist_ml.train import behavior_weights

    examples = [{"chosen_action_id": "buildRoad:e1"}] + [{"chosen_action_id": "endTurn"}] * 8
    weights = behavior_weights(examples)
    assert weights[0] > weights[-1]
    assert abs(sum(weights) / len(weights) - 1.0) < 1e-6


def test_v1_checkpoint_does_not_load(tmp_path):
    path = tmp_path / "old.pt"
    torch.save(
        {"schema_version": "colonist_checkpoint_v2", "feature_version": "colonist_features_v1", "hidden": 64, "model": {}},
        path,
    )
    try:
        load_checkpoint(str(path), torch.device("cpu"))
    except ValueError as error:
        assert "features" in str(error)
    else:
        raise AssertionError("v1 features loaded into the v2 model")
