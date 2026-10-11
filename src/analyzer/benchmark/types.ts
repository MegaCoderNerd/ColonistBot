/**
 * Stage 3.5 — Type definitions for the offline policy-evaluation harness.
 *
 * ADDITIVE / EVALUATION ONLY. These types are consumed exclusively by the Stage 3.5 benchmark
 * harness and its tests. Production recommendation code does not import them.
 */

import type { ResourceHand } from "../types";
import type { ConcreteSimulatedGameState, ObservedGameState } from "../engine/state";
import type { SimulatedAction } from "../engine/transition";
import type { WilsonConfidenceInterval } from "../engine/shadow";

// ============================================================================
// 1. Position corpus types
// ============================================================================

/**
 * Situation classes required by the Stage 3.5 brief. A position may carry several labels;
 * `primaryStratum` is the single bucket used for stratified reporting.
 */
export type BenchmarkStratum =
  | "opening_expansion"
  | "midgame_resource_imbalance"
  | "city_dev_opportunity"
  | "road_settlement_placement"
  | "longest_road_largest_army"
  | "robber_discard"
  | "immediate_win_or_urgent_defense"
  | "other";

export type BenchmarkPositionSource = "recording" | "synthetic";

/** Tactical features recorded for every benchmark position, all from legal public information. */
export interface BenchmarkPositionFeatures {
  readonly phase: string;
  readonly completedTurns: number;
  readonly selfVisibleVp: number;
  readonly bestOpponentVisibleVp: number;
  readonly visibleVpGap: number;
  readonly selfHandTotal: number;
  readonly selfHand: ResourceHand;
  readonly legalCityCorners: number;
  readonly legalSettlementCorners: number;
  readonly legalRoadEdges: number;
  readonly hasImmediateWinningAction: boolean;
  readonly robberOnSelfProduction: boolean;
  readonly selfRoadLength: number;
  readonly bestOpponentRoadLength: number;
  readonly selfKnightsPlayed: number;
  readonly bestOpponentKnightsPlayed: number;
  readonly pendingDiscardCount: number;
  readonly legalActionCount: number;
  readonly bankTradeCount: number;
}

export interface BenchmarkPosition {
  readonly positionId: string;
  /** Grouping key: recording ID, or `synthetic:<caseId>`. Groups are never split. */
  readonly groupId: string;
  readonly source: BenchmarkPositionSource;
  readonly recordingId?: string;
  readonly frameIndex?: number;
  readonly primaryStratum: BenchmarkStratum;
  readonly strata: readonly BenchmarkStratum[];
  readonly selfId: string;
  readonly features: BenchmarkPositionFeatures;
  /** Concrete, fully-determined state for tactical tests (no sampling required). */
  readonly concrete: ConcreteSimulatedGameState;
  /** Observed state, retained so candidate comparison can run matched determinizations. */
  readonly observed: ObservedGameState;
}

// ============================================================================
// 2. Tactical correctness types
// ============================================================================

/**
 * Epistemic status of a tactical expectation. Required by the brief: a move is never labelled
 * optimal merely because it looks sensible or won one recorded game.
 */
export type TacticalEvidenceClass =
  /** Established by game rules: any other answer is provably wrong. */
  | "rule_proven"
  /** Established by a carefully constructed scenario where the rules force the answer. */
  | "constructed_scenario_proven"
  /** Corroborated by recorded evidence, but not rule-forced. */
  | "recorded_evidence"
  /** Multiple valid choices; no single correct answer exists. */
  | "multiple_valid_choices"
  /** No established correct answer for this position. */
  | "no_established_answer";

export type TacticalCaseCategory =
  | "immediate_win"
  | "illegal_or_impossible"
  | "resource_dev_constraint"
  | "robber_discard_turn_supply"
  | "state_invariant"
  | "immediate_threat_defense"
  | "strategic_preference";

export interface TacticalCase {
  readonly caseId: string;
  readonly category: TacticalCaseCategory;
  readonly description: string;
  readonly evidenceClass: TacticalEvidenceClass;
  /** Why the expectation holds, or why it is only a preference. */
  readonly rationale: string;
  readonly position: BenchmarkPosition;
  /**
   * Expected-action predicate, receiving the action the policy actually selected so a case can
   * assert on it directly. Undefined for `multiple_valid_choices` /
   * `no_established_answer` cases, which are then reported as informational and never as failures.
   */
  readonly expected?: (
    state: ConcreteSimulatedGameState,
    actorId: string,
    legalActions: readonly SimulatedAction[],
    selected: SimulatedAction
  ) => boolean;
}

export type TacticalOutcome = "pass" | "fail" | "informational";

