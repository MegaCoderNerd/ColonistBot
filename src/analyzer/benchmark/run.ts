/**
 * Stage 3.5 â€” Offline benchmark runner.
 *
 * ADDITIVE / EVALUATION ONLY. This runner never touches production recommendation code: shadow
 * mode stays disabled, legacy scoring and advice text are untouched, and nothing here is imported
 * by `planTurn`, the extension, or the coach overlay.
 *
 * The runner is invoked via `npm run benchmark:policy` and requires neither the browser extension
 * nor live game interaction.
 */

import { baselineRolloutPolicy, type RolloutPolicy } from "../engine/rollout";
import { STAGE_3_5_DIAGNOSTIC_POLICIES } from "../engine/policies";
import type { BoardTopology } from "../engine/topology";
import { buildObservedGameState } from "../engine/state";
import type { ConcreteSimulatedGameState, ObservedGameState } from "../engine/state";
import type { Recording } from "../../shared/schema";
import { getLegalActions } from "../engine/transition";
import type { SimulatedAction } from "../engine/transition";
import {
  buildRecordingCorpus,
  buildObservedFromRecording,
  loadRecordings,
  type BenchmarkCorpus
} from "./corpus";
import { buildAllSyntheticFixtures } from "./fixtures";
import { buildGeneratedOpening } from "./generated-board";
import { runCrossPlay, type CrossPlayReport } from "./crossplay";
import { buildTacticalCases } from "./tactical";
import {
  comparePoliciesPaired,
  describeAction,
  evaluatePolicyOnPosition,
  measureCandidateBudgetStability,
  runTacticalSuite,
  type PolicyComparisonOptions
} from "./evaluate";
import type {
  BenchmarkPosition,
  BudgetStabilityResult,
  PairedPolicyComparison,
  PolicyPositionResult,
  TacticalSuiteResult
} from "./types";

/** Policies always evaluated: the production baseline plus the Stage 3.5 diagnostic variants. */
export function evaluatedPolicies(): RolloutPolicy[] {
  return [baselineRolloutPolicy, ...STAGE_3_5_DIAGNOSTIC_POLICIES];
}

export interface BenchmarkRunOptions {
  readonly rootDir: string;
  readonly numTrials?: number;
  readonly baseSeed?: number | string;
  readonly budgets?: readonly number[];
  /** Cap how many positions get the (more expensive) full policy comparison. */
  readonly maxPositionsForPolicyComparison?: number;
  readonly maxTurnsPerRollout?: number;
  readonly maxActionsPerRollout?: number;
  /** Skip the budget sweep entirely (useful for a fast smoke run). */
  readonly includeBudgetSweep?: boolean;
}

export interface BenchmarkReport {
  readonly generatedAtIso: string;
  readonly nodeVersion: string;
  readonly recordingsAvailable: boolean;
  readonly recordingsPath?: string;
  readonly coverage: BenchmarkCorpus["coverage"];
  readonly policies: readonly string[];
  readonly tactical: readonly TacticalSuiteResult[];
  readonly policyComparisons: readonly PolicyPositionResult[];
  readonly pairedComparisons: readonly PairedPolicyComparison[];
  readonly budgetStability: readonly BudgetStabilityResult[];
  readonly syntheticPositionsUsed: readonly string[];
  readonly crossPlay?: CrossPlayReport;
  readonly knownLimitations: readonly string[];
  readonly summary: string;
}

