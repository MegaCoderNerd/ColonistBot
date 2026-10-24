import math
from pathlib import Path

import torch

from colonist_ml.algorithm import (
    advantages,
    assign_batch_advantages,
    bootstrap_mean,
    label_decision,
    ppo_losses,
    ppo_update,
    row_is_trainable,
    summarize_games,
    two_player_scores_sum_to_one,
)
from colonist_ml.checkpoint import load_checkpoint, save_checkpoint
from colonist_ml.features import encode_observation
from colonist_ml.model import PolicyValueNet
from colonist_ml.protocol import (
    DEV_SEEDS,
    DIAGNOSTIC_SEEDS,
    FINAL_SEEDS,
    HEURISTIC_SEEDS,
    OPPONENT_MIXTURE,
    assert_launch_seed,
    reserved_seeds,
    retention_decision,
)
from colonist_ml.rl import EVAL_SEEDS, TRAIN_SEEDS, reinforce_loss
from colonist_ml.schema import load_jsonl
from colonist_ml.train import parameter_vector

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "synthetic_decisions.jsonl"


def _observation():
    return load_jsonl(str(FIXTURE))[0][0]["observation"]


def _row(action_index: int, actor_win: float, old_log_prob: float, old_value: float, policy: str = "neural_vs_opponent"):
    return {
        "observation": _observation(),
        "action_index": action_index,
        "legal_count": 2,
        "actor_win": actor_win,
        "old_log_prob": old_log_prob,
        "old_value": old_value,
        "generating_policy": policy,
        "completion_status": "completed",
        "bootstrap": False,
        "actor_id": "c1",
    }


def _probability(model, observation, index: int) -> float:
    global_x, candidates, _ids = encode_observation(observation, torch.device("cpu"))
    mask = torch.ones(1, candidates.size(0), dtype=torch.bool)
    logits, _value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
    return float(torch.softmax(logits, dim=-1)[0, index])


def test_clipped_surrogate_matches_the_formula_and_stops_the_gradient():
    old = torch.tensor([0.0])
    new = torch.tensor([math.log(2.0)], requires_grad=True)
    advantage = torch.tensor([1.0])
    loss, parts = ppo_losses(
        new,
        old,
        torch.tensor([0.0]),
        torch.tensor([0.5], requires_grad=True),
        torch.tensor([1.0]),
        advantage,
        clip_eps=0.2,
        value_coef=0.0,
        entropy_coef=0.0,
    )
    assert abs(parts["policy"] - (-1.2)) < 1e-5
    loss.backward()
    assert abs(float(new.grad)) < 1e-5

    fresh = torch.tensor([0.0], requires_grad=True)
    unclipped, _parts = ppo_losses(
        fresh,
        torch.tensor([0.0]),
        torch.tensor([0.0]),
        torch.tensor([0.4], requires_grad=True),
        torch.tensor([1.0]),
        torch.tensor([1.0]),
        value_coef=0.0,
        entropy_coef=0.0,
    )
    unclipped.backward()
    assert abs(float(fresh.grad) - (-1.0)) < 1e-5


def test_actor_return_is_that_seats_score_and_a_cutoff_is_not_a_loss():
    terminal = {"completion_status": "completed", "cutoff_reason": None, "actor_win": {"c1": 0.0, "c2": 1.0}}
    assert two_player_scores_sum_to_one(terminal["actor_win"])
    labeled = label_decision({"actor_id": "c1", "generating_policy": "neural_vs_opponent"}, terminal)
    assert labeled["actor_win"] == 0.0
    other = label_decision({"actor_id": "c2", "generating_policy": "neural_self_play"}, terminal)
    assert other["actor_win"] == 1.0
    cutoff = label_decision(
        {"actor_id": "c1"},
        {"completion_status": "incomplete", "cutoff_reason": "max_turns_reached", "actor_win": {"c1": None, "c2": None}, "scores": {"c1": {"actual_vp": 7}}},
    )
    assert cutoff["actor_win"] is None
    assert row_is_trainable(cutoff) is False
    heuristic = _row(0, 1.0, -0.2, 0.4, policy="baseline_heuristic_v1")
    assert row_is_trainable(heuristic) is False
    assert row_is_trainable({**_row(0, 1.0, -0.2, 0.4), "bootstrap": True}) is False
    assert row_is_trainable(_row(0, 1.0, -0.2, 0.4)) is True


