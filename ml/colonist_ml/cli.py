"""Offline training commands. Run from the repository root with PYTHONPATH=ml."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from .checkpoint import load_checkpoint, save_checkpoint
from .evaluate import evaluate_against_baseline
from .model import PolicyValueNet
from .rl import EVAL_SEEDS
from .schema import load_jsonl
from .train import predict_action, train_steps


def device_of(name: str) -> torch.device:
    if name == "cuda" and torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def manifest_for(examples: list[dict]) -> dict:
    policies = sorted({example["generating_policy"] for example in examples})
    provenances = sorted({example["target_provenance"] for example in examples})
    completed_games = {example["game_id"] for example in examples if example["completion_status"] == "completed"}
    incomplete_games = {example["game_id"] for example in examples if example["completion_status"] != "completed"}
    return {
        "examples": len(examples),
        "games": len({example["game_id"] for example in examples}),
        "completed_games": len(completed_games),
        "incomplete_games": len(incomplete_games),
        "policies": policies,
        "provenances": provenances,
        "external_colonist_games": 0,
    }


def cmd_train(args: argparse.Namespace) -> None:
    device = device_of(args.device)
    examples, dropped = load_jsonl(args.data, held_out_seeds=set(EVAL_SEEDS))
    torch.manual_seed(args.seed)
    model = PolicyValueNet().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    stats = train_steps(model, optimizer, examples, device, epochs=args.epochs)
    path = str(Path(args.out) / "supervised.pt")
    save_checkpoint(path, model, optimizer, epoch=args.epochs, seed=args.seed, manifest=manifest_for(examples))
    sample = predict_action(model, examples[0]["observation"], device)
    print(json.dumps({
        "checkpoint": path,
        "device": str(device),
        "examples": len(examples),
        "duplicates_dropped": dropped,
        "epochs": args.epochs,
        "loss": stats,
        "sample_legal_action": sample,
        "manifest": manifest_for(examples),
        "note": "Heuristic targets are behavior labels, not optimal moves.",
    }, indent=2))


def cmd_resume(args: argparse.Namespace) -> None:
    device = device_of(args.device)
    examples, _dropped = load_jsonl(args.data, held_out_seeds=set(EVAL_SEEDS))
    model, optimizer, payload = load_checkpoint(args.checkpoint, device)
    before = int(payload["epoch"])
    train_steps(model, optimizer, examples, device, epochs=1)
    path = str(Path(args.out) / "resumed.pt")
    save_checkpoint(path, model, optimizer, epoch=before + 1, seed=int(payload["seed"]), manifest=payload["dataset_manifest"])
    print(json.dumps({"resumed_from_epoch": before, "saved_epoch": before + 1, "checkpoint": path, "device": str(device)}, indent=2))


def cmd_self_play(args: argparse.Namespace) -> None:
    from .experiment import run_self_play, smoke_config

    config = smoke_config(args.seed)
    config["victory_points"] = args.vp
    config["max_turns"] = args.max_turns
    config["max_actions"] = args.max_actions
    if args.checkpoint:
        config["init_checkpoint"] = args.checkpoint
        config["checkpoint_label"] = args.checkpoint
    summary = run_self_play(Path(args.out), device_of(args.device), config)
    print(json.dumps(summary, indent=2))


def cmd_experiment(args: argparse.Namespace) -> None:
    from . import protocol
    from .experiment import compare_on_seeds, export_heuristic_demonstrations, phase2_config, prepare_supervised, repo_root, run_self_play

    if not protocol.budget_frozen:
        raise SystemExit("Phase-2 budget is not frozen. Throughput has to be measured and the budget written down before this run.")
    device = device_of(args.device)
    out_dir = Path(args.out)
    data_path = out_dir / "heuristic_demonstrations.jsonl"
    export_heuristic_demonstrations(repo_root(), data_path)
    _model, manifest = prepare_supervised(out_dir, device, args.seed, data_path)
    config = phase2_config()
    config["seed"] = args.seed
    config["init_checkpoint"] = str(out_dir / "supervised.pt")
    config["checkpoint_label"] = str(out_dir / "supervised.pt")
    summary = run_self_play(out_dir, device, config)
    development = compare_on_seeds(out_dir, device, protocol.DEV_SEEDS, "development", decide=True)
    (out_dir / "retained.json").write_text(
        json.dumps({"source": "development", "final_seeds_used": False, **development["retention"]}, indent=2) + "\n",
        encoding="utf-8",
    )
    final = compare_on_seeds(out_dir, device, protocol.FINAL_SEEDS, "final", decide=False)
    print(json.dumps({"supervised": manifest, "self_play": summary, "retained": development["retention"], "final_pairs": {name: report["pairs_completed"] for name, report in final["models"].items()}}, indent=2))


def cmd_fidelity(args: argparse.Namespace) -> None:
    from .fidelity import (
        FIT_EPOCHS,
        HOLDOUT_SEEDS,
        OVERFIT_EPOCHS,
        acceptance,
        assert_disjoint,
        evaluate_imitation,
        overfit_subset,
        trace_matched_games,
        train_imitation,
        write_report,
    )
    from .experiment import repo_root

    device = device_of(args.device)
    fit, _fit_dropped = load_jsonl(args.fit, held_out_seeds=set(HOLDOUT_SEEDS))
    holdout, _holdout_dropped = load_jsonl(args.holdout, held_out_seeds=set())
    assert_disjoint(fit, holdout)
    fit_completed = [example for example in fit if example["completion_status"] == "completed"]
    holdout_completed = [example for example in holdout if example["completion_status"] == "completed"]
    subset = overfit_subset(fit_completed)
    overfit_model = train_imitation(subset, device, epochs=OVERFIT_EPOCHS, seed=args.seed, batch_size=16, balance=args.balance)
    overfit_metrics = evaluate_imitation(overfit_model, subset, device)
    model = train_imitation(fit_completed, device, epochs=FIT_EPOCHS, seed=args.seed, batch_size=32, balance=args.balance)
    train_metrics = evaluate_imitation(model, fit_completed, device)
    holdout_metrics = evaluate_imitation(model, holdout_completed, device)
    gate = acceptance(float(overfit_metrics["top1"]), float(holdout_metrics["top1"]), float(holdout_metrics["chance"]))
    report = {
        "note": "Teacher agreement is imitation fidelity. It is not a claim that the teacher action is optimal. The gate uses decisions from completed games only.",
        "fit_examples": len(fit_completed),
        "fit_games": len({example["game_id"] for example in fit_completed}),
        "holdout_examples": len(holdout_completed),
        "holdout_games": len({example["game_id"] for example in holdout_completed}),
        "overfit_subset": len(subset),
        "overfit": overfit_metrics,
        "train": train_metrics,
        "holdout": holdout_metrics,
        "acceptance": gate,
        "balanced_loss": bool(args.balance),
    }
    if args.play:
        report["traces"] = trace_matched_games(model, device, repo_root())
        report["trace_note"] = "Traces use 10 VP, 70 turns, and 450 actions on one seed from both seats. They are not the held-out strength comparison."
    out = Path(args.out)
    write_report(out, report)
    printable = {
        "overfit_top1": overfit_metrics["top1"],
        "train_top1": train_metrics["top1"],
        "holdout_top1": holdout_metrics["top1"],
        "holdout_chance": holdout_metrics["chance"],
        "acceptance": gate,
        "invalid": holdout_metrics["invalid_predictions"],
        "unmapped": holdout_metrics["unmapped_teacher_actions"],
    }
    print(json.dumps(printable, indent=2))


def cmd_compare(args: argparse.Namespace) -> None:
    from .compare import compare_models
    from .fidelity import write_report
    from .rules import GRAPH_FINAL_SEEDS, INSPECTED_FIDELITY_SEEDS

    device = device_of(args.device)
    train, _dropped = load_jsonl(args.train, held_out_seeds=set(GRAPH_FINAL_SEEDS) | set(INSPECTED_FIDELITY_SEEDS))
    validation, _dropped_val = load_jsonl(args.val, held_out_seeds=set(GRAPH_FINAL_SEEDS) | set(INSPECTED_FIDELITY_SEEDS))
    report = compare_models(train, validation, device)
    write_report(args.out, report)
    print(json.dumps({
        "train_examples": report["train_examples"],
        "validation_examples": report["validation_examples"],
        "summary_v2": {key: report["summary_v2"][key] for key in ("parameters", "train_seconds", "inference_ms_per_decision")},
        "summary_validation_top1": report["summary_v2"]["validation"]["top1"],
        "summary_multi": report["summary_v2"]["validation"]["multi_legal_top1"],
        "graph_validation_top1": report["graph_v3"]["validation"]["top1"],
        "graph_multi": report["graph_v3"]["validation"]["multi_legal_top1"],
        "graph_within_type": report["graph_v3"]["validation"]["within_type_agreement"],
        "graph_hard": report["graph_v3"]["validation"]["hard_types"],
        "summary_hard": report["summary_v2"]["validation"]["hard_types"],
        "stratified_validation_top1": report["graph_v3_stratified_batches"]["validation"]["top1"],
        "final_seeds_used": report["final_seeds_used"],
    }, indent=2))


def cmd_eval(args: argparse.Namespace) -> None:
    from .experiment import repo_root
    from .rl import SimulatorBridge

    device = device_of(args.device)
    model, _optimizer, _payload = load_checkpoint(args.checkpoint, device)
    bridge = SimulatorBridge(repo_root())
    try:
        report = evaluate_against_baseline(bridge, model, device, args.checkpoint, args.vp, args.max_turns, args.max_actions)
    finally:
        bridge.close()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in report if key != "rows"}, indent=2))


def cmd_freeze_v4(args: argparse.Namespace) -> None:
    from .match import freeze_v4_checkpoint

    manifest = freeze_v4_checkpoint(args.data, args.out, device_of(args.device))
    print(json.dumps(manifest, indent=2))


def cmd_match_v4(args: argparse.Namespace) -> None:
    from .checkpoint import load_checkpoint
    from .experiment import repo_root
    from .match import MATCH_SEEDS, run_match
    from .rl import SimulatorBridge
    from .tracked import FEATURE_VERSION_V4

    device = device_of(args.device)
    model, _optimizer, payload = load_checkpoint(args.checkpoint, device)
    if payload.get("feature_version") != FEATURE_VERSION_V4:
        raise SystemExit("checkpoint is not colonist_features_v4")
    count = MATCH_SEEDS.__len__() if args.games is None else args.games
    if count < 1 or count > len(MATCH_SEEDS):
        raise SystemExit(f"games must be from 1 to {len(MATCH_SEEDS)}")
    bridge = SimulatorBridge(repo_root())
    try:
        report = run_match(bridge, model, device, args.checkpoint, MATCH_SEEDS[:count])
    finally:
        bridge.close()
    report["manifest"] = payload.get("dataset_manifest")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in (
        "feature_version", "games_launched", "completed_games", "pairs_completed", "pair_score",
        "pair_score_minus_even", "signal", "illegal_actions", "simulator_failures", "cutoffs_by_reason", "elapsed_seconds",
    )}, indent=2))


def cmd_audit_v4(args: argparse.Namespace) -> None:
    from .aggregate import audit_match_seeds, diagnosis_seeds, in_distribution_audit, label_counts
    from .checkpoint import load_checkpoint
    from .experiment import repo_root
    from .rl import SimulatorBridge
    from .schema import load_jsonl
    from .tracked import FEATURE_VERSION_V4

    device = device_of(args.device)
    model, _optimizer, payload = load_checkpoint(args.checkpoint, device)
    if payload.get("feature_version") != FEATURE_VERSION_V4:
        raise SystemExit("checkpoint is not colonist_features_v4")
    expected = (payload.get("dataset_manifest") or {}).get("weight_sha256")
    from .match import _weight_hash

    if expected and _weight_hash(model) != expected:
        raise SystemExit("checkpoint hash does not match its manifest")
    validation, _dropped = load_jsonl(args.val, held_out_seeds=set())
    distribution = in_distribution_audit(model, validation, device)
    bridge = SimulatorBridge(repo_root())
    try:
        learner = audit_match_seeds(bridge, model, device, diagnosis_seeds(args.games))
    finally:
        bridge.close()
    report = {
        "checkpoint": args.checkpoint,
        "feature_version": FEATURE_VERSION_V4,
        "weight_sha256": expected,
        "loss_used_to_train_v4": "unweighted cross-entropy on the teacher action, plus value loss only on completed games",
        "inference": "greedy argmax over encode_observation_v4 legal logits",
        "label_imbalance_phase6_train": label_counts(args.train_labels) if args.train_labels else None,
        "in_distribution": distribution,
        "learner_states": learner,
        "ppo_authorized": False,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "pairwise_variant_authorized": distribution["pairwise_variant_authorized"],
        "in_distribution_road_endturn_rate": distribution["teacher_road_with_endturn_legal"]["rate"],
        "in_distribution_trade_endturn_rate": distribution["teacher_trade_with_endturn_legal"]["rate"],
        "learner_endturn_vs_road": learner["endturn_vs_road"]["n"],
        "learner_endturn_vs_trade": learner["endturn_vs_trade"]["n"],
        "road_margin_median": learner["endturn_vs_road"]["margin_teacher_minus_endturn"]["median"],
        "trade_margin_median": learner["endturn_vs_trade"]["margin_teacher_minus_endturn"]["median"],
        "games": learner["games"],
    }, indent=2))


def cmd_aggregate_v4(args: argparse.Namespace) -> None:
    from .aggregate import collect_split
    from .checkpoint import load_checkpoint
    from .experiment import repo_root
    from .rl import SimulatorBridge
    from .tracked import FEATURE_VERSION_V4

    device = device_of(args.device)
    model, _optimizer, payload = load_checkpoint(args.checkpoint, device)
    if payload.get("feature_version") != FEATURE_VERSION_V4:
        raise SystemExit("checkpoint is not colonist_features_v4")
    model.eval()
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    bridge = SimulatorBridge(repo_root())
    try:
        summary = collect_split(bridge, model, device, args.checkpoint, args.split, args.out)
    finally:
        bridge.close()
    print(json.dumps(summary, indent=2))


def cmd_train_agg(args: argparse.Namespace) -> None:
    from .aggregate import assert_checkpoint_unchanged, corpus_summary, mix_corpora, train_ordinary, train_pairwise
    from .checkpoint import load_checkpoint, save_checkpoint
    from .schema import load_jsonl
    from .tracked import FEATURE_VERSION_V4

    if Path(args.out).resolve() == Path(args.v4_checkpoint).resolve():
        raise SystemExit("refusing to overwrite the frozen summary v4 checkpoint")
    device = device_of(args.device)
    _model, _optimizer, payload = load_checkpoint(args.v4_checkpoint, device)
    expected = (payload.get("dataset_manifest") or {}).get("weight_sha256")
    if payload.get("feature_version") != FEATURE_VERSION_V4 or not expected:
        raise SystemExit("frozen checkpoint is not summary v4")
    original, _dropped = load_jsonl(args.original, held_out_seeds=set())
    aggregated, _dropped_agg = load_jsonl(args.aggregated, held_out_seeds=set())
    mixed = mix_corpora(original, aggregated)
    if args.variant == "ordinary":
        candidate = train_ordinary(mixed, device)
        extra = {"loss": "unweighted_cross_entropy"}
    elif args.variant == "pairwise":
        candidate, extra = train_pairwise(mixed, device)
    else:
        raise SystemExit("variant must be ordinary or pairwise")
    manifest = {
        "feature_version": FEATURE_VERSION_V4,
        "candidate_id": f"colonist_features_v4_agg_{args.variant}",
        "parent_checkpoint": args.v4_checkpoint,
        "parent_sha256": expected,
        "initialized_from_parent_weights": False,
        "epochs": 12,
        "torch_seed": 7,
        "mixture": "all phase-6 training rows once, then all aggregated rows once, weight 1",
        "original_rows": len(original),
        "aggregated_rows": len(aggregated),
        "aggregated_summary": corpus_summary(aggregated),
        "label_policy": "baseline_heuristic_v1",
        "generating_policy": "colonist_features_v4",
        "loss": extra,
        "sample_weight": 1,
        "diagnostic_slices_are_training_weights": False,
        "ppo_authorized": False,
        "frozen_v4": True,
    }
    optimizer = torch.optim.Adam(candidate.parameters(), lr=1e-3)
    save_checkpoint(args.out, candidate, optimizer, 12, 7, manifest)
    assert_checkpoint_unchanged(args.v4_checkpoint, expected)
    print(json.dumps({"checkpoint": args.out, "variant": args.variant, "rows": len(mixed), "parent_unchanged": True, **extra}, indent=2))


def cmd_eval_agg(args: argparse.Namespace) -> None:
    from .aggregate import meets_action_criteria, selection_view
    from .checkpoint import load_checkpoint
    from .schema import load_jsonl

    device = device_of(args.device)
    heldout, _dropped = load_jsonl(args.data, held_out_seeds=set())
    control, _dropped_control = load_jsonl(args.control, held_out_seeds=set())
    reports = {}
    for name, path in (("v4", args.v4), ("candidate", args.candidate)):
        model, _optimizer, payload = load_checkpoint(path, device)
        view = selection_view(model, heldout, device)
        view["control"] = selection_view(model, control, device)
        view["checkpoint"] = path
        view["manifest"] = payload.get("dataset_manifest")
        reports[name] = view
    gate = meets_action_criteria(reports["v4"], reports["candidate"])
    out = {
        "heldout": args.data,
        "control": args.control,
        "gate": gate,
        "v4": reports["v4"],
        "candidate": reports["candidate"],
        "playing_strength_claim": False,
        "ppo_authorized": False,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "met": gate["met"],
        "reasons": gate["reasons"],
        "v4_natural_top1": reports["v4"]["natural"]["top1"],
        "candidate_natural_top1": reports["candidate"]["natural"]["top1"],
        "v4_road": reports["v4"]["targeted"]["endturn_vs_road"],
        "candidate_road": reports["candidate"]["targeted"]["endturn_vs_road"],
        "v4_trade": reports["v4"]["targeted"]["endturn_vs_trade"],
        "candidate_trade": reports["candidate"]["targeted"]["endturn_vs_trade"],
    }, indent=2))


def cmd_train_v6(args: argparse.Namespace) -> None:
    from .aggregate import assert_checkpoint_unchanged, mix_corpora
    from .checkpoint import load_checkpoint, save_checkpoint
    from .phase9 import EPOCHS, TORCH_SEED, train_v6
    from .schema import load_jsonl
    from .tracked import FEATURE_VERSION_V4, FEATURE_VERSION_V6

    if Path(args.out).resolve() == Path(args.v4).resolve():
        raise SystemExit("refusing to overwrite summary v4")
    device = device_of(args.device)
    source, _optimizer, payload = load_checkpoint(args.v4, device)
    expected = (payload.get("dataset_manifest") or {}).get("weight_sha256")
    if payload.get("feature_version") != FEATURE_VERSION_V4 or not expected:
        raise SystemExit("source is not the frozen summary v4 checkpoint")
    original, _dropped = load_jsonl(args.original, held_out_seeds=set())
    aggregated, _dropped_agg = load_jsonl(args.aggregated, held_out_seeds=set())
    mixed = mix_corpora(original, aggregated)
    model, seconds = train_v6(mixed, source, device)
    manifest = {
        "feature_version": FEATURE_VERSION_V6,
        "candidate_id": "colonist_features_v6_road_reach",
        "parent_checkpoint": args.v4,
        "parent_sha256": expected,
        "initialization": "v4 weights with zero-filled road-expansion columns",
        "initialized_from_phase8": False,
        "epochs": EPOCHS,
        "torch_seed": TORCH_SEED,
        "learning_rate": 1e-3,
        "loss": "unweighted_cross_entropy",
        "original_rows": len(original),
        "aggregated_rows": len(aggregated),
        "train_seconds": seconds,
        "ppo_authorized": False,
    }
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    save_checkpoint(args.out, model, optimizer, EPOCHS, TORCH_SEED, manifest)
    assert_checkpoint_unchanged(args.v4, expected)
    print(json.dumps({"checkpoint": args.out, "seconds": seconds, "rows": len(mixed), "parent_unchanged": True}, indent=2))


def cmd_collect_v6(args: argparse.Namespace) -> None:
    from .aggregate import collect_game, write_jsonl
    from .checkpoint import load_checkpoint
    from .experiment import repo_root
    from .match import _weight_hash
    from .phase9 import FINAL_SEEDS, assert_final_seeds
    from .rl import SimulatorBridge
    from .tracked import FEATURE_VERSION_V4

    device = device_of(args.device)
    model, _optimizer, payload = load_checkpoint(args.checkpoint, device)
    if payload.get("feature_version") != FEATURE_VERSION_V4:
        raise SystemExit("final trajectories are generated by frozen summary v4")
    seeds = FINAL_SEEDS
    assert_final_seeds(seeds)
    model.eval()
    bridge = SimulatorBridge(repo_root())
    examples = []
    games = []
    try:
        for seed in seeds:
            for learner in ("c1", "c2"):
                played = collect_game(bridge, model, device, seed, learner, args.checkpoint, _weight_hash(model))
                examples.extend(played["examples"])
                games.append(played["terminal"]["completion_status"])
    finally:
        bridge.close()
    write_jsonl(args.out, examples)
    print(json.dumps({
        "games": len(games),
        "completed_games": sum(1 for status in games if status == "completed"),
        "decisions": len(examples),
        "out": args.out,
    }, indent=2))


def cmd_eval_v6(args: argparse.Namespace) -> None:
    from .aggregate import _score, selection_view
    from .checkpoint import load_checkpoint
    from .phase9 import meets_v6_gate, prepare_examples, score_v6
    from .schema import load_jsonl

    device = device_of(args.device)
    final, _dropped = load_jsonl(args.final, held_out_seeds=set())
    control, _dropped_control = load_jsonl(args.control, held_out_seeds=set())
    control = prepare_examples(control)
    reports = {}
    for name, path, scorer in (
        ("v4", args.v4, _score),
        ("phase8", args.phase8, _score),
        ("v6", args.candidate, score_v6),
    ):
        model, _optimizer, payload = load_checkpoint(path, device)
        view = selection_view(model, final, device, scorer=scorer)
        view["control"] = selection_view(model, control, device, scorer=scorer)
        view["checkpoint"] = path
        view["feature_version"] = payload.get("feature_version")
        reports[name] = view
    gate = meets_v6_gate(reports["v6"], reports["v6"]["control"])
    out = {"gate": gate, "v4": reports["v4"], "phase8": reports["phase8"], "v6": reports["v6"], "playing_strength_claim": False, "ppo_authorized": False}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"met": gate["met"], "reasons": gate["reasons"]}, indent=2))


def cmd_match_strength(args: argparse.Namespace) -> None:
    from .checkpoint import load_checkpoint
    from .experiment import repo_root
    from .phase10 import (
        STRENGTH_SEEDS,
        V4_WEIGHT_SHA256,
        V6_WEIGHT_SHA256,
        run_smoke,
        run_strength,
        verify_checkpoint,
    )
    from .rl import SimulatorBridge
    from .tracked import FEATURE_VERSION_V4, FEATURE_VERSION_V6

    device = device_of(args.device)
    v4_model, _optimizer, v4_payload = load_checkpoint(args.v4, device)
    v6_model, _optimizer_v6, v6_payload = load_checkpoint(args.v6, device)
    models = {
        "v6": {
            "model": v6_model,
            "checkpoint": args.v6,
            "version": FEATURE_VERSION_V6,
            "hash": verify_checkpoint(v6_model, v6_payload, FEATURE_VERSION_V6, V6_WEIGHT_SHA256),
        },
        "v4": {
            "model": v4_model,
            "checkpoint": args.v4,
            "version": FEATURE_VERSION_V4,
            "hash": verify_checkpoint(v4_model, v4_payload, FEATURE_VERSION_V4, V4_WEIGHT_SHA256),
        },
    }
    bridge = SimulatorBridge(repo_root())
    try:
        report = run_smoke(bridge, models, device) if args.smoke else run_strength(bridge, models, device, STRENGTH_SEEDS)
    finally:
        bridge.close()
    report["weights_after"] = {
        "v6": verify_checkpoint(v6_model, v6_payload, FEATURE_VERSION_V6, V6_WEIGHT_SHA256),
        "v4": verify_checkpoint(v4_model, v4_payload, FEATURE_VERSION_V4, V4_WEIGHT_SHA256),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if args.smoke:
        print(json.dumps({"repeated": report["repeated"], "seeds": report["seeds"], "weights_unchanged": True}, indent=2))
        return
    print(json.dumps({
        "interpretation": report["interpretation"],
        "v6_pairs": report["v6"]["pairs_completed"],
        "v6_pair_score": report["v6"]["pair_score"],
        "v6_interval": report["v6"]["pair_score_minus_even"],
        "v4_pairs": report["v4"]["pairs_completed"],
        "v4_pair_score": report["v4"]["pair_score"],
        "v4_interval": report["v4"]["pair_score_minus_even"],
        "matched": report["matched_v6_minus_v4"],
        "illegal": {"v6": report["v6"]["illegal_actions"], "v4": report["v4"]["illegal_actions"]},
        "failures": {"v6": report["v6"]["simulator_failures"], "v4": report["v4"]["simulator_failures"]},
    }, indent=2))


def cmd_phase6(args: argparse.Namespace) -> None:
    from .coverage import run_phase6

    device = torch.device(args.device)
    report = run_phase6(args.train, args.val, args.final, args.out, device)
    print(json.dumps({
        "chosen": report["validation"]["chosen"],
        "adopt_graph": report["validation"]["adopt_graph"],
        "ready_for_strength": report["final_test"]["ready_for_strength"],
        "ppo_authorized": False,
    }, indent=2))


def main() -> None:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--device", default="cpu")
    common.add_argument("--seed", type=int, default=7)
    common.add_argument("--lr", type=float, default=1e-3)
    common.add_argument("--vp", type=int, default=3)
    common.add_argument("--max-turns", type=int, default=20)
    common.add_argument("--max-actions", type=int, default=120)

    parser = argparse.ArgumentParser(description="Offline synthetic learner")
    sub = parser.add_subparsers(dest="command", required=True)

    train = sub.add_parser("train", parents=[common])
    train.add_argument("--data", required=True)
    train.add_argument("--out", required=True)
    train.add_argument("--epochs", type=int, default=1)
    train.set_defaults(func=cmd_train)

    resume = sub.add_parser("resume", parents=[common])
    resume.add_argument("--checkpoint", required=True)
    resume.add_argument("--data", required=True)
    resume.add_argument("--out", required=True)
    resume.set_defaults(func=cmd_resume)

    play = sub.add_parser("self-play", parents=[common])
    play.add_argument("--checkpoint", default="")
    play.add_argument("--out", required=True)
    play.set_defaults(func=cmd_self_play)

    evaluate = sub.add_parser("eval", parents=[common])
    evaluate.add_argument("--checkpoint", required=True)
    evaluate.add_argument("--out", required=True)
    evaluate.set_defaults(func=cmd_eval)

    experiment = sub.add_parser("experiment", parents=[common])
    experiment.add_argument("--out", required=True)
    experiment.set_defaults(func=cmd_experiment)

    fidelity = sub.add_parser("fidelity", parents=[common])
    fidelity.add_argument("--fit", required=True)
    fidelity.add_argument("--holdout", required=True)
    fidelity.add_argument("--out", required=True)
    fidelity.add_argument("--play", action="store_true")
    fidelity.add_argument("--balance", action="store_true")
    fidelity.set_defaults(func=cmd_fidelity)

    compare = sub.add_parser("compare-models", parents=[common])
    compare.add_argument("--train", required=True)
    compare.add_argument("--val", required=True)
    compare.add_argument("--out", required=True)
    compare.set_defaults(func=cmd_compare)

    phase6 = sub.add_parser("phase6", parents=[common])
    phase6.add_argument("--train", required=True)
    phase6.add_argument("--val", required=True)
    phase6.add_argument("--final", required=True)
    phase6.add_argument("--out", required=True)
    phase6.set_defaults(func=cmd_phase6)

    freeze = sub.add_parser("freeze-v4", parents=[common])
    freeze.add_argument("--data", required=True)
    freeze.add_argument("--out", required=True)
    freeze.set_defaults(func=cmd_freeze_v4)

    match = sub.add_parser("match-v4", parents=[common])
    match.add_argument("--checkpoint", required=True)
    match.add_argument("--out", required=True)
    match.add_argument("--games", type=int)
    match.set_defaults(func=cmd_match_v4)

    audit = sub.add_parser("audit-v4", parents=[common])
    audit.add_argument("--checkpoint", required=True)
    audit.add_argument("--val", required=True)
    audit.add_argument("--train-labels", default="")
    audit.add_argument("--out", required=True)
    audit.add_argument("--games", type=int)
    audit.set_defaults(func=cmd_audit_v4)

    aggregate = sub.add_parser("aggregate-v4", parents=[common])
    aggregate.add_argument("--checkpoint", required=True)
    aggregate.add_argument("--split", required=True, choices=("timing", "train", "val", "final"))
    aggregate.add_argument("--out", required=True)
    aggregate.set_defaults(func=cmd_aggregate_v4)

    train_agg = sub.add_parser("train-agg", parents=[common])
    train_agg.add_argument("--v4-checkpoint", required=True)
    train_agg.add_argument("--original", required=True)
    train_agg.add_argument("--aggregated", required=True)
    train_agg.add_argument("--variant", required=True, choices=("ordinary", "pairwise"))
    train_agg.add_argument("--out", required=True)
    train_agg.set_defaults(func=cmd_train_agg)

    train_v6 = sub.add_parser("train-v6", parents=[common])
    train_v6.add_argument("--v4", required=True)
    train_v6.add_argument("--original", required=True)
    train_v6.add_argument("--aggregated", required=True)
    train_v6.add_argument("--out", required=True)
    train_v6.set_defaults(func=cmd_train_v6)

    collect_v6 = sub.add_parser("collect-v6", parents=[common])
    collect_v6.add_argument("--checkpoint", required=True)
    collect_v6.add_argument("--out", required=True)
    collect_v6.set_defaults(func=cmd_collect_v6)

    eval_v6 = sub.add_parser("eval-v6", parents=[common])
    eval_v6.add_argument("--v4", required=True)
    eval_v6.add_argument("--phase8", required=True)
    eval_v6.add_argument("--candidate", required=True)
    eval_v6.add_argument("--final", required=True)
    eval_v6.add_argument("--control", required=True)
    eval_v6.add_argument("--out", required=True)
    eval_v6.set_defaults(func=cmd_eval_v6)

    match_strength = sub.add_parser("match-strength", parents=[common])
    match_strength.add_argument("--v4", required=True)
    match_strength.add_argument("--v6", required=True)
    match_strength.add_argument("--out", required=True)
    match_strength.add_argument("--smoke", action="store_true")
    match_strength.set_defaults(func=cmd_match_strength)

    eval_agg = sub.add_parser("eval-agg", parents=[common])
    eval_agg.add_argument("--v4", required=True)
    eval_agg.add_argument("--candidate", required=True)
    eval_agg.add_argument("--data", required=True)
    eval_agg.add_argument("--control", required=True)
    eval_agg.add_argument("--out", required=True)
    eval_agg.set_defaults(func=cmd_eval_agg)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
