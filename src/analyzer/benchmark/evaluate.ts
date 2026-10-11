/**
 * Stage 3.5 — Policy evaluation: tactical suite, controlled policy comparison, budget stability.
 *
 * ADDITIVE / EVALUATION ONLY. Reuses Stage 3.3/3.4 machinery directly:
 * - `runDeterminizedRollouts` / `runRollout` for matched determinized trials.
 * - `computeWilson95Interval` and `computeExactTwoTailedBinomialPValue` for uncertainty and
 *   paired difference testing, so denominators and semantics match Stage 3.4 exactly.
 *
 * Reporting discipline: win rates use COMPLETED games only as the denominator; cutoffs and
 * failures are reported separately and never counted as wins or losses. Non-significant paired
 * results are labelled `no_clear_difference`, never equivalence.
 */

import type { SimulatedAction } from "../engine/transition";
import type { ConcreteSimulatedGameState, ObservedGameState } from "../engine/state";
import type { DeterminizationOptions } from "../engine/determinize";
import { createSeededRng, deriveTrialSeed, type SeededRng } from "../engine/rng";
import {
  baselineRolloutPolicy,
  runDeterminizedRollouts,
  runRollout,
  type RolloutPolicy
} from "../engine/rollout";
import { sampleDeterminization } from "../engine/determinize";
import { applyAction, getLegalActions, isActionLegal } from "../engine/transition";
import {
  computeExactTwoTailedBinomialPValue,
  computeWilson95Interval,
  type WilsonConfidenceInterval
} from "../engine/shadow";
import type {
  BenchmarkPosition,
  BudgetSweepRow,
  BudgetStabilityResult,
  CandidateForStability,
  PairedPolicyComparison,
  PolicyPositionResult,
  PolicyTrialOutcome,
  TacticalCase,
  TacticalCaseResult,
  TacticalOutcome,
  TacticalSuiteResult
} from "./types";