const KNOWN_LIMITATIONS: readonly string[] = [
  "Rollout evaluations use heuristic rollout policies and do not predict how real human opponents play or trade.",
  "Domestic player-to-player trades are disabled during baseline rollouts; only legal maritime/bank trades are simulated.",
  "Common Random Numbers guarantee identical initial determinized states across policies for a matching trial index. Continuation streams are seeded identically but their future draws are only paired while policies consume the same stochastic domains in the same order; different actions can change dice, development-card, theft, and policy draw positions, so identical future outcomes are not claimed.",
  "Paired difference testing (exact two-tailed McNemar) tests for evidence of difference across matched initial determinized worlds. A non-significant result (p >= alpha) indicates no clear difference detected, NOT equivalence; claiming equivalence would require a pre-specified equivalence margin.",
  "Overlapping Wilson intervals between the top two candidates are reported as an observation only. Overlap is not proof of equivalence and non-overlap is not a complete answer to all practical considerations.",
  "Empirical win rates and Wilson intervals strictly use completed games as the denominator; cutoffs and failures are recorded separately and are neither counted as wins nor losses.",
  "Recording frames that materialize into a supported phase with no legal action are excluded from the simulatable corpus; these are transient or internally inconsistent snapshots, not policy losses.",
  "The random legal-action policy is intentionally non-competitive: repeated bank trades, missed conversions, and long games that hit the horizon are expected diagnostic behaviour, not evidence of an engine defect.",
  "Tactical pass rates cover only rule-proven and constructed-scenario-proven cases. Positions with multiple valid choices or no established answer are reported as informational and never counted as failures.",
  "Balanced Dice models are provisional empirical approximations (isExact: false), not exact reproductions of proprietary Colonist server code. Colonist 1v1 per-player seven-streak balancing is not modeled.",
  "Positions from the same recording are grouped by recording ID and must never be split across evaluation folds; a recording is not an independent sample per frame.",
  "Stage 3.5 is an experimental evaluation milestone. Shadow mode remains disabled by default and no production recommendation, score, advice text, opening pick, or map target is changed by this harness.",
  "Generated cross-play uses the rules engine from setup on a seeded standard 19-hex board. It does not require a Colonist recording. The board is not an official Colonist map seed.",
  "Cross-play win rates use completed games only. Turn and action cutoffs are counted separately and are not wins, losses, or draws.",
  "Inside a simulated game each policy uses its own hand. The settlement-race clock still uses the opponent's public hand size and production, not the hidden card types in that sample.",
  "Domestic player trades stay disabled. Balanced dice are an approximation. Development cards, the robber, and bank trades follow the implemented rules and can still differ from Colonist.",
  "A Wilson interval on a small completed-game count is uncertainty, not statistical significance, and not evidence of professional strength.",
  "baseline_heuristic_v1 is the race-aware heuristic. baseline_distance_only_v1 is that same heuristic with the race penalty off. They are compared because the road rule differs. The settlement racer, development policy, longest-road policy, and random legal policy use different action orders."
];


/**
 * Runs the full Stage 3.5 evaluation: tactical suite, controlled policy comparison on stratified
 * positions, and a candidate budget-stability sweep. Returns a structured, reproducible report.
 */