def test_advantages_are_standardized_once_for_the_batch():
    returns = torch.tensor([1.0, 0.0, 1.0, 0.0])
    values = torch.tensor([0.2, 0.2, 0.8, 0.8])
    assigned = advantages(returns, values)
    rows = [_row(0, float(returns[index]), -0.1, float(values[index])) for index in range(4)]
    assign_batch_advantages(rows)
    assert torch.allclose(assigned, torch.tensor([row["advantage"] for row in rows]))
    flat = advantages(torch.tensor([0.5, 0.5]), torch.tensor([0.5, 0.5]))
    assert torch.allclose(flat, torch.zeros(2))


def test_a_win_and_a_loss_move_the_policy_in_opposite_directions():
    observation = _observation()

    def probability_after(actor_win: float) -> float:
        torch.manual_seed(4)
        model = PolicyValueNet()
        global_x, candidates, _ids = encode_observation(observation, torch.device("cpu"))
        mask = torch.ones(1, candidates.size(0), dtype=torch.bool)
        logits, value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
        distribution = torch.distributions.Categorical(logits=logits)
        row = _row(0, actor_win, float(distribution.log_prob(torch.tensor([0]))), float(value.reshape(-1)[0]))
        optimizer = torch.optim.Adam(model.parameters(), lr=5e-2)
        ppo_update(model, optimizer, [row, dict(row)], torch.device("cpu"), epochs=6, minibatch_size=2)
        return _probability(model, observation, 0)

    initial = _probability(PolicyValueNet(), observation, 0)
    torch.manual_seed(4)
    initial = _probability(PolicyValueNet(), observation, 0)
    won = probability_after(1.0)
    lost = probability_after(0.0)
    assert won > lost
    assert won > initial


def test_mask_keeps_samples_on_legal_actions_and_padding_does_not_change_log_prob():
    torch.manual_seed(1)
    model = PolicyValueNet()
    observation = _observation()
    global_x, candidates, ids = encode_observation(observation, torch.device("cpu"))
    mask = torch.tensor([[False, True]])
    logits, _value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
    assert float(logits[0, 0]) < -1.0e8
    distribution = torch.distributions.Categorical(logits=logits)
    assert {int(distribution.sample().item()) for _ in range(30)} == {1}
    assert ids[1] == "buildRoad:e3"
    full_mask = torch.ones(1, candidates.size(0), dtype=torch.bool)
    full_logits, _value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), full_mask)
    padded = torch.nn.functional.pad(full_logits, (0, 2), value=-1.0e9)
    full_log = torch.distributions.Categorical(logits=full_logits).log_prob(torch.tensor([1]))
    padded_log = torch.distributions.Categorical(logits=padded).log_prob(torch.tensor([1]))
    assert torch.allclose(full_log, padded_log, atol=1e-5)


def test_repeated_updates_and_resume_are_reproducible(tmp_path):
    observation = _observation()

    def once(seed: int):
        torch.manual_seed(seed)
        model = PolicyValueNet()
        global_x, candidates, _ids = encode_observation(observation, torch.device("cpu"))
        logits, value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), torch.ones(1, candidates.size(0), dtype=torch.bool))
        distribution = torch.distributions.Categorical(logits=logits)
        row = _row(1, 1.0, float(distribution.log_prob(torch.tensor([1]))), float(value.reshape(-1)[0]))
        optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
        ppo_update(model, optimizer, [row, dict(row)], torch.device("cpu"), epochs=2, minibatch_size=2)
        return parameter_vector(model)

    assert torch.equal(once(9), once(9))
    torch.manual_seed(3)
    model = PolicyValueNet()
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    save_checkpoint(
        str(tmp_path / "step_000002.pt"),
        model,
        optimizer,
        epoch=2,
        seed=3,
        manifest={"external_colonist_games": 0},
        step=2,
        algorithm={"name": "terminal_return_ppo"},
        next_launch_index=4,
        completed_trajectories=3,
        decisions_used=20,
    )
    expected_next = torch.rand(1).clone()
    torch.rand(4)
    loaded, _loaded_optimizer, payload = load_checkpoint(str(tmp_path / "step_000002.pt"), torch.device("cpu"), restore_rng=True)
    assert payload["step"] == 2
    assert payload["next_launch_index"] == 4
    assert payload["algorithm"]["name"] == "terminal_return_ppo"
    assert torch.equal(parameter_vector(model), parameter_vector(loaded))
    assert torch.equal(torch.rand(1), expected_next)
    save_checkpoint(str(tmp_path / "step_000004.pt"), loaded, _loaded_optimizer, epoch=4, seed=3, manifest={"external_colonist_games": 0}, step=4)
    assert (tmp_path / "step_000002.pt").exists()
    assert (tmp_path / "step_000004.pt").exists()