export function describeAction(action: SimulatedAction | undefined): string {
  if (!action) return "none";
  switch (action.type) {
    case "placeSetupSettlement":
      return `placeSetupSettlement(${action.cornerIndex})`;
    case "placeSetupRoad":
      return `placeSetupRoad(${action.edgeIndex})`;
    case "rollDice":
      return "rollDice";
    case "discard":
      return `discard(${JSON.stringify(action.cards)})`;
    case "moveRobber":
      return `moveRobber(${action.hexIndex}${action.victimId ? `,${action.victimId}` : ""})`;
    case "buildRoad":
      return `buildRoad(${action.edgeIndex})`;
    case "buildSettlement":
      return `buildSettlement(${action.cornerIndex})`;
    case "buildCity":
      return `buildCity(${action.cornerIndex})`;
    case "buyDevCard":
      return "buyDevCard";
    case "playKnight":
      return "playKnight";
    case "playRoadBuilding":
      return "playRoadBuilding";
    case "placeFreeRoad":
      return `placeFreeRoad(${action.edgeIndex})`;
    case "playYearOfPlenty":
      return `playYearOfPlenty(${action.resources.join("+")})`;
    case "playMonopoly":
      return `playMonopoly(${action.resource})`;
    case "bankTrade":
      return `bankTrade(${action.give}->${action.receive})`;
    case "playerTrade":
      return `playerTrade(${action.partnerId})`;
    case "endTurn":
      return "endTurn";
    default:
      return "unknown";
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function intervalsOverlap(
  a: WilsonConfidenceInterval | null,
  b: WilsonConfidenceInterval | null
): boolean | null {
  if (!a || !b) return null;
  return a.lower <= b.upper && b.lower <= a.upper;
}

export function assessCandidateConfidence(
  top: { readonly completed: number; readonly wins: number },
  runnerUp: { readonly completed: number; readonly wins: number } | undefined,
  minCompleted: number
): {
  readonly status: "meaningful_preference" | "low_confidence" | "inconclusive";
  readonly sufficientEvidenceForPreference: boolean;
  readonly intervalsOverlap: boolean | null;
} {
  if (!runnerUp || top.completed < minCompleted || runnerUp.completed < minCompleted) {
    return {
      status: "inconclusive",
      sufficientEvidenceForPreference: false,
      intervalsOverlap: null
    };
  }
  const overlap = intervalsOverlap(
    computeWilson95Interval(top.wins, top.completed),
    computeWilson95Interval(runnerUp.wins, runnerUp.completed)
  );
  const sufficient = overlap === false;
  return {
    status: sufficient ? "meaningful_preference" : "low_confidence",
    sufficientEvidenceForPreference: sufficient,
    intervalsOverlap: overlap
  };
}

// ============================================================================
// Tactical correctness suite
// ============================================================================

/**
 * Runs the tactical suite for one policy. A case counts toward the pass-rate denominator only
 * when its `evidenceClass` is rule/constructed-proven AND it defines an expectation. Cases
 * classified `multiple_valid_choices` or `no_established_answer` are reported as informational
 * and are never counted as failures.
 */
export function runTacticalSuite(
  policy: RolloutPolicy,
  cases: readonly TacticalCase[],
  options?: { readonly seed?: number | string }
): TacticalSuiteResult {
  const results: TacticalCaseResult[] = [];
  let provenTotal = 0;
  let provenPassed = 0;

  for (const [index, testCase] of cases.entries()) {
    const { concrete, selfId } = testCase.position;
    const legalActions = getLegalActions(concrete, selfId);
    const isProven =
      testCase.evidenceClass === "rule_proven" ||
      testCase.evidenceClass === "constructed_scenario_proven";
    const countsTowardDenominator = isProven && testCase.expected !== undefined;

    if (legalActions.length === 0) {
      if (countsTowardDenominator) provenTotal += 1;
      results.push({
        caseId: testCase.caseId,
        category: testCase.category,
        evidenceClass: testCase.evidenceClass,
        description: testCase.description,
        outcome: countsTowardDenominator ? "fail" : "informational",
        selectedAction: "none",
        rationale: testCase.rationale,
        notes: "No legal actions were available for this actor in this position."
      });
      continue;
    }

    const rng = createSeededRng(
      deriveTrialSeed(options?.seed ?? "stage-3.5-tactical", index, "tactical")
    );
    const selected = policy.selectAction(concrete, selfId, legalActions, rng, {
      stepIndex: 0,
      bankTradesThisTurn: 0
    });

    const legal = isActionLegal(concrete, selfId, selected);
    let outcome: TacticalOutcome = "informational";
    let notes: string | undefined;

    if (countsTowardDenominator) {
      provenTotal += 1;
      if (!legal) {
        // A policy that selects an action the engine rejects always fails.
        outcome = "fail";
        notes = `Policy selected an action that isActionLegal rejects: ${describeAction(selected)}.`;
      } else if (testCase.expected!(concrete, selfId, legalActions, selected)) {
        outcome = "pass";
        provenPassed += 1;
      } else {
        outcome = "fail";
      }
    }

    results.push({
      caseId: testCase.caseId,
      category: testCase.category,
      evidenceClass: testCase.evidenceClass,
      description: testCase.description,
      outcome,
      selectedAction: describeAction(selected),
      rationale: testCase.rationale,
      ...(notes !== undefined ? { notes } : {})
    });
  }

  return {
    policyId: policy.id,
    provenCasesTotal: provenTotal,
    provenCasesPassed: provenPassed,
    provenPassRate: provenTotal > 0 ? provenPassed / provenTotal : null,
    wilson95: computeWilson95Interval(provenPassed, provenTotal),
    failures: results.filter((r) => r.outcome === "fail"),
    results
  };
}


// ============================================================================
// Controlled policy comparison (matched trials)
// ============================================================================

export interface PolicyComparisonOptions {
  readonly numTrials: number;
  readonly baseSeed: number | string;
  readonly determinizationOptions?: DeterminizationOptions;
  /** Max turns per rollout. Kept modest so the offline suite stays fast. */
  readonly maxTurnsPerRollout?: number;
  readonly maxActionsPerRollout?: number;
  /** Validate concrete invariants at every rollout step (slower but stricter). */
  readonly validateEveryStep?: boolean;
}

function resolveDeterminizationOptions(
  observed: ObservedGameState,
  override?: DeterminizationOptions
): DeterminizationOptions {
  return {
    ...(override ?? {}),
    // Never silently substitute dice: only supply a fallback when the mode is genuinely unknown,
    // mirroring the shadow evaluator's explicit-approximation requirement.
    ...(observed.rules.diceMode.mode === "unknown" ? { diceModeOverride: "balanced" as const } : {})
  };
}

/**
 * Runs one policy on one observed position with `numTrials` determinized rollouts.
 *
 * Trial `i` uses `deriveTrialSeed(baseSeed, i)`, so the SAME `baseSeed` across policies yields
 * the same initial determinized world for trial `i` (Common Random Numbers). Continuation streams
 * are seeded identically but are only truly paired while policies consume the same stochastic
 * domains in the same order — divergent actions legitimately change dice, theft and dev-draw
 * positions. That limitation is reported, never hidden.
 */
export function evaluatePolicyOnPosition(
  position: BenchmarkPosition,
  policy: RolloutPolicy,
  options: PolicyComparisonOptions
): PolicyPositionResult {
  const start = nowMs();
  const detOptions = resolveDeterminizationOptions(position.observed, options.determinizationOptions);

  const summary = runDeterminizedRollouts(position.observed, {
    numTrials: options.numTrials,
    baseSeed: options.baseSeed,
    determinizationOptions: detOptions,
    rolloutOptions: {
      policy,
      maxTurns: options.maxTurnsPerRollout ?? 120,
      maxActions: options.maxActionsPerRollout ?? 600,
      validateEveryStep: options.validateEveryStep ?? false,
      separateDomainStreams: true
    }
  });

  const selfId = position.selfId;
  const wins = summary.winsByPlayerId[selfId] ?? 0;
  const completed = summary.completedCount;
  let draws = 0;
  let losses = 0;
  let totalSimulatedTurns = 0;
  let totalSimulatedActions = 0;
  const completedTurnsList: number[] = [];
  const completedActionsList: number[] = [];
  const trialOutcomes: PolicyTrialOutcome[] = [];
  const terminationReasons: Record<string, number> = {};

  for (const trial of summary.trials) {
    terminationReasons[trial.rolloutStatus] = (terminationReasons[trial.rolloutStatus] ?? 0) + 1;
    totalSimulatedTurns += trial.turnsSimulated;
    totalSimulatedActions += trial.actionsSimulated;
    if (trial.completed) {
      completedTurnsList.push(trial.turnsSimulated);
      completedActionsList.push(trial.actionsSimulated);
      if (trial.winnerId === undefined) {
        draws += 1;
        trialOutcomes.push({ trialIndex: trial.trialIndex, completed: true, outcome: "draw" });
      } else if (trial.winnerId !== selfId) {
        losses += 1;
        trialOutcomes.push({ trialIndex: trial.trialIndex, completed: true, outcome: "loss" });
      } else {
        trialOutcomes.push({ trialIndex: trial.trialIndex, completed: true, outcome: "win" });
      }
    } else {
      trialOutcomes.push({ trialIndex: trial.trialIndex, completed: false, outcome: "incomplete" });
    }
  }

  return {
    policyId: policy.id,
    positionId: position.positionId,
    groupId: position.groupId,
    selfId,
    winRateAmongCompleted: completed > 0 ? wins / completed : null,
    wilson95: computeWilson95Interval(wins, completed),
    completionRate: summary.numTrials > 0 ? completed / summary.numTrials : null,
    accounting: {
      completed,
      wins,
      losses,
      draws,
      cutoffMaxTurns: summary.maxTurnsCutoffCount,
      cutoffMaxActions: summary.maxActionsCutoffCount,
      terminationReasons,
      failed: summary.failedRolloutCount,
      determinizationFailed: summary.determinizationFailureCount,
      totalSimulatedTurns,
      totalSimulatedActions,
      sampleCount: summary.numTrials
    },
    trialOutcomes,
    medianTurnsAmongCompleted: median(completedTurnsList),
    medianActionsAmongCompleted: median(completedActionsList),
    elapsedMs: nowMs() - start,
    baseSeed: String(options.baseSeed)
  };
}


/**
 * Compares two policies on the same position using ONLY trial indices where BOTH policies
 * completed, then applies the Stage 3.4 exact two-tailed McNemar binomial test on discordant pairs.
 *
 * A non-significant result is reported as `no_clear_difference`, never as equivalence: absence of
 * evidence of a difference is not evidence of absence.
 */
export function comparePoliciesPaired(
  a: PolicyPositionResult,
  b: PolicyPositionResult,
  options?: { readonly significanceAlpha?: number; readonly minPairedTrials?: number }
): PairedPolicyComparison {
  const alpha = options?.significanceAlpha ?? 0.05;
  const minPaired = options?.minPairedTrials ?? 10;

  const byTrialB = new Map(b.trialOutcomes.map((t) => [t.trialIndex, t]));
  let paired = 0;
  let aWonBLost = 0;
  let bWonALost = 0;
  let bothWon = 0;
  let bothLost = 0;
  let bothDrew = 0;

  for (const ta of a.trialOutcomes) {
    if (!ta.completed) continue;
    const tb = byTrialB.get(ta.trialIndex);
    if (!tb || !tb.completed) continue;
    paired += 1;
    const aWin = ta.outcome === "win";
    const bWin = tb.outcome === "win";
    const aDraw = ta.outcome === "draw";
    const bDraw = tb.outcome === "draw";
    if (aWin && bWin) bothWon += 1;
    else if (aDraw && bDraw) bothDrew += 1;
    else if (!aWin && !aDraw && !bWin && !bDraw) bothLost += 1;
    else if (aWin && !bWin) aWonBLost += 1;
    else if (bWin && !aWin) bWonALost += 1;
  }

  if (paired < minPaired) {
    return {
      policyAId: a.policyId,
      policyBId: b.policyId,
      positionId: a.positionId,
      pairedCompletedTrials: paired,
      aWonBLost,
      bWonALost,
      bothWon,
      bothLost,
      bothDrew,
      pairedWinRateDelta: null,
      mcnemarPValue: null,
      significanceAlpha: alpha,
      classification: "insufficient_data",
      explanation:
        `Only ${paired} trial(s) completed under both policies; at least ${minPaired} paired ` +
        `completed trials are required before a difference test is attempted.`
    };
  }

  const discordant = aWonBLost + bWonALost;
  const aWins = aWonBLost + bothWon;
  const bWins = bWonALost + bothWon;
  const delta = (aWins - bWins) / paired;
  const pValue = discordant > 0 ? computeExactTwoTailedBinomialPValue(discordant, aWonBLost) : 1;
  const significant = pValue !== null && pValue < alpha;

  let classification: PairedPolicyComparison["classification"];
  let explanation: string;
  if (discordant === 0) {
    classification = "no_clear_difference";
    explanation =
      "No discordant pairs: on every paired completed trial both policies reached the same outcome class.";
  } else if (significant && delta > 0) {
    classification = "evidence_favors_A";
    explanation =
      `Exact two-tailed McNemar p=${pValue!.toFixed(4)} < alpha=${alpha} on ${discordant} discordant ` +
      `pair(s), favouring ${a.policyId}. Evidence of a difference on these matched worlds, ` +
      `not proof of superiority in general.`;
  } else if (significant && delta < 0) {
    classification = "evidence_favors_B";
    explanation =
      `Exact two-tailed McNemar p=${pValue!.toFixed(4)} < alpha=${alpha} on ${discordant} discordant ` +
      `pair(s), favouring ${b.policyId}. Evidence of a difference on these matched worlds, ` +
      `not proof of superiority in general.`;
  } else {
    classification = "no_clear_difference";
    explanation =
      `Exact two-tailed McNemar p=${pValue === null ? "n/a" : pValue.toFixed(4)} >= alpha=${alpha} on ` +
      `${discordant} discordant pair(s). No clear difference detected; this is NOT a demonstration ` +
      `of equivalence, which would require a pre-specified equivalence margin.`;
  }

  return {
    policyAId: a.policyId,
    policyBId: b.policyId,
    positionId: a.positionId,
    pairedCompletedTrials: paired,
    aWonBLost,
    bWonALost,
    bothWon,
    bothLost,
    bothDrew,
    pairedWinRateDelta: delta,
    mcnemarPValue: pValue,
    significanceAlpha: alpha,
    classification,
    explanation
  };
}


// ============================================================================
// Candidate-selection stability across increasing trial budgets
// ============================================================================

interface CandidateTrialSummary {
  readonly completed: number;
  readonly wins: number;
  readonly cutoff: number;
  readonly failed: number;
  readonly winRate: number | null;
  readonly wilson: WilsonConfidenceInterval | null;
}

interface RolloutFromActionResult {
  readonly completed: boolean;
  readonly status: string;
  readonly winnerId?: string;
}

/**
 * Applies one candidate action to a determinized state, then continues with the baseline policy.
 * Implemented on `applyAction` + `runRollout` so step 0 is exactly the candidate under test rather
 * than whatever a policy would have chosen.
 */
function runRolloutFromAction(options: {
  state: ConcreteSimulatedGameState;
  selfId: string;
  action: SimulatedAction;
  rng: SeededRng;
  maxTurns: number;
  maxActions: number;
}): RolloutFromActionResult {
  const applied = applyAction(options.state, options.selfId, options.action);
  if (!applied.ok) return { completed: false, status: "unsupported_action" };
  if (applied.state.phase === "game_over") {
    return {
      completed: true,
      status: "completed",
      ...(applied.state.winnerId !== undefined ? { winnerId: applied.state.winnerId } : {})
    };
  }
  const rest = runRollout(applied.state, options.rng, {
    policy: baselineRolloutPolicy,
    maxTurns: options.maxTurns,
    maxActions: options.maxActions,
    separateDomainStreams: true
  });
  return {
    completed: rest.completed,
    status: rest.status,
    ...(rest.winnerId !== undefined ? { winnerId: rest.winnerId } : {})
  };
}

/**
 * Runs `numTrials` matched trials for a single candidate action: each trial determinizes the
 * observed state with `deriveTrialSeed(baseSeed, i, "bench-determinize")`, applies the candidate
 * action as step 0, then continues with the baseline rollout policy.
 *
 * Because the determinization seed depends only on `baseSeed` and the trial index, all candidates
 * at the same budget share identical initial worlds for matching trial IDs.
 */
function runCandidateTrials(
  position: BenchmarkPosition,
  action: SimulatedAction,
  numTrials: number,
  baseSeed: number | string,
  detOptions: DeterminizationOptions,
  maxTurns: number,
  maxActions: number
): CandidateTrialSummary {
  let completed = 0;
  let wins = 0;
  let cutoff = 0;
  let failed = 0;
  const selfId = position.selfId;

  for (let i = 0; i < numTrials; i++) {
    const detSeed = deriveTrialSeed(baseSeed, i, "bench-determinize");
    const det = sampleDeterminization(position.observed, createSeededRng(detSeed), detOptions);
    if (!det.ok) {
      failed += 1;
      continue;
    }
    if (!isActionLegal(det.state, selfId, action)) {
      failed += 1;
      continue;
    }
    const contSeed = deriveTrialSeed(baseSeed, i, "bench-rollout-continuation");
    const result = runRolloutFromAction({
      state: det.state,
      selfId,
      action,
      rng: createSeededRng(contSeed),
      maxTurns,
      maxActions
    });
    if (result.completed && result.status === "completed") {
      completed += 1;
      if (result.winnerId === selfId) wins += 1;
    } else if (result.status === "max_turns_reached" || result.status === "max_actions_reached") {
      cutoff += 1;
    } else {
      failed += 1;
    }
  }

  return {
    completed,
    wins,
    cutoff,
    failed,
    winRate: completed > 0 ? wins / completed : null,
    wilson: computeWilson95Interval(wins, completed)
  };
}


/**
 * Measures how stable candidate selection is as the trial budget grows.
 *
 * For each budget, every candidate is evaluated with the SAME `baseSeed`, so trial `i` starts from
 * the same determinized world for all candidates. Reports the selected candidate, its Wilson
 * interval, whether the top two intervals overlap, and the completed/cutoff/failed counts.
 */
export function measureCandidateBudgetStability(options: {
  position: BenchmarkPosition;
  candidates: readonly CandidateForStability[];
  budgets: readonly number[];
  baseSeed: number | string;
  determinizationOptions?: DeterminizationOptions;
  maxTurnsPerRollout?: number;
  maxActionsPerRollout?: number;
  /** Minimum completed trials before a candidate may be declared the selection. */
  minCompletedForSelection?: number;
}): BudgetStabilityResult {
  const rows: BudgetSweepRow[] = [];
  const minCompleted = options.minCompletedForSelection ?? 5;
  const detOptions = resolveDeterminizationOptions(
    options.position.observed,
    options.determinizationOptions
  );
  const maxTurns = options.maxTurnsPerRollout ?? 120;
  const maxActions = options.maxActionsPerRollout ?? 600;

  for (const budget of options.budgets) {
    const start = nowMs();
    const perCandidate = options.candidates.map((candidate) => ({
      candidate,
      summary: runCandidateTrials(
        options.position,
        candidate.action,
        budget,
        options.baseSeed,
        detOptions,
        maxTurns,
        maxActions
      )
    }));

    // Rank by empirical win rate among completed trials. Candidates with too few completed trials
    // are still reported but are not eligible to be declared the selection.
    const rankable = perCandidate
      .filter((c) => c.summary.completed >= minCompleted)
      .sort((a, b) => (b.summary.winRate ?? -1) - (a.summary.winRate ?? -1));
    const top = rankable[0];
    const runnerUp = rankable[1];
    const confidence = top
      ? assessCandidateConfidence(top.summary, runnerUp?.summary, minCompleted)
      : {
          status: "inconclusive" as const,
          sufficientEvidenceForPreference: false,
          intervalsOverlap: null
        };
    const totalCompleted = perCandidate.reduce((s, c) => s + c.summary.completed, 0);
    const totalCutoff = perCandidate.reduce((s, c) => s + c.summary.cutoff, 0);
    const totalFailed = perCandidate.reduce((s, c) => s + c.summary.failed, 0);

    rows.push({
      trialsPerCandidate: budget,
      selectedCandidateId: top?.candidate.candidateId ?? null,
      selectedWinRate: top?.summary.winRate ?? null,
      selectedWilson95: top?.summary.wilson ?? null,
      runnerUpCandidateId: runnerUp?.candidate.candidateId ?? null,
      runnerUpWinRate: runnerUp?.summary.winRate ?? null,
      runnerUpWilson95: runnerUp?.summary.wilson ?? null,
      topTwoIntervalsOverlap: confidence.intervalsOverlap,
      confidenceStatus: confidence.status,
      sufficientEvidenceForPreference: confidence.sufficientEvidenceForPreference,
      candidatesEvaluated: options.candidates.length,
      completed: totalCompleted,
      cutoff: totalCutoff,
      failed: totalFailed,
      completionRate:
        perCandidate.length > 0 && budget > 0 ? totalCompleted / (perCandidate.length * budget) : null,
      elapsedMs: nowMs() - start
    });
  }

  let selectionChanges = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].selectedCandidateId !== rows[i - 1].selectedCandidateId) selectionChanges += 1;
  }
  const overlapFlags = rows
    .map((r) => r.topTwoIntervalsOverlap)
    .filter((v): v is boolean => v !== null);
  const overlappingFraction =
    overlapFlags.length > 0 ? overlapFlags.filter((v) => v).length / overlapFlags.length : null;

  const interpretation =
    selectionChanges === 0
      ? "The selected candidate was identical at every budget tested. This is stability of the " +
        "ranking on these matched worlds, not proof that the selection is correct."
      : `The selected candidate changed at ${selectionChanges} of ${Math.max(0, rows.length - 1)} ` +
        `budget step(s). Selection is not stable across the budgets tested, so no winner should ` +
        `be declared from this position alone.`;

  return {
    positionId: options.position.positionId,
    groupId: options.position.groupId,
    rows,
    selectionChangesAcrossBudgets: selectionChanges,
    overlappingTopTwoFraction: overlappingFraction,
    interpretation
  };
}
