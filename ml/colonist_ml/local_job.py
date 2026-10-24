"""Restartable local training jobs.

A checkpoint is written to a temporary file and then replaced. The previous
file is copied to `<name>.prev` first. A failed write leaves the last completed
checkpoint in place. Resume restores the model, the optimizer, the epoch, and
the saved configuration. It starts again at the next epoch boundary. It does
not restore the PyTorch RNG from the middle of an epoch, so an interrupted
epoch is not bitwise identical to an uninterrupted run.

Cutoffs stay incomplete. They are not stored as losses.
"""

from __future__ import annotations

import hashlib
import json
import signal
from pathlib import Path

import torch

from .checkpoint import load_checkpoint, save_checkpoint
from .model import PolicyValueNet
from .rl import EVAL_SEEDS
from .schema import load_jsonl
from .train import train_steps


class StopRequested(RuntimeError):
    pass


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def append_status(directory: Path, record: dict) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "status.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def _install_stop(flag: dict) -> None:
    def handle(signum, _frame):
        flag["stop"] = True
        flag["signal"] = int(signum)

    signal.signal(signal.SIGINT, handle)


def validate_config(config: dict) -> None:
    kind = config.get("kind")
    if kind not in ("supervised", "supervised-v7"):
        raise ValueError("kind must be supervised or supervised-v7")
    if int(config.get("epochs") or 0) < 1:
        raise ValueError("epochs must be at least 1")
    if int(config.get("batch_size") or 0) < 1:
        raise ValueError("batch_size must be at least 1")
    data = config.get("data")
    if kind == "supervised" and (not data or not Path(data).is_file()):
        raise ValueError(f"training data is missing: {data}")
    eval_spec = config.get("eval")
    if eval_spec is not None:
        if not isinstance(eval_spec, dict):
            raise ValueError("eval must be an object")
        seeds = eval_spec.get("seeds") or []
        if not isinstance(seeds, list) or not seeds:
            raise ValueError("eval.seeds must list the held-out seeds")
        if int(eval_spec.get("every_epochs") or 0) < 1:
            raise ValueError("eval.every_epochs must be at least 1")
        for key in ("vp", "max_turns", "max_actions"):
            if int(eval_spec.get(key) or 0) < 1:
                raise ValueError(f"eval.{key} must be at least 1")
    if kind == "supervised-v7":
        for key in ("source_checkpoint", "original", "aggregated", "out"):
            if not config.get(key):
                raise ValueError(f"{key} is required")
        if not Path(config["source_checkpoint"]).is_file():
            raise ValueError(f"source checkpoint is missing: {config['source_checkpoint']}")
        for key in ("original", "aggregated"):
            if not Path(config[key]).is_file():
                raise ValueError(f"{key} is missing: {config[key]}")
    out = Path(config["out"])
    frozen = {str(Path(config.get("source_checkpoint") or "").resolve())}
    if out.resolve() in {path for path in frozen if path}:
        raise ValueError("refusing to write a run onto the source checkpoint")


def _manifest(examples: list[dict]) -> dict:
    completed = {example["game_id"] for example in examples if example["completion_status"] == "completed"}
    incomplete = {example["game_id"] for example in examples if example["completion_status"] != "completed"}
    return {
        "examples": len(examples),
        "completed_games": len(completed),
        "incomplete_games": len(incomplete),
        "held_out_seeds": list(EVAL_SEEDS),
        "external_colonist_games": 0,
    }


def _optimizer_steps(optimizer: torch.optim.Optimizer) -> int:
    steps = []
    for state in optimizer.state.values():
        step = state.get("step")
        if step is not None:
            steps.append(int(step))
    return max(steps) if steps else 0


def _weight_sha(model: PolicyValueNet) -> str:
    from .match import _weight_hash

    return _weight_hash(model)


