/**
 * Stage 3.5 — CLI entry point for `npm run benchmark:policy`.
 *
 * ADDITIVE / EVALUATION ONLY. Runs entirely offline: no browser extension, no live game
 * interaction. Prints a human-readable report and optionally writes JSON.
 *
 * Usage:
 *   npm run benchmark:policy                       # human-readable report
 *   npm run benchmark:policy -- --json out.json    # also write a JSON report
 *   npm run benchmark:policy -- --trials 24        # override trials per policy
 *   npm run benchmark:policy -- --no-sweep         # skip the budget stability sweep
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport, runBenchmark } from "./index";

interface CliArgs {
  readonly jsonPath?: string;
  readonly trials?: number;
  readonly seed?: string;
  readonly noSweep: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let jsonPath: string | undefined;
  let trials: number | undefined;
  let seed: string | undefined;
  let noSweep = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" && i + 1 < argv.length) {
      jsonPath = argv[++i];
    } else if (arg === "--trials" && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) trials = parsed;
    } else if (arg === "--seed" && i + 1 < argv.length) {
      seed = argv[++i];
    } else if (arg === "--no-sweep") {
      noSweep = true;
    }
  }
  return { ...(jsonPath !== undefined ? { jsonPath } : {}), ...(trials !== undefined ? { trials } : {}), ...(seed !== undefined ? { seed } : {}), noSweep };
}

function main(): void {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const args = parseArgs(process.argv.slice(2));

  const report = runBenchmark({
    rootDir,
    ...(args.trials !== undefined ? { numTrials: args.trials } : {}),
    ...(args.seed !== undefined ? { baseSeed: args.seed } : {}),
    includeBudgetSweep: !args.noSweep
  });

  process.stdout.write(formatReport(report) + "\n");

  if (args.jsonPath) {
    const outPath = resolve(rootDir, args.jsonPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    process.stdout.write(`\nJSON report written to ${outPath}\n`);
  }
}

main();
