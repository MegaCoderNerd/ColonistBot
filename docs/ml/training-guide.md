# Training guide

Python 3.10 and the already installed PyTorch build are enough. The smoke forces CPU. A CUDA wheel can stay installed; pass `--device cpu` anyway for the smoke. Do not download a Colonist archive first.

From the repository root in PowerShell:

```powershell
py -3.10 -m pip install pytest
$env:PYTHONPATH = "ml"
```

`pytest` is the only extra package the tests need. Do not reinstall torch if `py -3.10 -c "import torch"` already works.

## 1. Heuristic demonstrations

```powershell
npm run ml:engine -- export --out data/ml/generated/heuristic_demonstrations.jsonl --seeds ml-synth-0,ml-synth-1 --vp 3 --max-turns 20 --max-actions 120
```

This writes labeled behavior from the existing policies. The stderr line reports how many games completed. An incomplete game has `actor_win` null. The output directory is gitignored.

The default pairs are baseline versus distance-only, aggressive dev, longest road, the settlement racer, and the random diagnostic. Override with `--pairs id:id,id:id`. Policy ids are the keys of `POLICY_POOL` in `src/analyzer/ml/games.ts`.

## 2. Supervised smoke

```powershell
py -3.10 -m colonist_ml.cli train --data ml/fixtures/synthetic_decisions.jsonl --out ml/runs/smoke --epochs 1 --device cpu
```

Or point `--data` at the exported JSONL. The command prints the example count, the loss, and one action id chosen from that position's legal list. The checkpoint is `ml/runs/smoke/supervised.pt`.

Resume for one more epoch:

```powershell
py -3.10 -m colonist_ml.cli resume --checkpoint ml/runs/smoke/supervised.pt --data ml/fixtures/synthetic_decisions.jsonl --out ml/runs/resume --device cpu
```

The saved epoch is the loaded epoch plus one. Held-out seeds `ml-holdout-0` and `ml-holdout-1` are rejected if they appear in the file.

## 3. Self-play

```powershell
py -3.10 -m colonist_ml.cli self-play --checkpoint ml/runs/smoke/supervised.pt --out ml/runs/selfplay --device cpu --vp 3 --max-turns 20 --max-actions 120
```

Four games run in one bridge process:

| Seed | Learner seat | Opponent |
| --- | --- | --- |
| ml-rl-0 | c1 | baseline_heuristic_v1 |
| ml-rl-1 | c2 | aggressive_dev_heuristic_v1 |
| ml-rl-2 | both | the same network |
| ml-rl-3 | c1 | random_legal_diagnostic_v1 |

The smoke collects games and applies terminal-return PPO only to completed games. A cutoff is stored and does not enter the gradient. `ml/runs/phase2-smoke/summary.json` lists launches, completions, cutoff reasons, eligible games, gradient steps, and decisions used. Those counts are not the same number.

## Phase 2

The technical smoke is still:

```powershell
py -3.10 -m colonist_ml.cli self-play --out ml/runs/phase2-smoke --device cpu
```

That uses a 3 VP, 20 turn horizon and is not the strength measurement. The frozen run is:

```powershell
py -3.10 -m colonist_ml.cli experiment --out ml/runs/phase2 --device cpu
```

It refuses to start unless `budget_frozen` is true in `ml/colonist_ml/protocol.py`. The algorithm, seeds, and retention rule are in `docs/ml/rl-phase2.md`.

A separate tiny eval remains available:

```powershell
py -3.10 -m colonist_ml.cli eval --checkpoint ml/runs/phase2-smoke/latest.pt --out ml/runs/phase2-smoke/eval.json --device cpu --vp 3 --max-turns 20 --max-actions 120
```

That command uses `ml-holdout-0` and `ml-holdout-1`. It is not the 200-seed measurement. `demonstrated_improvement` stays false unless the paired interval lies above zero with at least eight completed pairs.

Use the same `--vp`, `--max-turns`, and `--max-actions` for self-play and eval when you compare them. The smoke default is 3 victory points, 20 turns, and 120 actions. A 4-point, 8-turn export of six games completed none of them, so that horizon does not produce an outcome target. These knobs are not the 10 victory-point, 70-turn benchmark.

## Overnight CPU training

Run these from the repository root. `PYTHONPATH` must include `ml`. Python 3.10 is the interpreter that has the installed PyTorch build. The commands below use CPU. `--device cuda` is accepted only when that build reports a GPU; the configs here set `"device": "cpu"`.

The overnight config is `ml/configs/overnight-supervised.json`: 8 epochs, batch 64, seed 7, learning rate 0.001, output `ml/runs/overnight`. Every 2 epochs it plays frozen `baseline_heuristic_v1` on `ml-holdout-0` and `ml-holdout-1`, both seats, at 3 victory points, 20 turns, and 80 actions. Those two seeds are rejected if they appear in the training file. Change `epochs`, `batch_size`, the export `--seeds`, `--vp`, `--max-turns`, and `--max-actions` in the config when you want a longer or shorter job. Do not point `out` at `ml/runs/phase6/summary_v4.pt` or `ml/runs/phase9/road_v6.pt`.