export function runBenchmark(options: BenchmarkRunOptions): BenchmarkReport {
  const numTrials = options.numTrials ?? 12;
  const baseSeed = options.baseSeed ?? "stage-3.5-benchmark";
  const budgets = options.budgets ?? [12, 24, 48];
  const maxPolicyPositions = options.maxPositionsForPolicyComparison ?? 6;
  const policies = evaluatedPolicies();

  // 1. Load recordings (optional) and build the stratified corpus.
  const { path: recordingsPath, recordings } = loadRecordings(options.rootDir);
  const corpus = buildRecordingCorpus(recordings, {
    sampleSeed: "stage-3.5-corpus",
    frameFractions: [0.35, 0.6, 0.85, 1]
  });

  // 2. Build synthetic fixtures. These ALWAYS run so the tactical suite is never empty, and every
  //    synthetic position is labelled as such in the report.
  const seedRecording = recordings.length > 0 ? recordings[0] : undefined;
  const generatedOpening = buildGeneratedOpening(String(baseSeed));
  const seedObserved = seedRecording
    ? buildObservedFromRecording(seedRecording)?.observed
    : generatedOpening.observed;

  const syntheticPositions: BenchmarkPosition[] = [];
  const tacticalSuites: TacticalSuiteResult[] = [];

  if (seedObserved) {
    const fixtures = buildAllSyntheticFixtures(seedObserved.topology, seedObserved);
    syntheticPositions.push(
      fixtures.immediateWinByCity,
      fixtures.noImmediateWinAvailable,
      fixtures.insufficientResources,
      fixtures.forcedDiscard,
      fixtures.robberBlocksSelfWithKnight,
      fixtures.multipleValidPlacements,
      fixtures.openEndedMidgame
    );
    const cases = buildTacticalCases(fixtures);
    for (const policy of policies) {
      tacticalSuites.push(runTacticalSuite(policy, cases, { seed: baseSeed }));
    }
  }

  // 3. Controlled policy comparison on a capped number of corpus positions.
  const comparisonOptions: PolicyComparisonOptions = {
    numTrials,
    baseSeed,
    maxTurnsPerRollout: options.maxTurnsPerRollout ?? 120,
    maxActionsPerRollout: options.maxActionsPerRollout ?? 600
  };
  const policyComparisons: PolicyPositionResult[] = [];
  const pairedComparisons: PairedPolicyComparison[] = [];
  for (const position of corpus.positions.slice(0, maxPolicyPositions)) {
    const results = policies.map((policy) =>
      evaluatePolicyOnPosition(position, policy, comparisonOptions)
    );
    policyComparisons.push(...results);
    const baselineResult = results[0];
    for (const other of results.slice(1)) {
      pairedComparisons.push(comparePoliciesPaired(baselineResult, other));
    }
  }

  // 4. Candidate budget-stability sweep on the first corpus position (or the synthetic midgame).
  const budgetStability: BudgetStabilityResult[] = [];
  const sweepPosition = corpus.positions[0] ?? syntheticPositions[syntheticPositions.length - 1];
  if (options.includeBudgetSweep !== false && sweepPosition) {
    const candidates = legalActionsForStability(sweepPosition);
    if (candidates.length >= 2) {
      budgetStability.push(
        measureCandidateBudgetStability({
          position: sweepPosition,
          candidates,
          budgets,
          baseSeed,
          maxTurnsPerRollout: options.maxTurnsPerRollout ?? 120,
          maxActionsPerRollout: options.maxActionsPerRollout ?? 600
        })
      );
    }
  }

  const crossPlay = runCrossPlay({
    topology: generatedOpening.topology,
    seed: baseSeed,
    trials: numTrials,
    victoryPointsToWin: 10,
    maxTurns: options.maxTurnsPerRollout ?? 70,
    maxActions: options.maxActionsPerRollout ?? 450,
    highNumbersTouch: generatedOpening.highNumbersTouch
  });

  return {
    generatedAtIso: new Date().toISOString(),
    nodeVersion: process.version,
    recordingsAvailable: corpus.coverage.recordingsAvailable,
    ...(recordingsPath !== undefined ? { recordingsPath } : {}),
    coverage: corpus.coverage,
    policies: policies.map((p) => p.id),
    tactical: tacticalSuites,
    policyComparisons,
    pairedComparisons,
    budgetStability,
    syntheticPositionsUsed: syntheticPositions.map((p) => p.positionId),
    crossPlay,
    knownLimitations: KNOWN_LIMITATIONS,
    summary: buildSummary({
      corpus,
      tacticalSuites,
      policyComparisons,
      pairedComparisons,
      budgetStability,
      syntheticCount: syntheticPositions.length,
      numTrials,
      crossPlay
    })
  };
}


/**
 * Selects up to `maxCandidates` distinct legal actions from a position to use as the candidate set
 * for the budget-stability sweep. Deterministic: candidates follow engine enumeration order.
 */
function legalActionsForStability(
  position: BenchmarkPosition,
  maxCandidates = 4
): { candidateId: string; label: string; action: SimulatedAction }[] {
  const actions = getLegalActions(position.concrete, position.selfId);
  const seen = new Set<string>();
  const out: { candidateId: string; label: string; action: SimulatedAction }[] = [];
  for (const action of actions) {
    // Skip stochastic/no-op actions: they are not meaningful strategic candidates.
    if (action.type === "rollDice" || action.type === "endTurn") continue;
    const key = describeAction(action);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ candidateId: key, label: key, action });
    if (out.length >= maxCandidates) break;
  }
  return out;
}

