import argparse
import json

import torch

from colonist_ml.cli import cmd_eval
from colonist_ml.evaluate import evaluate_against_baseline, parse_eval_seeds
from colonist_ml.model import PolicyValueNet
from colonist_ml.rl import EVAL_SEEDS


def test_omitted_seeds_stay_on_the_holdout_pair():
    assert parse_eval_seeds(None) is None
    assert EVAL_SEEDS == ("ml-holdout-0", "ml-holdout-1")


def test_parse_eval_seeds_strips_and_keeps_order():
    assert parse_eval_seeds(" ml-overnight-final-0, ml-overnight-final-99 ") == (
        "ml-overnight-final-0",
        "ml-overnight-final-99",
    )


def test_parse_eval_seeds_rejects_empty_and_duplicate_lists():
    for raw in ("", " ", ",", "ml-overnight-final-0,", ",ml-overnight-final-0", "ml-overnight-final-0,,ml-overnight-final-1"):
        try:
            parse_eval_seeds(raw)
        except ValueError as error:
            assert "nonempty" in str(error)
        else:
            raise AssertionError(f"accepted empty seeds: {raw!r}")
    try:
        parse_eval_seeds("ml-overnight-final-0,ml-overnight-final-0")
    except ValueError as error:
        assert "unique" in str(error)
    else:
        raise AssertionError("accepted a duplicate seed")


def test_parse_eval_seeds_rejects_training_and_selection_namespaces():
    reserved = (
        "ml-overnight-0",
        "ml-overnight-1",
        "ml-phase6-train-0",
        "ml-fidelity-fit-0",
        "ml-graph-train-0",
        "ml-rl-0",
        "ml-v4-match-0",
        "ml-v4-agg-train-0",
        "ml-v6-final-0",
        "ml-v6-strength-0",
        "ml-v7-strength-0",
        "ml-cutoff-probe-0",
    )
    for seed in reserved:
        try:
            parse_eval_seeds(f"{seed},ml-overnight-final-0")
        except ValueError as error:
            assert seed in str(error)
        else:
            raise AssertionError(f"accepted reserved seed {seed}")
    assert parse_eval_seeds("ml-holdout-0,ml-holdout-1") == EVAL_SEEDS


def test_custom_seeds_are_played_from_both_seats_and_cutoffs_stay_out_of_losses(monkeypatch):
    calls = []

    def fake_play(_bridge, _model, _device, payload, greedy=True):
        calls.append((payload["seed"], payload["learner"], payload["opponent"], greedy))
        completed = payload["seed"] == "ml-overnight-final-0" and payload["learner"] == "c1"
        failed = payload["seed"] == "ml-overnight-final-1" and payload["learner"] == "c2"
        if completed:
            status, reason = "completed", None
            scores = {"c1": {"actual_vp": 10}, "c2": {"actual_vp": 4}}
            actor_win = {"c1": 1, "c2": 0}
        elif failed:
            status, reason = "incomplete", "simulator_failure"
            scores = {}
            actor_win = {"c1": None, "c2": None}
        else:
            status, reason = "incomplete", "max_turns_reached"
            scores = {}
            actor_win = {"c1": None, "c2": None}
        return {
            "terminal": {
                "completion_status": status,
                "cutoff_reason": reason,
                "actor_win": actor_win,
                "turns": 7,
                "actions": 11,
                "opponent_policy": "baseline_heuristic_v1",
                "scores": scores,
                "limits": {},
            }
        }

    monkeypatch.setattr("colonist_ml.evaluate.play_game", fake_play)
    report = evaluate_against_baseline(
        None,
        PolicyValueNet(),
        torch.device("cpu"),
        "checkpoint.pt",
        10,
        70,
        450,
        ("ml-overnight-final-0", "ml-overnight-final-1"),
    )
    assert calls == [
        ("ml-overnight-final-0", "c1", "baseline_heuristic_v1", True),
        ("ml-overnight-final-0", "c2", "baseline_heuristic_v1", True),
        ("ml-overnight-final-1", "c1", "baseline_heuristic_v1", True),
        ("ml-overnight-final-1", "c2", "baseline_heuristic_v1", True),
    ]
    assert report["games"] == 4
    assert report["completed"] == 1
    assert report["incomplete"] == 3
    assert report["learner_wins"] == 1
    assert report["learner_losses"] == 0
    assert report["cutoffs_by_reason"] == {"max_turns_reached": 2, "simulator_failure": 1}
    assert report["failures"] == 1
    assert report["pairs_completed"] == 0
    assert report["limits"] == {"victory_points_to_win": 10, "max_turns": 70, "max_actions": 450}
    assert "cutoff is not a loss" in report["note"]


