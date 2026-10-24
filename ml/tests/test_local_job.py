import json
from pathlib import Path

from colonist_ml.local_job import report, run_supervised, validate_config


def test_supervised_job_resumes_and_keeps_the_previous_checkpoint(tmp_path):
    root = Path(__file__).resolve().parents[2]
    data = root / "ml" / "fixtures" / "synthetic_decisions.jsonl"
    first = {
        "kind": "supervised",
        "data": str(data),
        "out": str(tmp_path / "job"),
        "epochs": 1,
        "batch_size": 4,
        "seed": 7,
        "learning_rate": 0.001,
        "device": "cpu",
    }
    validate_config(first)
    run_supervised(first, resume=False)
    latest = tmp_path / "job" / "latest.pt"
    first_bytes = latest.read_bytes()
    second = dict(first)
    second["epochs"] = 2
    run_supervised(second, resume=True)
    summary = report(str(tmp_path / "job"))
    assert summary["latest_epoch"] == 2
    assert summary["best_exists"] is True
    assert summary["previous_exists"] is True
    assert (tmp_path / "job" / "latest.pt.prev").read_bytes() == first_bytes
    assert summary["last"]["epoch"] == 2
    assert summary["last"]["event"] == "epoch"
    status = [json.loads(line) for line in (tmp_path / "job" / "status.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [row["epoch"] for row in status] == [1, 2]
    assert "incomplete_games" in status[-1]
    assert status[-1]["incomplete_games"] >= 1
    assert status[-1]["completed_games"] >= 1
    assert status[-1]["previous_sha256"] == status[0]["checkpoint_sha256"]


def test_interrupted_run_resumes_and_matches_an_uninterrupted_run(tmp_path):
    root = Path(__file__).resolve().parents[2]
    data = root / "ml" / "fixtures" / "synthetic_decisions.jsonl"
    examples = [json.loads(line) for line in data.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert any(example["completion_status"] == "completed" and example["actor_win"] is not None for example in examples)
    assert any(example["completion_status"] == "incomplete" and example["actor_win"] is None for example in examples)
    assert not any(example["completion_status"] != "completed" and example["actor_win"] is not None for example in examples)

    def config(directory: Path) -> dict:
        return {
            "kind": "supervised",
            "data": str(data),
            "out": str(directory),
            "epochs": 3,
            "batch_size": 4,
            "seed": 7,
            "learning_rate": 0.001,
            "device": "cpu",
        }

    straight = config(tmp_path / "straight")
    interrupted = config(tmp_path / "interrupted")
    run_supervised(straight, resume=False)
    first = run_supervised(interrupted, resume=False, stop_after_epoch=1)
    assert first["stopped"] is True
    assert first["epoch"] == 1
    assert first["optimizer_steps"] == 1
    paused = report(str(tmp_path / "interrupted"))
    assert paused["latest_epoch"] == 1
    paused_hash = paused["weight_sha256"]
    paused_file = (tmp_path / "interrupted" / "latest.pt").read_bytes()
    from colonist_ml.checkpoint import load_checkpoint
    import torch

    _model, _optimizer, payload = load_checkpoint(str(tmp_path / "interrupted" / "latest.pt"), torch.device("cpu"), restore_rng=True)
    assert torch.equal(torch.get_rng_state(), payload["torch_rng_state"].cpu() if hasattr(payload["torch_rng_state"], "cpu") else payload["torch_rng_state"])
    resumed = run_supervised(interrupted, resume=True)
    assert resumed["stopped"] is False
    assert resumed["epoch"] == 3
    assert resumed["optimizer_steps"] > first["optimizer_steps"]
    assert resumed["weight_sha256"] != paused_hash
    assert (tmp_path / "interrupted" / "latest.pt.prev").is_file()
    status = [json.loads(line) for line in (tmp_path / "interrupted" / "status.jsonl").read_text(encoding="utf-8").splitlines()]
    epoch_rows = [row for row in status if row["event"] == "epoch"]
    assert [row["epoch"] for row in epoch_rows] == [1, 2, 3]
    assert epoch_rows[1]["previous_sha256"] == epoch_rows[0]["checkpoint_sha256"]
    assert epoch_rows[0]["checkpoint_sha256"] == __import__("hashlib").sha256(paused_file).hexdigest()
    assert any(row["event"] == "stopped" and row["reason"] == "stop_after_epoch" for row in status)
    finished = report(str(tmp_path / "straight"))
    assert finished["weight_sha256"] == resumed["weight_sha256"]
    assert json.loads((tmp_path / "interrupted" / "config.json").read_text(encoding="utf-8"))["epochs"] == 3


def test_stop_file_halts_before_the_next_epoch_and_resume_continues_after_removal(tmp_path):
    root = Path(__file__).resolve().parents[2]
    data = root / "ml" / "fixtures" / "synthetic_decisions.jsonl"
    directory = tmp_path / "stop-file"
    config = {
        "kind": "supervised",
        "data": str(data),
        "out": str(directory),
        "epochs": 2,
        "batch_size": 4,
        "seed": 7,
        "learning_rate": 0.001,
        "device": "cpu",
    }
    first = run_supervised(config, resume=False, stop_after_epoch=1)
    assert first["epoch"] == 1
    (directory / "STOP").write_text("stop\n", encoding="utf-8")
    halted = run_supervised(config, resume=True)
    assert halted["stopped"] is True
    assert halted["epoch"] == 1
    assert halted["loss"] is None
    (directory / "STOP").unlink()
    finished = run_supervised(config, resume=True)
    assert finished["stopped"] is False
    assert finished["epoch"] == 2
    assert finished["optimizer_steps"] > first["optimizer_steps"]