```powershell
$env:PYTHONPATH = "ml"
npm run ml:engine -- export --out data/ml/generated/overnight_train.jsonl --seeds ml-overnight-0,ml-overnight-1 --vp 3 --max-turns 20 --max-actions 80
py -3.10 -m colonist_ml.cli validate-config --config ml/configs/overnight-supervised.json
py -3.10 -m colonist_ml.cli local-train --config ml/configs/overnight-supervised.json
```

That export and the validate command were run. The 8-epoch job was not started. The same command with the smaller `ml/configs/pipeline-smoke.json` was started, stopped after epoch 1, and resumed through epoch 2.

Progress is `ml/runs/overnight/status.jsonl`, one JSON object per line. An `epoch` line has the loss, the policy loss, the value loss, `optimizer_steps`, `weight_sha256`, `checkpoint_sha256`, and `previous_sha256`. An `eval` line has games, completed games, incomplete games, cutoff reasons, wins, and losses. `py -3.10 -m colonist_ml.cli report --run ml/runs/overnight` prints the last line and whether the checkpoints exist.

`latest.pt` is the newest epoch. `best.pt` is the lowest loss so far. `latest.pt.prev` is the checkpoint from the previous successful save. Each write goes to a temporary file and then replaces the target. A failed write leaves the previous file in place. The value loss uses `actor_win` only when `completion_status` is `completed`. A cutoff stays `incomplete`, keeps `actor_win` null, and is not a loss.

Stop after the current epoch by creating `ml/runs/overnight/STOP`. Ctrl+C sets the same flag, which the loop reads before the next epoch. Both leave `latest.pt` from the last finished epoch. Resume only after deleting `STOP`, with the same config:

```powershell
Remove-Item ml/runs/overnight/STOP -ErrorAction SilentlyContinue
py -3.10 -m colonist_ml.cli local-train --config ml/configs/overnight-supervised.json --resume
py -3.10 -m colonist_ml.cli report --run ml/runs/overnight
```

Resume loads the model, the Adam state, the epoch, and the Torch RNG state saved at the last epoch boundary. The next epoch reads the training file from the beginning again. A batch that was in progress when the process died is not continued mid-batch. On the fixture, an interrupted 3-epoch run and an uninterrupted 3-epoch run finished with the same weight hash. That match is for this CPU update at epoch boundaries. It is not a claim about a kill during `optimizer.step`.

The bounded run that was executed is:

```powershell
$env:PYTHONPATH = "ml"
npm run ml:engine -- export --out data/ml/generated/overnight_smoke.jsonl --seeds ml-overnight-0,ml-overnight-1 --vp 3 --max-turns 12 --max-actions 40
py -3.10 -m colonist_ml.cli validate-config --config ml/configs/pipeline-smoke.json
py -3.10 -m colonist_ml.cli local-train --config ml/configs/pipeline-smoke.json --stop-after-epoch 1
py -3.10 -m colonist_ml.cli local-train --config ml/configs/pipeline-smoke.json --resume
py -3.10 -m colonist_ml.cli report --run ml/runs/pipeline-smoke
```

Epoch 1 stopped with optimizer step 17. Resume finished epoch 2 at step 34 with a different weight hash. `latest.pt.prev` matched the epoch-1 checkpoint hash. Eval played 4 games against `baseline_heuristic_v1`: 3 completed, 1 `max_turns_reached` cutoff, 0 wins. The training seeds were `ml-overnight-0` and `ml-overnight-1`. The eval seeds were `ml-holdout-0` and `ml-holdout-1`. The report is `ml/runs/pipeline-smoke/eval.json`. This smoke is not a strength result.

A labeled action that is absent from that position's legal list raises before the optimizer step. Eval scores only the legal candidate list and rejects an index outside it.

The separate v7 training and 800-game match commands are in `docs/ml/phase12-protocol.md`. They are not the overnight loop, and that match is not rerun from here.

## Tests

```powershell
npx tsc --noEmit
npx vitest run
py -3.10 -m pytest ml/tests
```

Run the Python tests from the repository root after `PYTHONPATH=ml`, or from `ml/` where `pytest.ini` sets the path.

The benchmark smoke (`npm run benchmark:policy -- --trials 2 --no-sweep`) is only required when the default TypeScript simulation path changes. This learner does not change that path.

## What the result is allowed to say

Report the game count, how many finished, which policies dealt, and the cutoff rate. A higher dev-card count or a single win is not professional strength. The baseline action in a demonstration file is not an optimal label. The network stays out of the extension until a held-out comparison against the unchanged baseline shows an improvement under limits you have stated.