def test_cmd_eval_writes_the_json_report_for_the_requested_seeds(tmp_path, monkeypatch):
    monkeypatch.setattr("colonist_ml.cli.load_checkpoint", lambda *_args, **_kwargs: (PolicyValueNet(), None, {}))

    class Bridge:
        def close(self):
            self.closed = True

    bridge = Bridge()
    monkeypatch.setattr("colonist_ml.experiment.repo_root", lambda: tmp_path)
    monkeypatch.setattr("colonist_ml.rl.SimulatorBridge", lambda _root: bridge)

    def fake_eval(_bridge, _model, _device, checkpoint, vp, max_turns, max_actions, seeds):
        assert checkpoint == "ml/runs/overnight-small/best.pt"
        assert (vp, max_turns, max_actions) == (10, 70, 450)
        assert seeds == ("ml-overnight-final-0", "ml-overnight-final-1")
        return {
            "opponent": "baseline_heuristic_v1",
            "checkpoint": checkpoint,
            "seeds": list(seeds),
            "games": 4,
            "rows": [{"seed": seeds[0], "learner": "c1"}, {"seed": seeds[0], "learner": "c2"}],
            "note": "Completed games are the only win denominator. A cutoff is not a loss.",
        }

    monkeypatch.setattr("colonist_ml.cli.evaluate_against_baseline", fake_eval)
    out = tmp_path / "nested" / "eval-final-100.json"
    cmd_eval(
        argparse.Namespace(
            device="cpu",
            checkpoint="ml/runs/overnight-small/best.pt",
            out=str(out),
            vp=10,
            max_turns=70,
            max_actions=450,
            seeds="ml-overnight-final-0,ml-overnight-final-1",
        )
    )
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["seeds"] == ["ml-overnight-final-0", "ml-overnight-final-1"]
    assert written["rows"][0]["learner"] == "c1"
    assert written["rows"][1]["learner"] == "c2"
    assert bridge.closed is True


def test_default_eval_seeds_are_passed_through_when_the_flag_is_omitted(tmp_path, monkeypatch):
    seen = {}

    def fake_eval(*_args):
        seen["seeds"] = _args[7]
        return {"rows": [], "seeds": list(EVAL_SEEDS)}

    monkeypatch.setattr("colonist_ml.cli.load_checkpoint", lambda *_args, **_kwargs: (PolicyValueNet(), None, {}))
    monkeypatch.setattr("colonist_ml.experiment.repo_root", lambda: tmp_path)
    monkeypatch.setattr("colonist_ml.rl.SimulatorBridge", lambda _root: type("Bridge", (), {"close": lambda self: None})())
    monkeypatch.setattr("colonist_ml.cli.evaluate_against_baseline", fake_eval)
    cmd_eval(
        argparse.Namespace(
            device="cpu",
            checkpoint="best.pt",
            out=str(tmp_path / "eval.json"),
            vp=3,
            max_turns=20,
            max_actions=120,
            seeds=None,
        )
    )
    assert seen["seeds"] is None
    assert json.loads((tmp_path / "eval.json").read_text(encoding="utf-8"))["seeds"] == list(EVAL_SEEDS)