def _assert_eval_disjoint(config: dict, examples: list[dict]) -> None:
    spec = config.get("eval") or {}
    eval_seeds = {str(seed) for seed in spec.get("seeds") or []}
    train_seeds = {str(example["seed"]) for example in examples}
    overlap = sorted(eval_seeds & train_seeds)
    if overlap:
        raise ValueError(f"eval seeds overlap training seeds: {overlap}")
    held_out = sorted(train_seeds & set(EVAL_SEEDS))
    if held_out:
        raise ValueError(f"training data contains held-out seeds: {held_out}")


def _evaluate(config: dict, model: PolicyValueNet, checkpoint: Path, device: torch.device, out: Path) -> dict:
    from .evaluate import evaluate_against_baseline
    from .experiment import repo_root
    from .rl import SimulatorBridge

    spec = config["eval"]
    bridge = SimulatorBridge(repo_root())
    try:
        result = evaluate_against_baseline(
            bridge,
            model,
            device,
            str(checkpoint),
            int(spec["vp"]),
            int(spec["max_turns"]),
            int(spec["max_actions"]),
            tuple(str(seed) for seed in spec["seeds"]),
        )
    finally:
        bridge.close()
    kept = {key: value for key, value in result.items() if key != "rows"}
    kept["rows"] = result["rows"]
    (out / "eval.json").write_text(json.dumps(kept, indent=2) + "\n", encoding="utf-8")
    return {key: value for key, value in kept.items() if key != "rows"}


def run_supervised(config: dict, resume: bool = False, stop_after_epoch: int | None = None) -> dict:
    """Train through config epochs.

    stop_after_epoch saves the checkpoint at that epoch and returns before the
    configured epoch count. Resume with the same config continues from latest.pt.
    A file named STOP in the run directory does the same after the current epoch.
    Torch's RNG state is restored. Example order restarts at the next epoch;
    a half-finished epoch is not resumed mid-batch.
    """
    validate_config(config)
    out = Path(config["out"])
    out.mkdir(parents=True, exist_ok=True)
    (out / "config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    examples, dropped = load_jsonl(config["data"], held_out_seeds=set(EVAL_SEEDS))
    _assert_eval_disjoint(config, examples)
    for example in examples:
        if example["completion_status"] != "completed" and example["actor_win"] is not None:
            raise ValueError(f"cutoff {example['game_id']} has a terminal outcome")
    device = torch.device("cuda" if config.get("device") == "cuda" and torch.cuda.is_available() else "cpu")
    latest = out / "latest.pt"
    best = out / "best.pt"
    start = 0
    best_loss = None
    if resume:
        if not latest.is_file():
            raise ValueError(f"no checkpoint to resume: {latest}")
        model, optimizer, payload = load_checkpoint(str(latest), device, restore_rng=True)
        start = int(payload["epoch"])
        best_loss = (payload.get("dataset_manifest") or {}).get("best_loss")
        if payload.get("feature_version") != getattr(model, "feature_version", None):
            raise ValueError("resumed checkpoint feature schema does not match the model")
    else:
        torch.manual_seed(int(config.get("seed") or 7))
        model = PolicyValueNet().to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=float(config.get("learning_rate") or 1e-3))
    flag = {"stop": False}
    _install_stop(flag)
    manifest = _manifest(examples)
    last = {"loss": None}
    completed_epoch = start
    stopped = False
    for epoch in range(start, int(config["epochs"])):
        if flag["stop"] or (out / "STOP").exists():
            stopped = True
            append_status(out, {
                "event": "stopped",
                "epoch": completed_epoch,
                "completed_games": manifest["completed_games"],
                "incomplete_games": manifest["incomplete_games"],
                "reason": "stop_requested",
            })
            break
        last = train_steps(model, optimizer, examples, device, epochs=1, batch_size=int(config["batch_size"]))
        improved = best_loss is None or last["loss"] < best_loss
        if improved:
            best_loss = last["loss"]
        manifest = {**manifest, "best_loss": best_loss, "weight_sha256": _weight_sha(model), "optimizer_steps": _optimizer_steps(optimizer)}
        save_checkpoint(str(latest), model, optimizer, epoch + 1, int(config.get("seed") or 7), manifest, step=epoch + 1, algorithm={"name": "supervised", "kind": "supervised"})
        if improved or not best.is_file():
            save_checkpoint(str(best), model, optimizer, epoch + 1, int(config.get("seed") or 7), manifest, step=epoch + 1, algorithm={"name": "supervised", "kind": "supervised"})
        completed_epoch = epoch + 1
        previous = latest.with_name(latest.name + ".prev")
        record = {
            "event": "epoch",
            "epoch": completed_epoch,
            "step": completed_epoch,
            "loss": last["loss"],
            "policy": last["policy"],
            "value": last["value"],
            "completed_games": manifest["completed_games"],
            "incomplete_games": manifest["incomplete_games"],
            "examples": manifest["examples"],
            "duplicates_dropped": dropped,
            "improved": improved,
            "checkpoint": str(latest),
            "checkpoint_sha256": file_sha256(latest),
            "previous_sha256": file_sha256(previous) if previous.is_file() else None,
            "weight_sha256": manifest["weight_sha256"],
            "optimizer_steps": manifest["optimizer_steps"],
            "device": str(device),
            "rng_restored_on_resume": bool(resume),
        }
        append_status(out, record)
        if config.get("eval") and completed_epoch % int(config["eval"]["every_epochs"]) == 0:
            summary = _evaluate(config, model, latest, device, out)
            append_status(out, {"event": "eval", "epoch": completed_epoch, "opponent": "baseline_heuristic_v1", **{key: summary[key] for key in ("games", "completed", "incomplete", "cutoffs_by_reason", "learner_wins", "learner_losses", "draws", "pairs_completed") if key in summary}})
        if stop_after_epoch is not None and completed_epoch >= stop_after_epoch:
            stopped = True
            append_status(out, {
                "event": "stopped",
                "epoch": completed_epoch,
                "completed_games": manifest["completed_games"],
                "incomplete_games": manifest["incomplete_games"],
                "reason": "stop_after_epoch",
                "checkpoint_sha256": file_sha256(latest),
            })
            break
    return {
        "out": str(out),
        "epoch": completed_epoch,
        "stopped": stopped,
        "loss": last["loss"],
        "weight_sha256": None if last["loss"] is None else _weight_sha(model),
        "optimizer_steps": None if last["loss"] is None else _optimizer_steps(optimizer),
    }