export interface TacticalCaseResult {
  readonly caseId: string;
  readonly category: TacticalCaseCategory;
  readonly evidenceClass: TacticalEvidenceClass;
  readonly description: string;
  readonly outcome: TacticalOutcome;
  /** Serialized description of the action the policy actually selected. */
  readonly selectedAction: string;
  readonly rationale: string;
  readonly notes?: string;
}

export interface TacticalSuiteResult {
  readonly policyId: string;
  /** Pass-rate denominator: only rule/constructed-proven cases that define an expectation. */
  readonly provenCasesTotal: number;
  readonly provenCasesPassed: number;
  readonly provenPassRate: number | null;
  readonly wilson95: WilsonConfidenceInterval | null;
  readonly failures: readonly TacticalCaseResult[];
  readonly results: readonly TacticalCaseResult[];
}

// ============================================================================
// 3. Controlled policy comparison types
// ============================================================================

export interface PolicyTrialAccounting {
  readonly completed: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly cutoffMaxTurns: number;
  readonly cutoffMaxActions: number;
  /** Cutoff and failure statuses by exact rollout status, retained for diagnosis. */
  readonly terminationReasons: Readonly<Record<string, number>>;
  readonly failed: number;
  readonly determinizationFailed: number;
  /** Turns/actions summed across ALL attempted trials, including incomplete ones. */
  readonly totalSimulatedTurns: number;
  readonly totalSimulatedActions: number;
  readonly sampleCount: number;
}

export interface PolicyTrialOutcome {
  readonly trialIndex: number;
  readonly completed: boolean;
  /** "incomplete" covers cutoffs and failures; never counted as a win or a loss. */
  readonly outcome: "win" | "loss" | "draw" | "incomplete";
}

export interface PolicyPositionResult {
  readonly policyId: string;
  readonly positionId: string;
  readonly groupId: string;
  readonly selfId: string;
  /** Wins / completed only. Null when `completed === 0`. */
  readonly winRateAmongCompleted: number | null;
  readonly wilson95: WilsonConfidenceInterval | null;
  readonly completionRate: number | null;
  readonly accounting: PolicyTrialAccounting;
  /** Per-trial outcomes, retained so paired comparison can match on trial index. */
  readonly trialOutcomes: readonly PolicyTrialOutcome[];
  readonly medianTurnsAmongCompleted: number | null;
  readonly medianActionsAmongCompleted: number | null;
  readonly elapsedMs: number;
  readonly baseSeed: string;
}

export interface PairedPolicyComparison {
  readonly policyAId: string;
  readonly policyBId: string;
  readonly positionId: string;
  /** Trials where BOTH policies completed the same trial index. */
  readonly pairedCompletedTrials: number;
  readonly aWonBLost: number;
  readonly bWonALost: number;
  readonly bothWon: number;
  readonly bothLost: number;
  readonly bothDrew: number;
  /** `(aWins - bWins) / pairedCompletedTrials` over shared completed trials only. */
  readonly pairedWinRateDelta: number | null;
  readonly mcnemarPValue: number | null;
  readonly significanceAlpha: number;
  readonly classification:
    | "evidence_favors_A"
    | "evidence_favors_B"
    | "no_clear_difference"
    | "insufficient_data";
  readonly explanation: string;
}

// ============================================================================
// 4. Budget / stability sweep types
// ============================================================================

export interface BudgetSweepRow {
  readonly trialsPerCandidate: number;
  readonly selectedCandidateId: string | null;
  readonly selectedWinRate: number | null;
  readonly selectedWilson95: WilsonConfidenceInterval | null;
  readonly runnerUpCandidateId: string | null;
  readonly runnerUpWinRate: number | null;
  readonly runnerUpWilson95: WilsonConfidenceInterval | null;
  /**
   * True when the leader's and runner-up's Wilson intervals overlap.
   * NOT a claim of equivalence — overlap is reported, never interpreted as proof.
   */
  readonly topTwoIntervalsOverlap: boolean | null;
  readonly confidenceStatus: "meaningful_preference" | "low_confidence" | "inconclusive";
  readonly sufficientEvidenceForPreference: boolean;
  readonly candidatesEvaluated: number;
  readonly completed: number;
  readonly cutoff: number;
  readonly failed: number;
  readonly completionRate: number | null;
  readonly elapsedMs: number;
}

export interface BudgetStabilityResult {
  readonly positionId: string;
  readonly groupId: string;
  readonly rows: readonly BudgetSweepRow[];
  /** Number of adjacent budget steps whose selected candidate changed. */
  readonly selectionChangesAcrossBudgets: number;
  /** Fraction of adjacent steps with overlapping top-two intervals. */
  readonly overlappingTopTwoFraction: number | null;
  readonly interpretation: string;
}

export interface CandidateForStability {
  readonly candidateId: string;
  readonly label: string;
  /** Action applied as step 0 before the shared rollout policy takes over. */
  readonly action: SimulatedAction;
}
