import json
from pathlib import Path

import torch

from colonist_ml.checkpoint import load_checkpoint, save_checkpoint
from colonist_ml.features import CANDIDATE_DIM, GLOBAL_DIM, encode_observation
from colonist_ml.model import PolicyValueNet
from colonist_ml.rl import EVAL_SEEDS, TRAIN_SEEDS, gradient_eligible, reinforce_loss, seed_sets_are_disjoint
from colonist_ml.schema import ExampleError, game_split, load_jsonl, validate_example
from colonist_ml.train import parameter_vector, predict_action, supervised_loss, train_steps

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "synthetic_decisions.jsonl"


def test_fixture_schema_and_no_leakage():
    examples, dropped = load_jsonl(str(FIXTURE), held_out_seeds=set(EVAL_SEEDS))
    assert dropped == 0
    assert len(examples) == 3
    assert {example["target_provenance"] for example in examples} == {"synthetic_fixture"}
    leaked = json.loads(FIXTURE.read_text(encoding="utf-8").splitlines()[0])
    leaked["observation"]["opponents"][0]["hand"] = {"ore": 4}
    try:
        validate_example(leaked)
    except ExampleError as error:
        assert "opponent hidden" in str(error)
    else:
        raise AssertionError("opponent hand was accepted")


def test_cutoff_is_not_a_result_and_held_out_seed_is_refused(tmp_path):
    cutoff = json.loads(FIXTURE.read_text(encoding="utf-8").splitlines()[2])
    cutoff["actor_win"] = 0
    try:
        validate_example(cutoff)
    except ExampleError as error:
        assert "incomplete" in str(error)
    else:
        raise AssertionError("cutoff was labeled as a loss")
    held = json.loads(FIXTURE.read_text(encoding="utf-8").splitlines()[0])
    held["seed"] = "ml-holdout-0"
    path = tmp_path / "held.jsonl"
    path.write_text(json.dumps(held) + "\n", encoding="utf-8")
    try:
        load_jsonl(str(path), held_out_seeds=set(EVAL_SEEDS))
    except ExampleError as error:
        assert "leaked" in str(error)
    else:
        raise AssertionError("held-out seed entered training")


def test_duplicates_drop_and_games_stay_together():
    examples, dropped = load_jsonl(str(FIXTURE))
    text = FIXTURE.read_text(encoding="utf-8") + FIXTURE.read_text(encoding="utf-8").splitlines()[0] + "\n"
    path_games = {example["game_id"] for example in examples}
    assert "fixture-game-a" in path_games
    splits = {}
    for index in range(40):
        game_id = f"game-{index}"
        splits[game_id] = game_split(game_id)
        assert game_split(game_id) == game_split(game_id)
    assert "train" in splits.values() and "eval" in splits.values()
    assert set(game_id for game_id, split in splits.items() if split == "train").isdisjoint(
        set(game_id for game_id, split in splits.items() if split == "eval")
    )
    same_game = [example for example in examples if example["game_id"] == "fixture-game-a"]
    assert len(same_game) == 2
    assert dropped == 0
    assert "endTurn" in text


def test_backprop_changes_parameters_and_cutoff_value_is_masked():
    examples, _dropped = load_jsonl(str(FIXTURE))
    torch.manual_seed(7)
    model = PolicyValueNet()
    before = parameter_vector(model).clone()
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
    train_steps(model, optimizer, examples, torch.device("cpu"), epochs=1)
    assert not torch.equal(before, parameter_vector(model))
    chosen = predict_action(model, examples[0]["observation"], torch.device("cpu"))
    assert chosen in {candidate["action_id"] for candidate in examples[0]["observation"]["candidates"]}
    batch_model = model
    batch_model.eval()
    from colonist_ml.train import collate

    cutoff_only = [example for example in examples if example["completion_status"] == "incomplete"]
    batch = collate(cutoff_only, torch.device("cpu"))
    logits, values = batch_model(batch["global_x"], batch["candidates"], batch["mask"])
    _loss, parts = supervised_loss(logits, values, batch)
    assert parts["value"] == 0.0
    assert bool(batch["mask"].all())


def test_mask_blocks_an_illegal_candidate_and_checkpoint_resumes(tmp_path):
    examples, _dropped = load_jsonl(str(FIXTURE))
    torch.manual_seed(7)
    model = PolicyValueNet()
    _global_x, candidates, ids = encode_observation(examples[0]["observation"], torch.device("cpu"))
    assert candidates.shape[-1] == CANDIDATE_DIM
    assert _global_x.numel() == GLOBAL_DIM
    mask = torch.tensor([[False, True]])
    logits, _value = model(_global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
    assert float(logits[0, 0]) < -1.0e8
    assert int(torch.argmax(logits).item()) == 1
    assert ids[1] == "buildRoad:e3"
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
    train_steps(model, optimizer, examples, torch.device("cpu"), epochs=1)
    path = tmp_path / "ckpt.pt"
    save_checkpoint(str(path), model, optimizer, epoch=1, seed=7, manifest={"examples": 3, "external_colonist_games": 0})
    saved = parameter_vector(model).clone()
    train_steps(model, optimizer, examples, torch.device("cpu"), epochs=1)
    loaded, loaded_optimizer, payload = load_checkpoint(str(path), torch.device("cpu"))
    assert payload["epoch"] == 1
    assert torch.equal(saved, parameter_vector(loaded))
    assert not torch.equal(saved, parameter_vector(model))
    train_steps(loaded, loaded_optimizer, examples, torch.device("cpu"), epochs=1)
    assert not torch.equal(saved, parameter_vector(loaded))


def test_reproducible_initialization_and_reinforce_on_a_completed_return():
    torch.manual_seed(11)
    first = PolicyValueNet()
    torch.manual_seed(11)
    second = PolicyValueNet()
    assert torch.equal(parameter_vector(first), parameter_vector(second))
    observation = json.loads(FIXTURE.read_text(encoding="utf-8").splitlines()[0])["observation"]
    assert predict_action(first, observation, torch.device("cpu")) == predict_action(second, observation, torch.device("cpu"))
    torch.manual_seed(3)
    model = PolicyValueNet()
    before = parameter_vector(model).clone()
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
    global_x, candidates, _ids = encode_observation(observation, torch.device("cpu"))
    mask = torch.ones(1, candidates.size(0), dtype=torch.bool)
    logits, value = model(global_x.unsqueeze(0), candidates.unsqueeze(0), mask)
    distribution = torch.distributions.Categorical(logits=logits)
    index = torch.tensor([0])
    loss = reinforce_loss([distribution.log_prob(index).squeeze(0)], [value.squeeze(0)], [distribution.entropy().squeeze(0)], 1.0)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
    assert not torch.equal(before, parameter_vector(model))
    assert seed_sets_are_disjoint()
    assert set(TRAIN_SEEDS).isdisjoint(EVAL_SEEDS)
    assert gradient_eligible({"completion_status": "incomplete", "actor_win": {"c1": None}}, [{"actor_id": "c1"}]) is False
    assert gradient_eligible({"completion_status": "completed", "actor_win": {"c1": 1}}, [{"actor_id": "c1"}]) is True
