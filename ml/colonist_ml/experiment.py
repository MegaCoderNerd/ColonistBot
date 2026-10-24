"""Controlled self-play. One process, a fixed opponent mixture, terminal-return PPO."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import torch

from .algorithm import ALGORITHM_NAME, bootstrap_mean, pair_scores, ppo_update, row_is_trainable, summarize_games
from .checkpoint import load_checkpoint, save_checkpoint
from .evaluate import evaluate_against_baseline
from .model import PolicyValueNet
from .protocol import (
    ALGORITHM,
    DEV_SEEDS,
    DIAGNOSTIC_SEEDS,
    EVAL_RULES,
    FINAL_SEEDS,
    HEURISTIC_SEEDS,
    OPPONENT_MIXTURE,
    SMOKE_PREFIX,
    SUPERVISED_EPOCHS,
    TRAIN_PREFIX,
    UPDATE_EVERY_COMPLETED,
    assert_launch_seed,
    retention_decision,
)
from .rl import SimulatorBridge, gradient_eligible, play_game, write_replay
from .schema import load_jsonl
from .train import parameter_vector, train_steps


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _save(path: Path, model, optimizer, epoch: int, seed: int, manifest: dict, step: int, next_launch: int, completed: int, decisions: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    save_checkpoint(
        str(path),
        model,
        optimizer,
        epoch=epoch,
        seed=seed,
        manifest=manifest,
        step=step,
        algorithm=ALGORITHM,
        next_launch_index=next_launch,
        completed_trajectories=completed,
        decisions_used=decisions,
    )


def _fresh_optimizer(model, learning_rate: float):
    return torch.optim.Adam(model.parameters(), lr=learning_rate)


def export_heuristic_demonstrations(root: Path, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "node",
        "scripts/ml-engine.mjs",
        "export",
        "--out",
        str(out_path),
        "--seeds",
        ",".join(HEURISTIC_SEEDS),
        "--vp",
        str(EVAL_RULES["victory_points_to_win"]),
        "--max-turns",
        str(EVAL_RULES["max_turns"]),
        "--max-actions",
        str(EVAL_RULES["max_actions"]),
    ]
    subprocess.run(command, cwd=str(root), check=True)


def prepare_supervised(out_dir: Path, device: torch.device, seed: int, data_path: Path) -> tuple[PolicyValueNet, dict]:
    torch.manual_seed(seed)
    model = PolicyValueNet().to(device)
    optimizer = _fresh_optimizer(model, 1.0e-3)
    _save(out_dir / "untrained.pt", model, optimizer, 0, seed, {"role": "initialized", "external_colonist_games": 0}, 0, 0, 0, 0)
    examples, dropped = load_jsonl(str(data_path), held_out_seeds=set(FINAL_SEEDS) | set(DEV_SEEDS) | set(DIAGNOSTIC_SEEDS))
    stats = train_steps(model, optimizer, examples, device, epochs=SUPERVISED_EPOCHS)
    manifest = {
        "role": "heuristic_behavior_cloning",
        "examples": len(examples),
        "duplicates_dropped": dropped,
        "epochs": SUPERVISED_EPOCHS,
        "loss": stats,
        "heuristic_actions_are_optimal": False,
        "external_colonist_games": 0,
    }
    _save(out_dir / "supervised.pt", model, optimizer, SUPERVISED_EPOCHS, seed, manifest, 0, 0, 0, 0)
    return model, manifest


def run_self_play(out_dir: Path, device: torch.device, config: dict) -> dict:
    from . import protocol

    if config.get("phase2") and not protocol.budget_frozen:
        raise RuntimeError("The phase-2 budget is not frozen. Measure throughput and write the budget before comparing outcomes.")
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = config["prefix"]
    learning_rate = float(config.get("learning_rate", ALGORITHM["learning_rate"]))
    resumed = False
    if config.get("resume_from"):
        model, optimizer, payload = load_checkpoint(config["resume_from"], device, restore_rng=True)
        if payload.get("algorithm", {}).get("name") != ALGORITHM_NAME:
            raise RuntimeError("resume_from is not a terminal-return PPO checkpoint")
        step = int(payload.get("step", 0))
        next_launch = int(payload.get("next_launch_index", 0))
        completed_total = int(payload.get("completed_trajectories", 0))
        decisions_used = int(payload.get("decisions_used", 0))
        resumed = True
    else:
        torch.manual_seed(int(config["seed"]))
        if config.get("init_checkpoint"):
            model, _ignored, _payload = load_checkpoint(config["init_checkpoint"], device, restore_rng=False)
            optimizer = _fresh_optimizer(model, learning_rate)
        else:
            model = PolicyValueNet().to(device)
            optimizer = _fresh_optimizer(model, learning_rate)
        step = 0
        next_launch = 0
        completed_total = 0
        decisions_used = 0
    before = parameter_vector(model).clone()
    bridge = SimulatorBridge(repo_root())
    games = []
    buffer: list[dict] = []
    completed_since_update = 0
    metrics_path = out_dir / "metrics.jsonl"
    illegal = 0
    started = time.perf_counter()
    try:
        while completed_total < int(config["completed_target"]) and next_launch < int(config["max_launches"]):
            mixture = OPPONENT_MIXTURE[next_launch % len(OPPONENT_MIXTURE)]
            seed = f"{prefix}{next_launch}"
            assert_launch_seed(seed, prefix)
            game_started = time.perf_counter()
            game = play_game(
                bridge,
                model,
                device,
                {
                    "seed": seed,
                    "learner": mixture["learner"],
                    "opponent": mixture["opponent"],
                    "victoryPointsToWin": config["victory_points"],
                    "maxTurns": config["max_turns"],
                    "maxActions": config["max_actions"],
                    "checkpoint": config.get("checkpoint_label", "self-play"),
                    "detail": "summary",
                },
                greedy=False,
            )
            next_launch += 1
            games.append(game)
            for decision in game["decisions"]:
                if decision["action_index"] >= decision["legal_count"]:
                    illegal += 1
            trainable = [decision for decision in game["decisions"] if row_is_trainable(decision, allow_bootstrap=False)]
            eligible = gradient_eligible(game["terminal"], game["decisions"])
            if eligible:
                completed_total += 1
                completed_since_update += 1
                buffer.extend(trainable)
            else:
                for decision in game["decisions"]:
                    decision.pop("observation", None)
            print(
                json.dumps(
                    {
                        "event": "game",
                        "seed": seed,
                        "learner": mixture["learner"],
                        "opponent": mixture["opponent"] if mixture["learner"] != "both" else "neural_self_play",
                        "status": game["terminal"]["completion_status"],
                        "cutoff_reason": game["terminal"]["cutoff_reason"],
                        "eligible": eligible,
                        "decisions": len(game["decisions"]),
                        "seconds": round(time.perf_counter() - game_started, 3),
                        "completed_total": completed_total,
                    }
                ),
                file=sys.stderr,
            )
            if buffer and (completed_since_update >= int(config["update_every"]) or completed_total >= int(config["completed_target"])):
                stats = ppo_update(model, optimizer, buffer, device, epochs=int(config.get("ppo_epochs", ALGORITHM["ppo_epochs"])), minibatch_size=int(config.get("minibatch_size", ALGORITHM["minibatch_size"])))
                step += int(stats["steps"])
                decisions_used += int(stats["decisions"])
                completed_since_update = 0
                for row in buffer:
                    row.pop("observation", None)
                buffer.clear()
                _save(
                    out_dir / "checkpoints" / f"step_{step:06d}.pt",
                    model,
                    optimizer,
                    epoch=step,
                    seed=int(config["seed"]),
                    manifest={"role": ALGORITHM_NAME, "external_colonist_games": 0},
                    step=step,
                    next_launch=next_launch,
                    completed=completed_total,
                    decisions=decisions_used,
                )
                _save(
                    out_dir / "latest.pt",
                    model,
                    optimizer,
                    epoch=step,
                    seed=int(config["seed"]),
                    manifest={"role": ALGORITHM_NAME, "external_colonist_games": 0},
                    step=step,
                    next_launch=next_launch,
                    completed=completed_total,
                    decisions=decisions_used,
                )
                record = {"event": "update", "step": step, **stats, "completed_total": completed_total, "decisions_used": decisions_used, "illegal_actions": illegal}
                with metrics_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(record) + "\n")
                print(json.dumps(record), file=sys.stderr)
    finally:
        bridge.close()
    if buffer:
        # The loop flushes when the target is met. A launch cap can leave a partial batch.
        stats = ppo_update(model, optimizer, buffer, device)
        step += int(stats["steps"])
        decisions_used += int(stats["decisions"])
        for row in buffer:
            row.pop("observation", None)
        buffer.clear()
        _save(
            out_dir / "checkpoints" / f"step_{step:06d}.pt",
            model,
            optimizer,
            step,
            int(config["seed"]),
            {"role": ALGORITHM_NAME, "external_colonist_games": 0},
            step,
            next_launch,
            completed_total,
            decisions_used,
        )
        _save(out_dir / "latest.pt", model, optimizer, step, int(config["seed"]), {"role": ALGORITHM_NAME, "external_colonist_games": 0}, step, next_launch, completed_total, decisions_used)
    summary = summarize_games(games, step, decisions_used)
    summary.update(
        {
            "resumed": resumed,
            "next_launch_index": next_launch,
            "illegal_actions": illegal,
            "policy_changed": not bool(torch.equal(before, parameter_vector(model))) if games else False,
            "elapsed_seconds": time.perf_counter() - started,
            "completed_trajectories_total": completed_total,
            "algorithm": ALGORITHM_NAME,
            "bootstrap_cutoffs": False,
            "limits": {
                "victory_points_to_win": config["victory_points"],
                "max_turns": config["max_turns"],
                "max_actions": config["max_actions"],
            },
        }
    )
    write_replay(str(out_dir / "self_play.jsonl"), games)
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def compare_on_seeds(out_dir: Path, device: torch.device, seeds: tuple[str, ...], label: str, decide: bool) -> dict:
    reports = {}
    bridge = SimulatorBridge(repo_root())
    try:
        for name in ("untrained", "supervised", "self_play"):
            path = out_dir / ("latest.pt" if name == "self_play" else f"{name}.pt")
            model, _optimizer, _payload = load_checkpoint(str(path), device, restore_rng=False)
            reports[name] = evaluate_against_baseline(
                bridge,
                model,
                device,
                checkpoint=str(path),
                seeds=seeds,
            )
    finally:
        bridge.close()
    left = reports["self_play"]["rows"]
    right = reports["supervised"]["rows"]
    left_pairs = pair_scores(left)
    right_pairs = pair_scores(right)
    shared = sorted(set(left_pairs) & set(right_pairs))
    diffs = [left_pairs[seed] - right_pairs[seed] for seed in shared if left_pairs[seed] is not None and right_pairs[seed] is not None]
    difference = bootstrap_mean(diffs, seed="ml-rl-phase2-retention-bootstrap-v1")
    self_cutoff = 0.0 if reports["self_play"]["games"] == 0 else reports["self_play"]["incomplete"] / reports["self_play"]["games"]
    sup_cutoff = 0.0 if reports["supervised"]["games"] == 0 else reports["supervised"]["incomplete"] / reports["supervised"]["games"]
    decision = retention_decision(difference, self_cutoff, sup_cutoff) if decide else {
        "retained": None,
        "adopted_self_play": False,
        "reason": "Final seeds are reported and do not choose a checkpoint.",
    }
    payload = {"label": label, "seeds": list(seeds), "difference_self_play_minus_supervised": difference, "retention": decision, "models": {name: _public_report(report) for name, report in reports.items()}}
    (out_dir / f"{label}.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


def _public_report(report: dict) -> dict:
    return {key: value for key, value in report.items() if key != "rows"}


def smoke_config(seed: int = 7) -> dict:
    return {
        "phase2": False,
        "prefix": SMOKE_PREFIX,
        "completed_target": 4,
        "max_launches": 12,
        "update_every": 2,
        "victory_points": 3,
        "max_turns": 20,
        "max_actions": 120,
        "seed": seed,
        "ppo_epochs": 2,
        "minibatch_size": 64,
    }


def phase2_config() -> dict:
    from . import protocol

    return {
        "phase2": True,
        "prefix": TRAIN_PREFIX,
        "completed_target": protocol.COMPLETED_TARGET,
        "max_launches": protocol.MAX_LAUNCHES,
        "update_every": UPDATE_EVERY_COMPLETED,
        "victory_points": EVAL_RULES["victory_points_to_win"],
        "max_turns": EVAL_RULES["max_turns"],
        "max_actions": EVAL_RULES["max_actions"],
        "seed": 7,
        "ppo_epochs": ALGORITHM["ppo_epochs"],
        "minibatch_size": ALGORITHM["minibatch_size"],
        "learning_rate": ALGORITHM["learning_rate"],
    }