function buildSummary(args: {
  corpus: BenchmarkCorpus;
  tacticalSuites: readonly TacticalSuiteResult[];
  policyComparisons: readonly PolicyPositionResult[];
  pairedComparisons: readonly PairedPolicyComparison[];
  budgetStability: readonly BudgetStabilityResult[];
  syntheticCount: number;
  numTrials: number;
  crossPlay?: CrossPlayReport;
}): string {
  const lines: string[] = [];
  lines.push("Stage 3.5 policy evaluation summary");
  lines.push(
    `- Positions: ${args.corpus.positions.length} recorded across ` +
      `${args.corpus.groupIds.length} recording group(s); ${args.syntheticCount} synthetic.`
  );
  if (args.corpus.coverage.reducedCoverage) {
    lines.push(
      "- REDUCED RECORDED COVERAGE: no recording dataset was available, so recorded-position " +
        "comparison did not run. Generated-board cross-play still ran."
    );
  }
  if (args.crossPlay) {
    lines.push(
      `- Cross-play: ${args.crossPlay.matchups.length} seat matchup(s), ` +
        `${args.crossPlay.trialsPerSeat} trial(s) per seat, first to ${args.crossPlay.victoryPointsToWin} VP.`
    );
    for (const matchup of args.crossPlay.matchups) {
      const rate = matchup.winRateAmongCompleted === null ? "n/a" : `${(matchup.winRateAmongCompleted * 100).toFixed(1)}%`;
      lines.push(
        `  - ${matchup.focusPolicyId} as ${matchup.focusPlayerId} vs ${matchup.opponentPolicyId}: ` +
          `completed ${matchup.completed}/${matchup.trials} (wins ${matchup.wins}, losses ${matchup.losses}, draws ${matchup.draws}, ` +
          `cutoffs ${matchup.cutoffs}, failures ${matchup.failures}), win rate ${rate}. ${matchup.establishes}`
      );
    }
  }

  for (const suite of args.tacticalSuites) {
    const rate = suite.provenPassRate === null ? "n/a" : `${(suite.provenPassRate * 100).toFixed(1)}%`;
    lines.push(
      `- Tactical (${suite.policyId}): ${suite.provenCasesPassed}/${suite.provenCasesTotal} ` +
        `rule-proven cases passed (${rate}).`
    );
  }

  if (args.policyComparisons.length > 0) {
    const byPolicy = new Map<string, PolicyPositionResult[]>();
    for (const r of args.policyComparisons) {
      const list = byPolicy.get(r.policyId);
      if (list) list.push(r);
      else byPolicy.set(r.policyId, [r]);
    }
    lines.push(
      `- Policy comparison: ${args.policyComparisons.length} policy-position run(s) at ` +
        `${args.numTrials} trial(s) each.`
    );
    for (const [policyId, results] of byPolicy) {
      const completed = results.reduce((s, r) => s + r.accounting.completed, 0);
      const wins = results.reduce((s, r) => s + r.accounting.wins, 0);
      const cutoffs =
        results.reduce((s, r) => s + r.accounting.cutoffMaxTurns, 0) +
        results.reduce((s, r) => s + r.accounting.cutoffMaxActions, 0);
      const failures = results.reduce((s, r) => s + r.accounting.failed, 0);
      const terminationReasons: Record<string, number> = {};
      for (const result of results) {
        for (const [reason, count] of Object.entries(result.accounting.terminationReasons)) {
          terminationReasons[reason] = (terminationReasons[reason] ?? 0) + count;
        }
      }
      const rate = completed > 0 ? `${((wins / completed) * 100).toFixed(1)}%` : "n/a";
      lines.push(
        `  - ${policyId}: wins ${wins}/${completed} completed (${rate}); ` +
          `attempted ${results.reduce((s, r) => s + r.accounting.sampleCount, 0)}; ` +
          `cutoffs ${cutoffs}; failures ${failures}; ` +
          `completion ${completed}/${results.reduce((s, r) => s + r.accounting.sampleCount, 0)}.`
      );
      lines.push(
        `    termination reasons: ${Object.entries(terminationReasons)
          .map(([reason, count]) => `${reason}=${count}`)
          .join(", ") || "none"}`
      );
    }
  }

  const favorA = args.pairedComparisons.filter((c) => c.classification === "evidence_favors_A").length;
  const favorB = args.pairedComparisons.filter((c) => c.classification === "evidence_favors_B").length;
  const noClear = args.pairedComparisons.filter((c) => c.classification === "no_clear_difference").length;
  const insufficient = args.pairedComparisons.filter((c) => c.classification === "insufficient_data").length;
  if (args.pairedComparisons.length > 0) {
    lines.push(
      `- Paired comparisons vs baseline: ${favorA} favour baseline, ${favorB} favour the other ` +
        `policy, ${noClear} show no clear difference, ${insufficient} had insufficient data. ` +
        `"No clear difference" is not a demonstration of equivalence.`
    );
  }

  for (const sweep of args.budgetStability) {
    lines.push(
      `- Budget stability (${sweep.positionId}): selection changed at ` +
        `${sweep.selectionChangesAcrossBudgets} budget step(s).`
    );
  }

  lines.push(
    "- No production recommendation, score, advice text, opening pick, or map target was changed. " +
      "Shadow mode remains disabled by default."
  );
  return lines.join("\n");
}


