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
 *   npm run benchmark:policy -- --race-tune        # frozen development then confirmation
 *   npm run benchmark:policy -- --progress-diag    # cutoff traces on eight development seeds
 *   npm run benchmark:policy -- --city-trade-check # rejected partial-trade trial, both seed sets
 *   npm run benchmark:policy -- --devcard-rule development
 *   npm run benchmark:policy -- --devcard-rule holdout
 *   npm run benchmark:policy -- --search-smoke
 *   npm run benchmark:policy -- --search-screen --trials 20
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport, runBenchmark } from "./index";
import { formatRaceTuneReport, runRaceWeightExperiment } from "./race-tune";
import {
  compareCityTradeCorrection,
  diagnosisSeedList,
  formatCityTradeComparison,
  formatProgressReport,
  holdoutSeedList,
  runProgressDiagnosis
} from "./progress-diag";
import {
  compareDevCardRule,
  decideDevCardRule,
  devCardHoldoutSeedList,
  developmentSeedList,
  formatDevCardComparison
} from "./devcard-rule";
import { formatSearchScreen, runSearchScreen } from "./search-screen";

interface CliArgs {
  readonly jsonPath?: string;
  readonly trials?: number;
  readonly seed?: string;
  readonly noSweep: boolean;
  readonly raceTune: boolean;
  readonly progressDiag: boolean;
  readonly cityTradeCheck: boolean;
  readonly devcardRule?: "development" | "holdout" | "both";
  readonly searchSmoke: boolean;
  readonly searchScreen: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let jsonPath: string | undefined;
  let trials: number | undefined;
  let seed: string | undefined;
  let noSweep = false;
  let raceTune = false;
  let progressDiag = false;
  let cityTradeCheck = false;
  let devcardRule: "development" | "holdout" | "both" | undefined;
  let searchSmoke = false;
  let searchScreen = false;

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
    } else if (arg === "--race-tune") {
      raceTune = true;
    } else if (arg === "--progress-diag") {
      progressDiag = true;
    } else if (arg === "--city-trade-check") {
      cityTradeCheck = true;
    } else if (arg === "--devcard-rule" && i + 1 < argv.length) {
      const stage = argv[++i];
      if (stage === "development" || stage === "holdout" || stage === "both") devcardRule = stage;
    } else if (arg === "--search-smoke") {
      searchSmoke = true;
    } else if (arg === "--search-screen") {
      searchScreen = true;
    }
  }
  return { ...(jsonPath !== undefined ? { jsonPath } : {}), ...(trials !== undefined ? { trials } : {}), ...(seed !== undefined ? { seed } : {}), noSweep, raceTune, progressDiag, cityTradeCheck, ...(devcardRule !== undefined ? { devcardRule } : {}), searchSmoke, searchScreen };
}

function main(): void {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const args = parseArgs(process.argv.slice(2));

  if (args.searchSmoke || args.searchScreen) {
    const trials = args.trials ?? (args.searchSmoke ? 1 : 20);
    const prefix = args.seed ?? (args.searchSmoke ? "search-smoke" : "search-screen");
    const seeds = Array.from({ length: trials }, (_, index) => `${prefix}-${index}`);
    const smoke = args.searchSmoke && !args.searchScreen;
    const report = runSearchScreen({
      seeds,
      rootK: smoke ? 4 : 8,
      rolloutsPerCandidate: smoke ? 4 : 16,
      maxSimulatedTurns: smoke ? 8 : 70,
      maxSimulatedActions: smoke ? 40 : 450,
      victoryPointsToWin: 15,
      maxTurns: smoke ? 8 : 70,
      maxActions: smoke ? 40 : 450,
      masterSeed: smoke ? "search-v1-smoke" : "search-v1",
      label: smoke
        ? "Stage A plumbing smoke. 4 candidates x 4 rollouts. Not strength evidence."
        : "Stage B strength screen. 8 candidates x 16 rollouts against baseline_heuristic_v1."
    });
    process.stdout.write(formatSearchScreen(report) + "\n");
    if (args.jsonPath) {
      const outPath = resolve(process.cwd(), args.jsonPath);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify({ ...report, trials: report.trials }, null, 2) + "\n", "utf8");
      process.stdout.write(`\nJSON report written to ${outPath}\n`);
    }
    return;
  }

  if (args.devcardRule) {
    const runDevelopment = args.devcardRule === "development" || args.devcardRule === "both";
    const runHoldout = args.devcardRule === "holdout" || args.devcardRule === "both";
    if (runDevelopment) {
      const development = compareDevCardRule(developmentSeedList(), "Development seeds, production-aware dev card vs baseline. Not used for adoption.");
      process.stdout.write(formatDevCardComparison(development) + "\n\n");
    }
    if (runHoldout) {
      const holdout = compareDevCardRule(devCardHoldoutSeedList(), "Holdout seeds, production-aware dev card vs baseline.");
      const decision = decideDevCardRule(holdout);
      process.stdout.write(formatDevCardComparison(holdout) + "\n");
      process.stdout.write(`Decision: ${decision.decision}. ${decision.reason}\n`);
    }
    return;
  }

  if (args.cityTradeCheck) {
    process.stdout.write(formatCityTradeComparison(compareCityTradeCorrection(diagnosisSeedList(), "Diagnosis seeds, partial city trade vs current gate")) + "\n\n");
    process.stdout.write(formatCityTradeComparison(compareCityTradeCorrection(holdoutSeedList(), "Holdout seeds, partial city trade vs current gate")) + "\n");
    return;
  }

  if (args.progressDiag) {
    process.stdout.write(formatProgressReport(runProgressDiagnosis()) + "\n");
    return;
  }

  if (args.raceTune) {
    const tune = runRaceWeightExperiment();
    const text = formatRaceTuneReport(tune);
    process.stdout.write(text + "\n");
    if (args.jsonPath) {
      const outPath = resolve(rootDir, args.jsonPath);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(tune, null, 2) + "\n", "utf8");
      process.stdout.write(`\nJSON report written to ${outPath}\n`);
    }
    return;
  }

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