def test_update_counts_are_not_game_counts_and_seeds_stay_apart():
    games = [
        {"terminal": {"completion_status": "completed"}, "decisions": [{}]},
        {"terminal": {"completion_status": "incomplete", "cutoff_reason": "max_turns_reached"}, "decisions": [{}]},
        {"terminal": {"completion_status": "incomplete", "cutoff_reason": "max_actions_reached"}, "decisions": [{}]},
        {"terminal": {"completion_status": "incomplete", "cutoff_reason": "invalid_state"}, "decisions": []},
    ]
    summary = summarize_games(games, gradient_steps=5, decisions_used=11)
    assert summary["launched"] == 4
    assert summary["completed"] == 1
    assert summary["eligible_for_updates"] == 1
    assert summary["gradient_steps"] == 5
    assert summary["decisions_used"] == 11
    assert summary["gradient_steps"] != summary["launched"]
    assert summary["cutoffs_by_reason"]["max_turns_reached"] == 1
    assert summary["failures"] == 1
    assert set(DEV_SEEDS).isdisjoint(FINAL_SEEDS)
    assert set(DEV_SEEDS).isdisjoint(DIAGNOSTIC_SEEDS)
    assert set(HEURISTIC_SEEDS).issubset(reserved_seeds())
    assert set(TRAIN_SEEDS).isdisjoint(EVAL_SEEDS)
    assert_launch_seed("ml-rl-phase2-0", "ml-rl-phase2-")
    try:
        assert_launch_seed("ml-rl-final-0", "ml-rl-phase2-")
    except ValueError:
        pass
    else:
        raise AssertionError("final seed was accepted for training")
    refused = retention_decision({"n": 4, "low": 0.2, "high": 0.4, "mean": 0.3}, 0.1, 0.1)
    assert refused["retained"] == "supervised"
    rejected_cutoff = retention_decision({"n": 10, "low": 0.05, "high": 0.2, "mean": 0.1}, 0.5, 0.2)
    assert rejected_cutoff["retained"] == "supervised"
    adopted = retention_decision({"n": 10, "low": 0.01, "high": 0.2, "mean": 0.1}, 0.25, 0.2)
    assert adopted["adopted_self_play"] is True
    assert "production_aware_dev_card_v1" not in {item["opponent"] for item in OPPONENT_MIXTURE}
    interval = bootstrap_mean([0.0, 1.0, 1.0])
    assert interval["n"] == 3
    assert interval["low"] <= interval["mean"] <= interval["high"]
    # The previous one-game estimator still has the terminal-return sign.
    log_prob = torch.tensor([0.0], requires_grad=True)
    value = torch.tensor([0.2], requires_grad=True)
    loss = reinforce_loss([log_prob], [value], [torch.tensor([0.1])], 1.0)
    loss.backward()
    assert float(log_prob.grad) < 0


def test_a_constant_loss_return_leaves_no_policy_advantage():
    """Every completed game as a loss, with a value head that has fit that constant, has advantage 0.

    The policy term is then 0. Entropy can still move the parameters. That is an uninformative
    batch, not a wrong advantage formula. Differing value predictions still spread advantages.
    """
    returns = torch.zeros(6)
    values = torch.zeros(6)
    advantage = advantages(returns, values)
    assert torch.count_nonzero(advantage) == 0
    log_prob = torch.zeros(6, requires_grad=True)
    value_head = torch.zeros(6, requires_grad=True)
    _loss, stats = ppo_losses(
        log_prob,
        torch.zeros(6),
        torch.ones(6),
        value_head,
        returns,
        advantage,
    )
    assert stats["policy"] == 0.0
    spread = advantages(torch.zeros(4), torch.tensor([0.0, 0.0, 1.0, 1.0]))
    assert float(spread.std(unbiased=False)) > 0.5