/** Renders a report as human-readable text for the CLI. */
export function formatReport(report: BenchmarkReport): string {
  const out: string[] = [];
  const rule = "=".repeat(78);
  out.push(rule);
  out.push("Stage 3.5 â€” Policy Evaluation, Tactical Benchmarks, Decision-Quality Validation");
  out.push(rule);
  out.push(`Generated:  ${report.generatedAtIso}`);
  out.push(`Node:       ${report.nodeVersion}`);
  out.push(`Recordings: ${report.recordingsAvailable ? "available" : "NOT available"}`);
  if (report.recordingsPath) out.push(`Path:       ${report.recordingsPath}`);
  out.push(`Policies:   ${report.policies.join(", ")}`);

  out.push("");
  out.push(`-- Coverage ${"-".repeat(66)}`);
  out.push(report.coverage.coverageNote);
  out.push(
    `Positions built: ${report.coverage.positionsBuilt} | skipped: ${report.coverage.positionsSkipped}`
  );
  const strata = Object.entries(report.coverage.stratumCounts);
  if (strata.length > 0) {
    out.push("Strata: " + strata.map(([k, v]) => `${k}=${v}`).join(", "));
  }
  if (report.coverage.reducedCoverage) {
    out.push("");
    out.push("!! REDUCED RECORDED COVERAGE: the recording dataset was unavailable.");
    out.push("!! Recorded-position comparison did not run. Generated-board cross-play is reported below.");
  }

  out.push("");
  out.push(`-- Tactical correctness ${"-".repeat(51)}`);
  for (const suite of report.tactical) {
    const rate = suite.provenPassRate === null ? "n/a" : `${(suite.provenPassRate * 100).toFixed(1)}%`;
    const ci = suite.wilson95
      ? ` [Wilson 95% ${(suite.wilson95.lower * 100).toFixed(1)}%-${(suite.wilson95.upper * 100).toFixed(1)}%]`
      : "";
    out.push(
      `${suite.policyId}: ${suite.provenCasesPassed}/${suite.provenCasesTotal} rule-proven passed ` +
        `(${rate})${ci}`
    );
    for (const failure of suite.failures) {
      out.push(`  FAIL ${failure.caseId}: selected ${failure.selectedAction}`);
      if (failure.notes) out.push(`       ${failure.notes}`);
    }
    const informational = suite.results.filter((r) => r.outcome === "informational");
    if (informational.length > 0) {
      out.push(
        `  (${informational.length} informational case(s) excluded from the pass-rate denominator: ` +
          `${informational.map((r) => r.caseId).join(", ")})`
      );
    }
  }

  out.push("");
  out.push(`-- Policy comparison ${"-".repeat(56)}`);
  if (report.policyComparisons.length === 0) {
    out.push("No empirical policy comparison ran (no usable recorded positions).");
  } else {
    const byPosition = new Map<string, PolicyPositionResult[]>();
    for (const r of report.policyComparisons) {
      const list = byPosition.get(r.positionId);
      if (list) list.push(r);
      else byPosition.set(r.positionId, [r]);
    }
    for (const [positionId, results] of byPosition) {
      out.push(`Position ${positionId} (group ${results[0]?.groupId}):`);
      for (const r of results) {
        const rate =
          r.winRateAmongCompleted === null ? "n/a" : `${(r.winRateAmongCompleted * 100).toFixed(1)}%`;
        const ci = r.wilson95
          ? ` [${(r.wilson95.lower * 100).toFixed(1)}-${(r.wilson95.upper * 100).toFixed(1)}%]`
          : "";
        out.push(
          `  ${r.policyId.padEnd(30)} win ${rate}${ci} | completed ${r.accounting.completed}/` +
            `${r.accounting.sampleCount} | cutoff ${r.accounting.cutoffMaxTurns + r.accounting.cutoffMaxActions}` +
            ` | failed ${r.accounting.failed} | reasons ${Object.entries(r.accounting.terminationReasons)
              .map(([reason, count]) => `${reason}=${count}`)
              .join(", ")} | ${r.elapsedMs.toFixed(0)}ms`
        );
      }
    }
    out.push("");
    out.push("Paired comparisons vs baseline (exact two-tailed McNemar):");
    for (const c of report.pairedComparisons) {
      const p = c.mcnemarPValue === null ? "n/a" : c.mcnemarPValue.toFixed(4);
      out.push(
        `  ${c.policyBId} vs ${c.policyAId}: ${c.classification} (p=${p}, paired n=${c.pairedCompletedTrials})`
      );
    }
  }

  out.push("");
  out.push(`-- Generated cross-play ${"-".repeat(54)}`);
  if (!report.crossPlay) {
    out.push("Cross-play did not run.");
  } else {
    out.push(
      `Seed ${report.crossPlay.seed}. First to ${report.crossPlay.victoryPointsToWin} VP. ` +
        `${report.crossPlay.trialsPerSeat} trial(s) from each seat. ` +
        `High-number tokens touch: ${report.crossPlay.highNumbersTouch ? "yes" : "no"}.`
    );
    out.push("Wins use completed games only. Cutoffs are not wins or losses.");
    out.push("This does not establish professional strength.");
    for (const matchup of report.crossPlay.matchups) {
      const rate = matchup.winRateAmongCompleted === null ? "n/a" : `${(matchup.winRateAmongCompleted * 100).toFixed(1)}%`;
      const ci = matchup.wilson95
        ? ` Wilson95 ${(matchup.wilson95.lower * 100).toFixed(1)}-${(matchup.wilson95.upper * 100).toFixed(1)}%`
        : "";
      const margin = matchup.meanVpMarginAmongCompleted === null ? "n/a" : matchup.meanVpMarginAmongCompleted.toFixed(2);
      const turns = matchup.meanTurnsAmongCompleted === null ? "n/a" : matchup.meanTurnsAmongCompleted.toFixed(1);
      const city = matchup.meanFirstCityTurn === null ? "n/a" : matchup.meanFirstCityTurn.toFixed(1);
      out.push(
        `${matchup.focusPolicyId} as ${matchup.focusPlayerId} vs ${matchup.opponentPolicyId}: ` +
          `completed ${matchup.completed}/${matchup.trials} W${matchup.wins} L${matchup.losses} D${matchup.draws} ` +
          `cutoff ${matchup.cutoffs} fail ${matchup.failures} win ${rate}${ci}`
      );
      out.push(
        `  VP margin ${margin} | turns ${turns} | focus VP ${matchup.meanFocusVpAmongCompleted === null ? "n/a" : matchup.meanFocusVpAmongCompleted.toFixed(2)} ` +
          `| main settlements ${matchup.meanMainSettlements === null ? "n/a" : matchup.meanMainSettlements.toFixed(2)} ` +
          `| dead-end roads ${matchup.meanDeadEndRoads === null ? "n/a" : matchup.meanDeadEndRoads.toFixed(2)} ` +
          `| roads into an opponent ${matchup.meanBlockedRoads === null ? "n/a" : matchup.meanBlockedRoads.toFixed(2)} ` +
          `| first city turn ${city} | discards ${matchup.meanDiscards === null ? "n/a" : matchup.meanDiscards.toFixed(2)} ` +
          `| longest road ${matchup.longestRoadGames} | largest army ${matchup.largestArmyGames} | ${matchup.elapsedMs.toFixed(0)}ms`
      );
      out.push(`  ${matchup.establishes}`);
    }
  }

  out.push("");
  out.push(`-- Budget stability ${"-".repeat(57)}`);
  if (report.budgetStability.length === 0) {
    out.push("Budget sweep did not run (no position with >= 2 comparable candidates).");
  } else {
    for (const sweep of report.budgetStability) {
      out.push(`Position ${sweep.positionId}:`);
      for (const row of sweep.rows) {
        const sel = row.selectedWinRate === null ? "n/a" : `${(row.selectedWinRate * 100).toFixed(1)}%`;
        const overlap = row.topTwoIntervalsOverlap === null ? "n/a" : String(row.topTwoIntervalsOverlap);
        out.push(
          `  budget=${String(row.trialsPerCandidate).padStart(3)} selected=${row.selectedCandidateId ?? "none"}` +
            ` (${sel}) runnerUp=${row.runnerUpCandidateId ?? "none"} overlap=${overlap}` +
            ` completed=${row.completed} cutoff=${row.cutoff} failed=${row.failed}` +
            ` confidence=${row.confidenceStatus}` +
            ` ${row.elapsedMs.toFixed(0)}ms`
        );
      }
      out.push(`  ${sweep.interpretation}`);
    }
  }

  out.push("");
  out.push(`-- Known limitations ${"-".repeat(55)}`);
  for (const [i, limitation] of report.knownLimitations.entries()) {
    out.push(`${i + 1}. ${limitation}`);
  }
  out.push("");
  out.push(report.summary);
  out.push(rule);
  return out.join("\n");
}