def report(directory: str) -> dict:
    out = Path(directory)
    lines = []
    status = out / "status.jsonl"
    if status.is_file():
        lines = [json.loads(line) for line in status.read_text(encoding="utf-8").splitlines() if line.strip()]
    latest = out / "latest.pt"
    payload = None
    if latest.is_file():
        payload = torch.load(latest, map_location="cpu")
    return {
        "events": len(lines),
        "last": lines[-1] if lines else None,
        "latest_epoch": None if payload is None else payload.get("epoch"),
        "feature_version": None if payload is None else payload.get("feature_version"),
        "best_exists": (out / "best.pt").is_file(),
        "previous_exists": (out / "latest.pt.prev").is_file(),
        "completed_games": None if payload is None else (payload.get("dataset_manifest") or {}).get("completed_games"),
        "incomplete_games": None if payload is None else (payload.get("dataset_manifest") or {}).get("incomplete_games"),
        "weight_sha256": None if payload is None else (payload.get("dataset_manifest") or {}).get("weight_sha256"),
        "optimizer_steps": None if payload is None else (payload.get("dataset_manifest") or {}).get("optimizer_steps"),
        "checkpoint_sha256": None if not lines else next((row.get("checkpoint_sha256") for row in reversed(lines) if row.get("checkpoint_sha256")), None),
        "eval_report": str(out / "eval.json") if (out / "eval.json").is_file() else None,
    }
