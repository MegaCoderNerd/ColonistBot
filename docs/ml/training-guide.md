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
