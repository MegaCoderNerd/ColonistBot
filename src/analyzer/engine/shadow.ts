import type { RobberTarget } from "../advisor";
import type { GameSnapshot } from "../snapshot";
import type { OpeningPick, OpeningPlan } from "../strategy";
import { canPay, COSTS, type Affordability, type PlayerHandView } from "../tracker";
import { registerOpeningShadowEvaluator } from "./opening";
import {
  RESOURCES,
  type Board,
  type GameEvent,
  type Placements,
  type Resource,
  type ResourceBag,
  type ResourceHand
} from "../types";
import {
  sampleDeterminization,
  type DeterminizationErrorCode,
  type DeterminizationOptions,
  type ResourceSamplingPolicy
} from "./determinize";
import {
  resolveDiceModelForRules,
  type DiceModelDiagnostics,
  type DiceModelId,
  type DiceModelStatus
} from "./diceModel";
import { createSeededRng, deriveTrialSeed } from "./rng";
import {
  baselineRolloutPolicy,
  runRollout,
  type RolloutOptions,
  type RolloutPolicy,
  type RolloutStatus
} from "./rollout";
import {
  buildObservedGameState,
  cloneConcreteSimState,
  validateConcreteSimState,
  validateObservedState,
  type ConcreteSimulatedGameState,
  type ObservedDiceState,
  type ObservedGameState
} from "./state";
import {
  applyAction,
  getLegalActions,
  isActionLegal,
  validateSupportedVariantAndRuleset,
  type ActionOutcome,
  type SimulatedAction
} from "./transition";

// ============================================================================
// 1. Legacy Recommendation & Candidate Representations
// ============================================================================

export type LegacyTurnActionId =
  | "hold"
  | "city"
  | "cityTrade"
  | "settle"
  | "settleTrade"
  | "road"
  | "trophy"
  | "trophy2"
  | "port"
  | "buyDev"
  | "dev"
  | "knight"
  | "army"
  | "roadBuild"
  | "yop"
  | "monopoly"
  | "burst"
  | "discard"
  | "preRollDropWarning"
  | "spendDown";

export interface LegacyTurnActionCandidate {
  readonly kind: "turn_action";
  readonly candidateId: string;
  readonly actionId: LegacyTurnActionId;
  readonly label: string;
  readonly isLegacyRecommended: boolean;
  readonly legacyRank: number;
  readonly legacyScore?: number;
  readonly legacyWinPct?: number;
  readonly at?: string;
  readonly edge?: string;
  readonly secondEdge?: string;
  readonly toward?: string;
  readonly requiresTrade?: boolean;
  readonly yopResources?: readonly Resource[];
  readonly compoundWithCity?: boolean;
  readonly monopolyResource?: Resource;
  readonly compoundWithAction?: string;
  readonly discardCards?: ResourceBag;
}

export interface LegacyOpeningSettlementCandidate {
  readonly kind: "opening_settlement";
  readonly candidateId: string;
  readonly label: string;
  readonly isLegacyRecommended: boolean;
  readonly legacyRank: number;
  readonly legacyScore: number;
  readonly at: string;
  readonly followUpAt?: string;
  readonly openingMode?: OpeningPlan["mode"];
}

export interface LegacySetupRoadCandidate {
  readonly kind: "setup_road";
  readonly candidateId: string;
  readonly label: string;
  readonly isLegacyRecommended: boolean;
  readonly legacyRank: number;
  readonly legacyScore: number;
  readonly edge: string;
  readonly toward?: string;
}

export interface LegacyRobberTargetCandidate {
  readonly kind: "robber_target";
  readonly candidateId: string;
  readonly label: string;
  readonly isLegacyRecommended: boolean;
  readonly legacyRank: number;
  readonly legacyScore: number;
  readonly hexId: string;
  readonly targets: readonly string[];
}

export type LegacyRecommendationCandidate =
  | LegacyTurnActionCandidate
  | LegacyOpeningSettlementCandidate
  | LegacySetupRoadCandidate
  | LegacyRobberTargetCandidate;

export interface LegacyRecommendationSummary {
  readonly source: "planTurn" | "coachedOpening" | "robberTargets" | "custom";
  readonly headline: string;
  readonly primaryCandidateId?: string;
  readonly primaryActionId?: string;
  readonly legacyWinPct?: number;
  readonly legacyScore?: number;
}

// ============================================================================
// 2. Candidate Mapping & Support Diagnostics
// ============================================================================

export type UnsupportedCandidateCode =
  | "compound_multi_action_candidate"
  | "compound_trade_then_build"
  | "advisory_warning_not_action"
  | "ambiguous_candidate_parameters"
  | "ambiguous_robber_victim"
  | "unknown_board_coordinate"
  | "phase_mismatch"
  | "unsupported_action_type";

export type CandidateMappingResult =
  | {
      readonly supported: true;
      readonly candidate: LegacyRecommendationCandidate;
      readonly simulatedAction: SimulatedAction;
      readonly unsupportedCode?: undefined;
      readonly unsupportedReason?: undefined;
    }
  | {
      readonly supported: false;
      readonly candidate: LegacyRecommendationCandidate;
      readonly simulatedAction?: undefined;
      readonly unsupportedCode: UnsupportedCandidateCode;
      readonly unsupportedReason: string;
    };

export type ShadowSupportFailureCode =
  | "missing_board"
  | "missing_self_player"
  | "stale_or_unavailable_state"
  | "unsupported_variant"
  | "unsupported_ruleset"
  | "unsupported_phase"
  | "unsupported_dice_mode"
  | "not_self_turn"
  | "invalid_observed_state";

export interface EpistemicLayerSummary {
  readonly authoritativeFacts: {
    readonly selfPlayerId: string;
    readonly phase: ObservedGameState["phase"];
    readonly turnPlayerId?: string;
    readonly completedTurns?: number;
    readonly selfHandExact: boolean;
    readonly selfConfirmedVp: number;
    readonly bankResourcesExact: boolean;
    readonly devDeckBankRemainingConfidence: ObservedGameState["devDeck"]["bankRemainingConfidence"];
  };
  readonly inferredBoundsAndPriors: {
    readonly opponentHands: ReadonlyArray<{
      readonly playerId: string;
      readonly handSize: number;
      readonly unknownCount: number;
      readonly confidence: ObservedGameState["players"][number]["hand"]["confidence"];
      readonly inferenceSource: ObservedGameState["players"][number]["hand"]["inferenceSource"];
      readonly knownMinSum: number;
      readonly maxUnrevealedVpDevs: number;
    }>;
    readonly diceAlignmentStatus: ObservedDiceState["alignmentStatus"];
    readonly observedRollCount: number;
  };
  readonly sampledLayerPolicy: {
    readonly resourceSamplingPolicy: ResourceSamplingPolicy;
    readonly exposesSampledCardsAsFacts: false;
    readonly note: string;
  };
}

export interface ShadowDiceDiagnostics {
  readonly requestedDiceMode: ObservedGameState["rules"]["diceMode"]["mode"];
  readonly effectiveModelId: DiceModelId;
  readonly fallbackModelId?: DiceModelId;
  readonly status: DiceModelStatus;
  readonly isExact: boolean;
  readonly confidence: DiceModelDiagnostics["confidence"];
  readonly alignmentStatus: ObservedDiceState["alignmentStatus"];
  readonly alignmentUsed: boolean;
  readonly cycleRollsUsed: number;
  readonly bagRemainingInShoe: number | null;
  readonly modelsPlayerSevenStreakBalancing: boolean;
  readonly observedSevenCountsByPlayer: Readonly<Record<string, number>>;
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
}

// ============================================================================
// 3. Budget, Timing, and Per-Candidate Rollout Evaluation Types
// ============================================================================

export interface ShadowBudgetConfig {
  /** Maximum number of supported candidates to evaluate with rollouts (default: 4). */
  readonly maxCandidates?: number;
  /** Number of matched determinized rollout trials per evaluated candidate (default: 16). */
  readonly maxTrialsPerCandidate?: number;
  /** Hard cap on total rollouts across all candidates (default: 64). */
  readonly maxTotalRollouts?: number;
  /** Wall-clock time budget in milliseconds for the shadow evaluation call (default: 250). */
  readonly maxElapsedMs?: number;
  /** Hard cap on total simulated action transitions across all rollouts (default: 60000). */
  readonly maxTotalSimulatedActions?: number;
  /** Maximum turns per single rollout before `"max_turns_reached"` cutoff (default: 200). */
  readonly maxTurnsPerRollout?: number;
  /** Maximum actions per single rollout before `"max_actions_reached"` cutoff (default: 1200). */
  readonly maxActionsPerRollout?: number;
  /** Minimum completed trials required for `"sufficiently_supported"` status (default: 10). */
  readonly minCompletedTrialsForSupport?: number;
  /** Minimum completion rate (`completedGames / determinizationAttempts`) for `"sufficiently_supported"` (default: 0.75). */
  readonly minCompletionRateForSupport?: number;
  /** Optional callback checked between trials/rollouts to abort immediately if the live game state becomes stale. */
  readonly isStaleCallback?: () => boolean;
}

export interface ShadowRolloutConfig {
  /** Shadow mode is disabled (`false`) by default so production recommendations remain untouched. */
  readonly enabled?: boolean;
  /** Base seed for deterministic, reproducible paired trials (default: 20260304). */
  readonly baseSeed?: number | string;
  /** Budget limits controlling candidate count, trial count, and runtime latency. */
  readonly budget?: ShadowBudgetConfig;
  /** Determinization options (e.g. `"likely_prior"` vs `"uniform_within_bounds"`). */
  readonly determinizationOptions?: DeterminizationOptions;
  /** Optional explicit dice model selection (`"standard_fair_2d6"`, `"balanced_24_of_36_shoe_approx"`, `"balanced_stationary_marginal_approx"`). */
  readonly diceModelId?: Exclude<DiceModelId, "unsupported_dice_mode">;
  /** Must be true along with `diceModelId` if `observed.rules.diceMode.mode === "unknown"`. */
  readonly allowApproximationForUnknownDiceMode?: boolean;
  /** Rollout policy (defaults to `baselineRolloutPolicy`). */
  readonly policy?: RolloutPolicy;
  /** Whether to validate concrete state invariants at every rollout step (default: false in fast shadow mode, configurable to true). */
  readonly validateEveryStep?: boolean;
  /** Optional stale-state flags from the live extension helper. */
  readonly staleStateCheck?: {
    readonly isStale?: boolean;
    readonly behindMs?: number;
    readonly staleThresholdMs?: number;
    readonly loggedSettlementsByMe?: number;
    readonly observedBuildingsByMe?: number;
  };
  /** Optional callback invoked when a shadow evaluation report is produced. */
  readonly onReport?: (report: ShadowEvaluationReport) => void;
}

export type CandidateEvaluationStatus =
  | "sufficiently_supported"
  | "inconclusive_low_sample"
  | "inconclusive_high_cutoff_rate"
  | "inconclusive_budget_exhausted"
  | "inconclusive_stale_aborted"
  | "rejected_illegal_candidate"
  | "unsupported_candidate"
  | "skipped_budget_candidate_cap";

export interface WilsonConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
  readonly standardError: number;
}

export interface PairedComparisonSummary {
  readonly baselineCandidateId: string;
  readonly pairedCompletedTrials: number;
  readonly candidateWonBaselineLost: number;
  readonly baselineWonCandidateLost: number;
  readonly bothWon: number;
  readonly bothLost: number;
  readonly bothDrew: number;
  /** Empirical win-rate difference `(candidateWins - baselineWins) / pairedCompletedTrials` on shared completed trials. */
  readonly pairedWinRateDelta: number | null;
  readonly pairedDeltaStandardError: number | null;
  readonly classification:
    | "self_baseline"
    | "agrees_with_legacy"
    | "inconclusive_difference"
    | "experimental_disagreement";
}

export interface CandidateShadowEvaluation {
  readonly candidate: LegacyRecommendationCandidate;
  readonly mapping: CandidateMappingResult;
  readonly evaluationStatus: CandidateEvaluationStatus;
  readonly isSufficientlySupported: boolean;
  readonly statusReason: string;
  readonly determinizationAttempts: number;
  readonly determinizationSuccesses: number;
  readonly completedGames: number;
  /** Wins strictly among `completedGames` (`winnerId === selfPlayerId`). Cutoffs are never counted as wins or losses. */
  readonly wins: number;
  /** Losses strictly among `completedGames` (`winnerId !== undefined && winnerId !== selfPlayerId`). */
  readonly losses: number;
  /** Terminal game-over draws (`phase === "game_over" && winnerId === undefined`). */
  readonly draws: number;
  readonly cutoffs: {
    readonly total: number;
    readonly maxTurns: number;
    readonly maxActions: number;
    readonly budgetExhausted: number;
  };
  readonly failures: {
    readonly total: number;
    readonly determinizationFailed: number;
    readonly illegalAction: number;
    readonly rolloutError: number;
  };
  /** Pure empirical win rate among completed trials (`wins / completedGames`), or `null` if `completedGames === 0`. */
  readonly empiricalWinRateAmongCompleted: number | null;
  /** Fraction of attempted determinizations that reached a completed game (`completedGames / determinizationAttempts`). */
  readonly completionRate: number;
  readonly wilson95Interval: WilsonConfidenceInterval | null;
  /**
   * Separate non-empirical diagnostic metric: average simulated VP margin `(selfActualVp - bestOppActualVp)`
   * at cutoff across incomplete cutoff trials only. Never blended into `wins` or `empiricalWinRateAmongCompleted`.
   */
  readonly cutoffVpMarginEstimate: number | null;
  readonly medianTurnsAmongCompleted: number | null;
  readonly medianActionsAmongCompleted: number | null;
  readonly totalSimulatedActions: number;
  readonly elapsedMs: number;
  readonly comparisonVsLegacyTop?: PairedComparisonSummary;
}

export interface ShadowTimingBreakdown {
  readonly totalElapsedMs: number;
  readonly stateReconstructionMs: number;
  readonly candidateMappingMs: number;
  readonly determinizationMs: number;
  readonly rolloutExecutionMs: number;
  readonly aggregationMs: number;
}

export interface ShadowBudgetDiagnostics {
  readonly configured: Required<Omit<ShadowBudgetConfig, "isStaleCallback">>;
  readonly candidatesSubmitted: number;
  readonly candidatesSupported: number;
  readonly candidatesEvaluated: number;
  readonly candidatesSkippedByCap: number;
  readonly determinizationsAttempted: number;
  readonly determinizationsSucceeded: number;
  readonly totalRolloutsExecuted: number;
  readonly totalSimulatedActions: number;
  readonly stoppedByElapsedBudget: boolean;
  readonly stoppedByRolloutCap: boolean;
  readonly stoppedByActionCap: boolean;
  readonly stoppedByStaleCallback: boolean;
}

export type ShadowReportStatus =
  | "evaluated"
  | "inconclusive"
  | "unsupported_state_or_rules"
  | "stale_or_unavailable_state";

export interface ShadowEvaluationReport {
  readonly mode: "shadow_only";
  readonly status: ShadowReportStatus;
  /** Always true in Stage 3.4: shadow mode never alters the displayed recommendation. */
  readonly fallbackToLegacyRecommendation: true;
  readonly statusCode?: ShadowSupportFailureCode;
  readonly statusMessage: string;
  readonly baseSeed: number | string;
  readonly policyId: string;
  readonly legacyRecommendation: LegacyRecommendationSummary;
  readonly epistemicLayers?: EpistemicLayerSummary;
  readonly diceDiagnostics?: ShadowDiceDiagnostics;
  readonly candidateEvaluations: readonly CandidateShadowEvaluation[];
  readonly experimentalTopCandidateId?: string;
  readonly experimentalAgreesWithLegacy: boolean | null;
  readonly budgetDiagnostics: ShadowBudgetDiagnostics;
  readonly timing: ShadowTimingBreakdown;
  readonly warnings: readonly string[];
  readonly knownLimitations: readonly string[];
}

// ============================================================================
// 4. Input & State Reconstruction Adapter
// ============================================================================

export interface ShadowStateInput {
  readonly board?: Board;
  readonly placements: Placements;
  readonly me?: string;
  readonly snapshot?: GameSnapshot;
  readonly events?: GameEvent[];
  readonly hand?: ResourceHand;
  readonly handKnown?: boolean;
  readonly oppHand?: ResourceHand;
  readonly oppUnknown?: number;
  readonly oppHandView?: PlayerHandView;
  readonly handViewsByPlayer?: Record<string, PlayerHandView>;
  readonly friendlyRobberBelow?: number;
  readonly observedStateOverride?: ObservedGameState;
}

export type ShadowStateReconstructionResult =
  | {
      readonly ok: true;
      readonly observed: ObservedGameState;
      readonly epistemicLayers: EpistemicLayerSummary;
      readonly errorCode?: undefined;
      readonly errorMessage?: undefined;
    }
  | {
      readonly ok: false;
      readonly observed?: undefined;
      readonly epistemicLayers?: undefined;
      readonly errorCode: ShadowSupportFailureCode;
      readonly errorMessage: string;
    };

const DEFAULT_BUDGET: Required<Omit<ShadowBudgetConfig, "isStaleCallback">> = {
  maxCandidates: 4,
  maxTrialsPerCandidate: 16,
  maxTotalRollouts: 64,
  maxElapsedMs: 250,
  maxTotalSimulatedActions: 60000,
  maxTurnsPerRollout: 200,
  maxActionsPerRollout: 1200,
  minCompletedTrialsForSupport: 10,
  minCompletionRateForSupport: 0.75
};

const KNOWN_ROLLOUT_AND_MODEL_LIMITATIONS: readonly string[] = [
  "Rollout evaluations use baselineRolloutPolicy ('baseline_heuristic_v1') and do not predict how real human opponents will play or trade.",
  "Balanced Dice models ('balanced_24_of_36_shoe_approx' and 'balanced_stationary_marginal_approx') are provisional empirical approximations (isExact: false), not exact reproductions of proprietary Colonist server code.",
  "Colonist 1v1 per-player seven-streak / relative seven-distribution balancing is not modeled; 7 probabilities depend only on aggregate roll history.",
  "Domestic player-to-player trades are disabled during baseline rollouts; only legal maritime/bank trades are simulated."
];

const sumHand = (h: ResourceHand): number => RESOURCES.reduce((s, r) => s + h[r], 0);

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function buildBoundedOppHandView(
  name: string,
  knownMin: ResourceHand,
  unknownCount: number
): PlayerHandView {
  const safeMin: ResourceHand = {
    lumber: Math.max(0, Math.trunc(knownMin.lumber ?? 0)),
    brick: Math.max(0, Math.trunc(knownMin.brick ?? 0)),
    wool: Math.max(0, Math.trunc(knownMin.wool ?? 0)),
    grain: Math.max(0, Math.trunc(knownMin.grain ?? 0)),
    ore: Math.max(0, Math.trunc(knownMin.ore ?? 0))
  };
  const safeUnknown = Math.max(0, Math.trunc(unknownCount));
  const total = sumHand(safeMin) + safeUnknown;
  const affordFor = (cost: ResourceBag): Affordability => canPay(safeMin, safeUnknown, cost);
  return {
    name,
    hand: safeMin,
    unknown: safeUnknown,
    total,
    delta: 0,
    synced: true,
    exact: false,
    devBought: 0,
    devPlayed: 0,
    devUnplayed: 0,
    knights: 0,
    afford: {
      road: affordFor(COSTS.road),
      settlement: affordFor(COSTS.settlement),
      city: affordFor(COSTS.city),
      dev: affordFor(COSTS.dev)
    },
    discardOnSeven: total > 9 ? Math.floor(total / 2) : 0,
    stealOdds: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
    warnings: []
  };
}

/**
 * Reconstructs a canonical `ObservedGameState` from the current live analysis inputs
 * while strictly separating authoritative facts, inferred bounds/priors, and sampled rollout policy.
 */
export function reconstructObservedStateForShadow(
  input: ShadowStateInput,
  config?: ShadowRolloutConfig
): ShadowStateReconstructionResult {
  const staleCheck = config?.staleStateCheck;
  if (staleCheck) {
    if (staleCheck.isStale === true) {
      return {
        ok: false,
        errorCode: "stale_or_unavailable_state",
        errorMessage: "Live game state is marked stale; skipping rollout evaluation and preserving existing recommendation."
      };
    }
    const threshold = staleCheck.staleThresholdMs ?? 3000;
    if (
      staleCheck.behindMs !== undefined &&
      staleCheck.behindMs > threshold &&
      (staleCheck.loggedSettlementsByMe ?? 0) > (staleCheck.observedBuildingsByMe ?? 0)
    ) {
      return {
        ok: false,
        errorCode: "stale_or_unavailable_state",
        errorMessage: `Network placements (${staleCheck.observedBuildingsByMe ?? 0}) trail log settlements (${staleCheck.loggedSettlementsByMe ?? 0}) by ${staleCheck.behindMs}ms (> ${threshold}ms); pausing shadow rollouts on stale board state.`
      };
    }
  }

  if (config?.budget?.isStaleCallback?.() === true) {
    return {
      ok: false,
      errorCode: "stale_or_unavailable_state",
      errorMessage: "Stale-state callback triggered before state reconstruction; skipping shadow evaluation."
    };
  }

  const samplingPolicy: ResourceSamplingPolicy =
    config?.determinizationOptions?.resourceSamplingPolicy ?? "likely_prior";

  if (input.observedStateOverride) {
    const obs = input.observedStateOverride;
    if (!obs || obs.kind !== "observed") {
      return {
        ok: false,
        errorCode: "invalid_observed_state",
        errorMessage: "observedStateOverride is not a valid ObservedGameState (kind === 'observed')."
      };
    }
    const meId = input.me ?? obs.selfId;
    if (!meId || !obs.playerById[meId]) {
      return {
        ok: false,
        errorCode: "missing_self_player",
        errorMessage: `Self player '${String(meId)}' is not present in observedStateOverride.`
      };
    }
    return {
      ok: true,
      observed: obs,
      epistemicLayers: buildEpistemicLayerSummary(obs, meId, samplingPolicy)
    };
  }

  if (!input.board || !Array.isArray(input.board.hexes) || input.board.hexes.length === 0) {
    return {
      ok: false,
      errorCode: "missing_board",
      errorMessage: "Board geometry is unavailable; cannot reconstruct ObservedGameState."
    };
  }

  if (!input.me) {
    return {
      ok: false,
      errorCode: "missing_self_player",
      errorMessage: "Controlled player ID ('me') is unidentified; cannot run shadow rollout evaluation."
    };
  }

  // Only pass oppHandView if provided, or construct a bounded hand_tracker view from oppHand + oppUnknown
  // without ever claiming exactness unless authoritative.
  let oppHandView = input.oppHandView;
  if (!oppHandView && input.oppHand !== undefined) {
    const oppSnap = input.snapshot?.players.find((p) => p.id !== input.me);
    const oppUnknown =
      input.oppUnknown !== undefined
        ? input.oppUnknown
        : oppSnap?.handSize !== undefined
          ? Math.max(0, oppSnap.handSize - sumHand(input.oppHand))
          : 0;
    const totalFromInput = sumHand(input.oppHand) + oppUnknown;
    // Only apply the bounded view if its total matches the authoritative snapshot handSize (when present)
    if (oppSnap?.handSize === undefined || oppSnap.handSize === totalFromInput) {
      oppHandView = buildBoundedOppHandView(oppSnap?.id ?? "opp", input.oppHand, oppUnknown);
    }
  }

  const selfKnownExact = input.handKnown !== false && input.hand !== undefined;
  let effectiveSnapshot = input.snapshot;
  if (selfKnownExact && effectiveSnapshot && input.hand) {
    const selfSnap = effectiveSnapshot.players.find((p) => p.id === input.me);
    const inputHandSum = sumHand(input.hand);
    const handDiffersFromSnap =
      selfSnap !== undefined &&
      (selfSnap.handSize !== inputHandSum ||
        (selfSnap.hand !== undefined &&
          RESOURCES.some((r) => selfSnap.hand![r] !== input.hand![r])));
    if (handDiffersFromSnap && selfSnap) {
      let reconciledBank = effectiveSnapshot.bank;
      if (reconciledBank && selfSnap.hand) {
        const nextBank: Partial<ResourceHand> = {};
        let bankValid = true;
        for (const r of RESOURCES) {
          const bVal = reconciledBank[r];
          if (typeof bVal !== "number") {
            bankValid = false;
            break;
          }
          const adjusted = bVal + selfSnap.hand[r] - input.hand[r];
          if (adjusted < 0 || adjusted > 19) {
            bankValid = false;
            break;
          }
          nextBank[r] = adjusted;
        }
        reconciledBank = bankValid ? (nextBank as ResourceHand) : undefined;
      } else {
        reconciledBank = undefined;
      }
      effectiveSnapshot = {
        ...effectiveSnapshot,
        bank: reconciledBank,
        players: effectiveSnapshot.players.map((p) =>
          p.id === input.me
            ? { ...p, hand: { ...input.hand! }, handSize: inputHandSum }
            : p
        )
      };
    }
  }

  const observed = buildObservedGameState({
    board: input.board,
    placements: input.placements,
    snapshot: effectiveSnapshot,
    events: input.events,
    selfId: input.me,
    selfHand: selfKnownExact ? input.hand : undefined,
    selfHandKnown: selfKnownExact,
    oppHandView,
    handViewsByPlayer: input.handViewsByPlayer
  });

  if (!observed.playerById[input.me]) {
    return {
      ok: false,
      errorCode: "missing_self_player",
      errorMessage: `Controlled player '${input.me}' was not found among discovered players (${observed.playerOrder.join(", ") || "none"}).`
    };
  }

  return {
    ok: true,
    observed,
    epistemicLayers: buildEpistemicLayerSummary(observed, input.me, samplingPolicy)
  };
}

function buildEpistemicLayerSummary(
  observed: ObservedGameState,
  selfPlayerId: string,
  resourceSamplingPolicy: ResourceSamplingPolicy
): EpistemicLayerSummary {
  const selfPlayer = observed.playerById[selfPlayerId] ?? observed.players[0];
  return {
    authoritativeFacts: {
      selfPlayerId,
      phase: observed.phase,
      turnPlayerId: observed.turnPlayerId,
      completedTurns: observed.dice.completedTurns,
      selfHandExact: Boolean(selfPlayer && selfPlayer.hand.exact !== null && selfPlayer.hand.inferenceSource === "authoritative"),
      selfConfirmedVp: selfPlayer?.vp.totalConfirmedVp ?? 0,
      bankResourcesExact: observed.bank.resources !== null,
      devDeckBankRemainingConfidence: observed.devDeck.bankRemainingConfidence
    },
    inferredBoundsAndPriors: {
      opponentHands: observed.players
        .filter((p) => p.id !== selfPlayerId)
        .map((p) => ({
          playerId: p.id,
          handSize: p.hand.handSize,
          unknownCount: p.hand.unknownCount,
          confidence: p.hand.confidence,
          inferenceSource: p.hand.inferenceSource,
          knownMinSum: sumHand(p.hand.knownMin),
          maxUnrevealedVpDevs: p.vp.maxUnrevealedVpDevs
        })),
      diceAlignmentStatus: observed.dice.alignmentStatus,
      observedRollCount: observed.dice.observedRolls.length
    },
    sampledLayerPolicy: {
      resourceSamplingPolicy,
      exposesSampledCardsAsFacts: false,
      note: "Sampled opponent hands and unrevealed VP dev cards exist only inside isolated rollout trials and are never surfaced as observed facts."
    }
  };
}

// ============================================================================
// 5. Engine Support & Dice-Model Audit
// ============================================================================

export type ShadowSupportCheckResult =
  | {
      readonly supported: true;
      readonly diceDiagnostics: ShadowDiceDiagnostics;
      readonly failureCode?: undefined;
      readonly failureMessage?: undefined;
    }
  | {
      readonly supported: false;
      readonly diceDiagnostics?: ShadowDiceDiagnostics;
      readonly failureCode: ShadowSupportFailureCode;
      readonly failureMessage: string;
    };

/**
 * Verifies whether the new Stage 3 simulation engine supports the observed board topology,
 * player count, ruleset, current turn phase, active player perspective, and dice configuration.
 * Never converts an unsupported phase into `"main"` or silently substitutes standard fair dice.
 */
export function checkShadowEngineSupport(
  observed: ObservedGameState,
  me: string,
  config?: ShadowRolloutConfig
): ShadowSupportCheckResult {
  const stateVal = validateObservedState(observed);
  if (!stateVal.valid) {
    return {
      supported: false,
      failureCode: "invalid_observed_state",
      failureMessage: `ObservedGameState failed validation: ${stateVal.errors.join("; ")}`
    };
  }

  const effectiveDiceMode =
    config?.determinizationOptions?.diceModeOverride ?? observed.rules.diceMode.mode;

  const diceResolution = resolveDiceModelForRules(effectiveDiceMode, {
    modelId: config?.diceModelId,
    allowApproximationForUnknownMode: config?.allowApproximationForUnknownDiceMode
  });

  const rollHistory = observed.dice.observedRolls.map((r) => r.total);
  const distCheck = diceResolution.model.getDistribution({
    rollHistory,
    alignmentStatus: observed.dice.alignmentStatus
  });

  const observedSevenCountsByPlayer: Record<string, number> = {};
  for (const pid of observed.playerOrder) observedSevenCountsByPlayer[pid] = 0;
  for (const r of observed.dice.observedRolls) {
    if (r.total === 7 && r.player && observedSevenCountsByPlayer[r.player] !== undefined) {
      observedSevenCountsByPlayer[r.player] += 1;
    }
  }

  const diceDiagnostics: ShadowDiceDiagnostics = {
    requestedDiceMode: observed.rules.diceMode.mode,
    effectiveModelId: distCheck.diagnostics.fallbackModelId ?? distCheck.diagnostics.modelId,
    ...(distCheck.diagnostics.fallbackModelId !== undefined
      ? { fallbackModelId: distCheck.diagnostics.fallbackModelId }
      : {}),
    status: distCheck.diagnostics.status,
    isExact: distCheck.diagnostics.isExact,
    confidence: distCheck.diagnostics.confidence,
    alignmentStatus: observed.dice.alignmentStatus,
    alignmentUsed: distCheck.diagnostics.alignmentUsed,
    cycleRollsUsed: distCheck.diagnostics.cycleRollsUsed,
    bagRemainingInShoe: distCheck.diagnostics.bagRemainingInShoe,
    modelsPlayerSevenStreakBalancing: distCheck.diagnostics.modelsPlayerSevenStreakBalancing,
    observedSevenCountsByPlayer,
    assumptions: distCheck.diagnostics.assumptions,
    limitations: distCheck.diagnostics.limitations
  };

  if (!diceResolution.ok) {
    return {
      supported: false,
      diceDiagnostics,
      failureCode: "unsupported_dice_mode",
      failureMessage: diceResolution.error
    };
  }

  const variantCheck = validateSupportedVariantAndRuleset(
    observed.topology,
    observed.players.length,
    {
      victoryPointsToWin: observed.rules.victoryPointsToWin.value,
      cardDiscardLimit: observed.rules.cardDiscardLimit.value,
      friendlyRobber: observed.rules.friendlyRobber.value,
      friendlyRobberMinVisibleVp: observed.rules.friendlyRobber.minVisibleVp,
      diceMode: effectiveDiceMode === "unknown" ? "balanced" : effectiveDiceMode,
      maxPlayers: observed.rules.maxPlayers.value,
      bankResourceCap: 19,
      devDeckComposition: {
        knight: 14,
        victoryPoint: 5,
        roadBuilding: 2,
        yearOfPlenty: 2,
        monopoly: 2
      },
      ...(observed.rules.extensionSetting !== undefined
        ? { extensionSetting: observed.rules.extensionSetting }
        : {}),
      ...(observed.rules.mapSetting !== undefined ? { mapSetting: observed.rules.mapSetting } : {})
    }
  );

  if (variantCheck !== null) {
    return {
      supported: false,
      diceDiagnostics,
      failureCode:
        variantCheck.error.code === "unsupported_variant" ? "unsupported_variant" : "unsupported_ruleset",
      failureMessage: variantCheck.error.message
    };
  }

  const phase = config?.determinizationOptions?.phaseOverride ?? observed.phase;
  if (phase === "unknown" || phase === "setup_waiting" || phase === "game_over") {
    return {
      supported: false,
      diceDiagnostics,
      failureCode: "unsupported_phase",
      failureMessage: `Cannot run shadow candidate evaluation in phase '${phase}'.`
    };
  }

  const turnPlayerId = config?.determinizationOptions?.turnPlayerIdOverride ?? observed.turnPlayerId;
  const selfPlayer = observed.playerById[me];
  if (!selfPlayer) {
    return {
      supported: false,
      diceDiagnostics,
      failureCode: "missing_self_player",
      failureMessage: `Player '${me}' is not seated in ObservedGameState.`
    };
  }

  if (phase === "discard") {
    if (selfPlayer.pendingDiscardCount <= 0) {
      return {
        supported: false,
        diceDiagnostics,
        failureCode: "not_self_turn",
        failureMessage: `Phase is 'discard' but player '${me}' has pendingDiscardCount=${selfPlayer.pendingDiscardCount}.`
      };
    }
  } else if (turnPlayerId !== me) {
    return {
      supported: false,
      diceDiagnostics,
      failureCode: "not_self_turn",
      failureMessage: `Active turnPlayerId is '${String(turnPlayerId)}', not controlled player '${me}'.`
    };
  }

  return {
    supported: true,
    diceDiagnostics
  };
}

// ============================================================================
// 6. Unambiguous Legacy Candidate -> SimulatedAction Mapping
// ============================================================================

/**
 * Converts a legacy recommendation candidate into an exact `SimulatedAction` on `observed.topology`,
 * or marks it `supported: false` with an explicit `UnsupportedCandidateCode`.
 *
 * Never approximates a compound, trade-dependent, or ambiguous candidate into a different move.
 */
export function mapLegacyCandidateToSimulatedAction(
  candidate: LegacyRecommendationCandidate,
  observed: ObservedGameState,
  me: string,
  phaseOverride?: ObservedGameState["phase"]
): CandidateMappingResult {
  const phase = phaseOverride ?? observed.phase;
  const topo = observed.topology;

  switch (candidate.kind) {
    case "opening_settlement": {
      if (phase !== "setup_settlement") {
        return {
          supported: false,
          candidate,
          unsupportedCode: "phase_mismatch",
          unsupportedReason: `Opening settlement candidate requires phase 'setup_settlement', but observed phase is '${phase}'.`
        };
      }
      if (candidate.openingMode === "waiting") {
        return {
          supported: false,
          candidate,
          unsupportedCode: "phase_mismatch",
          unsupportedReason: "Opening plan mode is 'waiting' (opponent's turn to place)."
        };
      }
      const cornerIndex = topo.cornerIndexByAt.get(candidate.at);
      if (cornerIndex === undefined) {
        return {
          supported: false,
          candidate,
          unsupportedCode: "unknown_board_coordinate",
          unsupportedReason: `Corner coordinate '${candidate.at}' does not exist in BoardTopology.`
        };
      }
      return {
        supported: true,
        candidate,
        simulatedAction: { type: "placeSetupSettlement", cornerIndex }
      };
    }

    case "setup_road": {
      if (phase !== "setup_road") {
        return {
          supported: false,
          candidate,
          unsupportedCode: "phase_mismatch",
          unsupportedReason: `Setup road candidate requires phase 'setup_road', but observed phase is '${phase}'.`
        };
      }
      const edgeIndex = topo.edgeIndexByAt.get(candidate.edge);
      if (edgeIndex === undefined) {
        return {
          supported: false,
          candidate,
          unsupportedCode: "unknown_board_coordinate",
          unsupportedReason: `Edge coordinate '${candidate.edge}' does not exist in BoardTopology.`
        };
      }
      return {
        supported: true,
        candidate,
        simulatedAction: { type: "placeSetupRoad", edgeIndex }
      };
    }

    case "robber_target": {
      if (phase !== "robber_move") {
        return {
          supported: false,
          candidate,
          unsupportedCode: "phase_mismatch",
          unsupportedReason: `Robber target candidate requires phase 'robber_move', but observed phase is '${phase}'.`
        };
      }
      const hexIndex = topo.hexIndexByColonistId.get(candidate.hexId);
      if (hexIndex === undefined) {
        return {
          supported: false,
          candidate,
          unsupportedCode: "unknown_board_coordinate",
          unsupportedReason: `Hex ID '${candidate.hexId}' does not exist in BoardTopology.`
        };
      }
      const oppTargets = candidate.targets.filter((pid) => pid !== me);
      if (oppTargets.length > 1) {
        return {
          supported: false,
          candidate,
          unsupportedCode: "ambiguous_robber_victim",
          unsupportedReason: `RobberTarget on hex '${candidate.hexId}' has multiple potential victims (${oppTargets.join(", ")}) without specifying a single victimId.`
        };
      }
      const victimId = oppTargets.length === 1 ? oppTargets[0] : null;
      return {
        supported: true,
        candidate,
        simulatedAction: { type: "moveRobber", hexIndex, victimId }
      };
    }

    case "turn_action": {
      switch (candidate.actionId) {
        case "burst":
          return {
            supported: false,
            candidate,
            unsupportedCode: "compound_multi_action_candidate",
            unsupportedReason:
              "Candidate 'burst' recommends building both a settlement and a city in one turn; cannot be mapped to a single atomic SimulatedAction."
          };

        case "cityTrade":
        case "settleTrade":
          return {
            supported: false,
            candidate,
            unsupportedCode: "compound_trade_then_build",
            unsupportedReason: `Candidate '${candidate.actionId}' requires one or more unspecified bank trades before building; cannot be mapped to a single atomic SimulatedAction.`
          };

        case "trophy2":
          return {
            supported: false,
            candidate,
            unsupportedCode: "compound_multi_action_candidate",
            unsupportedReason:
              "Candidate 'trophy2' recommends a two-road sequence to claim Longest Road; cannot be mapped to a single atomic SimulatedAction."
          };

        case "preRollDropWarning":
          return {
            supported: false,
            candidate,
            unsupportedCode: "advisory_warning_not_action",
            unsupportedReason:
              "Pre-roll drop advice warns which cards to discard if a 7 is rolled; it is not an executable pre-roll game action."
          };

        case "spendDown":
          return {
            supported: false,
            candidate,
            unsupportedCode: "compound_multi_action_candidate",
            unsupportedReason:
              "Spend-down advice combines optional bank trades and builds into prose and cannot be mapped to a single atomic SimulatedAction."
          };

        case "city": {
          if (phase !== "main") {
            return {
              supported: false,
              candidate,
              unsupportedCode: "phase_mismatch",
              unsupportedReason: `Action 'city' requires phase 'main', but observed phase is '${phase}'.`
            };
          }
          if (!candidate.at) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "ambiguous_candidate_parameters",
              unsupportedReason: "Candidate 'city' is missing target corner coordinate 'at'."
            };
          }
          const cornerIndex = topo.cornerIndexByAt.get(candidate.at);
          if (cornerIndex === undefined) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "unknown_board_coordinate",
              unsupportedReason: `City corner coordinate '${candidate.at}' does not exist in BoardTopology.`
            };
          }
          return {
            supported: true,
            candidate,
            simulatedAction: { type: "buildCity", cornerIndex }
          };
        }

        case "settle": {
          if (phase !== "main") {
            return {
              supported: false,
              candidate,
              unsupportedCode: "phase_mismatch",
              unsupportedReason: `Action 'settle' requires phase 'main', but observed phase is '${phase}'.`
            };
          }
          if (!candidate.at) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "ambiguous_candidate_parameters",
              unsupportedReason: "Candidate 'settle' is missing target corner coordinate 'at'."
            };
          }
          const cornerIndex = topo.cornerIndexByAt.get(candidate.at);
          if (cornerIndex === undefined) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "unknown_board_coordinate",
              unsupportedReason: `Settlement corner coordinate '${candidate.at}' does not exist in BoardTopology.`
            };
          }
          return {
            supported: true,
            candidate,
            simulatedAction: { type: "buildSettlement", cornerIndex }
          };
        }

        case "road":
        case "trophy":
        case "port": {
          if (candidate.requiresTrade) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "compound_trade_then_build",
              unsupportedReason: `Road candidate '${candidate.actionId}' requires a preceding bank trade before building the road.`
            };
          }
          if (phase !== "main") {
            return {
              supported: false,
              candidate,
              unsupportedCode: "phase_mismatch",
              unsupportedReason: `Action '${candidate.actionId}' requires phase 'main', but observed phase is '${phase}'.`
            };
          }
          if (!candidate.edge) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "ambiguous_candidate_parameters",
              unsupportedReason: `Candidate '${candidate.actionId}' is missing target edge coordinate 'edge'.`
            };
          }
          const edgeIndex = topo.edgeIndexByAt.get(candidate.edge);
          if (edgeIndex === undefined) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "unknown_board_coordinate",
              unsupportedReason: `Road edge coordinate '${candidate.edge}' does not exist in BoardTopology.`
            };
          }
          return {
            supported: true,
            candidate,
            simulatedAction: { type: "buildRoad", edgeIndex }
          };
        }

        case "buyDev":
        case "dev": {
          if (phase !== "main") {
            return {
              supported: false,
              candidate,
              unsupportedCode: "phase_mismatch",
              unsupportedReason: `Action '${candidate.actionId}' requires phase 'main', but observed phase is '${phase}'.`
            };
          }
          return {
            supported: true,
            candidate,
            simulatedAction: { type: "buyDevCard" }
          };
        }

        case "hold": {
          if (phase === "main") {
            return {
              supported: true,
              candidate,
              simulatedAction: { type: "endTurn" }
            };
          }
          if (phase === "pre_roll") {
            return {
              supported: true,
              candidate,
              simulatedAction: { type: "rollDice" }
            };
          }
          return {
            supported: false,
            candidate,
            unsupportedCode: "phase_mismatch",
            unsupportedReason: `Action 'hold' cannot be mapped in phase '${phase}' (only 'pre_roll' -> rollDice or 'main' -> endTurn).`
          };
        }

        case "knight":
        case "army": {
          if (phase !== "pre_roll" && phase !== "main") {
            return {
              supported: false,
              candidate,
              unsupportedCode: "phase_mismatch",
              unsupportedReason: `Action '${candidate.actionId}' requires phase 'pre_roll' or 'main', but observed phase is '${phase}'.`
            };
          }
          return {
            supported: true,
            candidate,
            simulatedAction: { type: "playKnight" }
          };
        }

        case "roadBuild": {
          if (phase === "main") {
            return {
              supported: true,
              candidate,
              simulatedAction: { type: "playRoadBuilding" }
            };
          }
          if (phase === "road_building_1" || phase === "road_building_2") {
            if (!candidate.edge) {
              return {
                supported: false,
                candidate,
                unsupportedCode: "ambiguous_candidate_parameters",
                unsupportedReason: `In phase '${phase}', 'roadBuild' requires a target free-road edge.`
              };
            }
            const edgeIndex = topo.edgeIndexByAt.get(candidate.edge);
            if (edgeIndex === undefined) {
              return {
                supported: false,
                candidate,
                unsupportedCode: "unknown_board_coordinate",
                unsupportedReason: `Free-road edge '${candidate.edge}' does not exist in BoardTopology.`
              };
            }
            return {
              supported: true,
              candidate,
              simulatedAction: { type: "placeFreeRoad", edgeIndex }
            };
          }
          return {
            supported: false,
            candidate,
            unsupportedCode: "phase_mismatch",
            unsupportedReason: `Action 'roadBuild' cannot be mapped in phase '${phase}'.`
          };
        }

        case "yop": {
          if (candidate.compoundWithCity) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "compound_multi_action_candidate",
              unsupportedReason:
                "Candidate 'yop' recommends playing Year of Plenty followed by building a city; compound multi-step candidate is not a single SimulatedAction."
            };
          }
          if (phase !== "main" && phase !== "year_of_plenty") {
            return {
              supported: false,
              candidate,
              unsupportedCode: "phase_mismatch",
              unsupportedReason: `Action 'yop' requires phase 'main' or 'year_of_plenty', but observed phase is '${phase}'.`
            };
          }
          if (!candidate.yopResources || candidate.yopResources.length !== 2) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "ambiguous_candidate_parameters",
              unsupportedReason: `Action 'yop' requires exactly 2 target resources, got ${candidate.yopResources?.length ?? 0}.`
            };
          }
          return {
            supported: true,
            candidate,
            simulatedAction: {
              type: "playYearOfPlenty",
              resources: [candidate.yopResources[0], candidate.yopResources[1]]
            }
          };
        }

        case "monopoly": {
          if (candidate.compoundWithAction) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "compound_multi_action_candidate",
              unsupportedReason: `Candidate combines Monopoly with '${candidate.compoundWithAction}' in one recommendation; cannot be mapped to a single atomic SimulatedAction.`
            };
          }
          if (phase !== "main" && phase !== "monopoly") {
            return {
              supported: false,
              candidate,
              unsupportedCode: "phase_mismatch",
              unsupportedReason: `Action 'monopoly' requires phase 'main' or 'monopoly', but observed phase is '${phase}'.`
            };
          }
          if (!candidate.monopolyResource || !RESOURCES.includes(candidate.monopolyResource)) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "ambiguous_candidate_parameters",
              unsupportedReason: "Action 'monopoly' is missing a valid target resource."
            };
          }
          return {
            supported: true,
            candidate,
            simulatedAction: {
              type: "playMonopoly",
              resource: candidate.monopolyResource
            }
          };
        }

        case "discard": {
          if (phase !== "discard") {
            return {
              supported: false,
              candidate,
              unsupportedCode: "phase_mismatch",
              unsupportedReason: `Action 'discard' requires phase 'discard', but observed phase is '${phase}'.`
            };
          }
          if (!candidate.discardCards) {
            return {
              supported: false,
              candidate,
              unsupportedCode: "ambiguous_candidate_parameters",
              unsupportedReason: "Action 'discard' is missing 'discardCards'."
            };
          }
          return {
            supported: true,
            candidate,
            simulatedAction: {
              type: "discard",
              cards: { ...candidate.discardCards }
            }
          };
        }

        default:
          return {
            supported: false,
            candidate,
            unsupportedCode: "unsupported_action_type",
            unsupportedReason: `Unsupported legacy actionId '${String(candidate.actionId)}'.`
          };
      }
    }
  }
}

// ============================================================================
// 7. Statistical Helpers (Wilson 95% Interval, Median, Paired Deltas)
// ============================================================================

export function computeWilson95Interval(wins: number, completed: number): WilsonConfidenceInterval | null {
  if (completed <= 0 || wins < 0 || wins > completed) return null;
  const z = 1.959963984540054;
  const z2 = z * z;
  const p = wins / completed;
  const denom = 1 + z2 / completed;
  const center = (p + z2 / (2 * completed)) / denom;
  const halfWidth =
    (z * Math.sqrt((p * (1 - p)) / completed + z2 / (4 * completed * completed))) / denom;
  const standardError = Math.sqrt((p * (1 - p)) / completed);
  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    standardError
  };
}

function computeMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeCutoffVpMargin(state: ConcreteSimulatedGameState, selfId: string): number {
  const selfP = state.players.find((p) => p.id === selfId);
  if (!selfP) return 0;
  let bestOppVp = 0;
  for (const p of state.players) {
    if (p.id !== selfId && p.actualSimulatedVp > bestOppVp) {
      bestOppVp = p.actualSimulatedVp;
    }
  }
  return selfP.actualSimulatedVp - bestOppVp;
}

// ============================================================================
// 8. Core Shadow-Mode Candidate Evaluator (Matched Determinizations & Budgets)
// ============================================================================

interface CandidateAccumulator {
  readonly candidate: LegacyRecommendationCandidate;
  readonly mapping: CandidateMappingResult;
  readonly selectedForRollout: boolean;
  determinizationAttempts: number;
  determinizationSuccesses: number;
  completedGames: number;
  wins: number;
  losses: number;
  draws: number;
  maxTurnsCutoffs: number;
  maxActionsCutoffs: number;
  budgetCutoffs: number;
  determinizationFailures: number;
  illegalActionFailures: number;
  rolloutErrors: number;
  totalSimulatedActions: number;
  elapsedMs: number;
  readonly completedTurnsList: number[];
  readonly completedActionsList: number[];
  readonly cutoffVpMargins: number[];
  /** Trial index -> outcome ("win" | "loss" | "draw") for completed trials, used for paired comparison. */
  readonly completedOutcomeByTrial: Map<number, "win" | "loss" | "draw">;
}

/**
 * Evaluates a set of legacy recommendation candidates in shadow mode using matched determinizations
 * and reproducible trial seeds, subject to explicit runtime and rollout budgets.
 *
 * Guarantees:
 * - Never mutates `input`, `observed`, or `candidates`.
 * - Never exposes sampled opponent cards or sampled VP dev cards as observed facts.
 * - Separates completed games from cutoffs and failures.
 */
export function evaluateCandidatesShadow(
  input: ShadowStateInput,
  legacySummary: LegacyRecommendationSummary,
  candidates: readonly LegacyRecommendationCandidate[],
  config?: ShadowRolloutConfig
): ShadowEvaluationReport {
  const totalStartMs = nowMs();
  const baseSeed = config?.baseSeed ?? 20260304;
  const policy = config?.policy ?? baselineRolloutPolicy;
  const budget: Required<Omit<ShadowBudgetConfig, "isStaleCallback">> = {
    maxCandidates: config?.budget?.maxCandidates ?? DEFAULT_BUDGET.maxCandidates,
    maxTrialsPerCandidate: config?.budget?.maxTrialsPerCandidate ?? DEFAULT_BUDGET.maxTrialsPerCandidate,
    maxTotalRollouts: config?.budget?.maxTotalRollouts ?? DEFAULT_BUDGET.maxTotalRollouts,
    maxElapsedMs: config?.budget?.maxElapsedMs ?? DEFAULT_BUDGET.maxElapsedMs,
    maxTotalSimulatedActions:
      config?.budget?.maxTotalSimulatedActions ?? DEFAULT_BUDGET.maxTotalSimulatedActions,
    maxTurnsPerRollout: config?.budget?.maxTurnsPerRollout ?? DEFAULT_BUDGET.maxTurnsPerRollout,
    maxActionsPerRollout: config?.budget?.maxActionsPerRollout ?? DEFAULT_BUDGET.maxActionsPerRollout,
    minCompletedTrialsForSupport:
      config?.budget?.minCompletedTrialsForSupport ?? DEFAULT_BUDGET.minCompletedTrialsForSupport,
    minCompletionRateForSupport:
      config?.budget?.minCompletionRateForSupport ?? DEFAULT_BUDGET.minCompletionRateForSupport
  };
  const isStaleCallback = config?.budget?.isStaleCallback;

  // 1. Reconstruct ObservedGameState
  const reconStartMs = nowMs();
  const reconResult = reconstructObservedStateForShadow(input, config);
  const stateReconstructionMs = nowMs() - reconStartMs;

  if (!reconResult.ok) {
    const totalElapsedMs = nowMs() - totalStartMs;
    const report: ShadowEvaluationReport = {
      mode: "shadow_only",
      status:
        reconResult.errorCode === "stale_or_unavailable_state" ||
        reconResult.errorCode === "missing_board" ||
        reconResult.errorCode === "missing_self_player"
          ? "stale_or_unavailable_state"
          : "unsupported_state_or_rules",
      fallbackToLegacyRecommendation: true,
      statusCode: reconResult.errorCode,
      statusMessage: reconResult.errorMessage,
      baseSeed,
      policyId: policy.id,
      legacyRecommendation: { ...legacySummary },
      candidateEvaluations: [],
      experimentalAgreesWithLegacy: null,
      budgetDiagnostics: {
        configured: budget,
        candidatesSubmitted: candidates.length,
        candidatesSupported: 0,
        candidatesEvaluated: 0,
        candidatesSkippedByCap: 0,
        determinizationsAttempted: 0,
        determinizationsSucceeded: 0,
        totalRolloutsExecuted: 0,
        totalSimulatedActions: 0,
        stoppedByElapsedBudget: false,
        stoppedByRolloutCap: false,
        stoppedByActionCap: false,
        stoppedByStaleCallback: reconResult.errorCode === "stale_or_unavailable_state"
      },
      timing: {
        totalElapsedMs,
        stateReconstructionMs,
        candidateMappingMs: 0,
        determinizationMs: 0,
        rolloutExecutionMs: 0,
        aggregationMs: 0
      },
      warnings: [reconResult.errorMessage],
      knownLimitations: KNOWN_ROLLOUT_AND_MODEL_LIMITATIONS
    };
    config?.onReport?.(report);
    return report;
  }

  const observed = reconResult.observed;
  const selfPlayerId = input.me ?? observed.selfId ?? observed.playerOrder[0] ?? "c1";

  // 2. Check engine support for topology, ruleset, phase, turnPlayer, and dice mode
  const supportCheck = checkShadowEngineSupport(observed, selfPlayerId, config);
  if (!supportCheck.supported) {
    const totalElapsedMs = nowMs() - totalStartMs;
    const report: ShadowEvaluationReport = {
      mode: "shadow_only",
      status: "unsupported_state_or_rules",
      fallbackToLegacyRecommendation: true,
      statusCode: supportCheck.failureCode,
      statusMessage: supportCheck.failureMessage,
      baseSeed,
      policyId: policy.id,
      legacyRecommendation: { ...legacySummary },
      epistemicLayers: reconResult.epistemicLayers,
      ...(supportCheck.diceDiagnostics ? { diceDiagnostics: supportCheck.diceDiagnostics } : {}),
      candidateEvaluations: [],
      experimentalAgreesWithLegacy: null,
      budgetDiagnostics: {
        configured: budget,
        candidatesSubmitted: candidates.length,
        candidatesSupported: 0,
        candidatesEvaluated: 0,
        candidatesSkippedByCap: 0,
        determinizationsAttempted: 0,
        determinizationsSucceeded: 0,
        totalRolloutsExecuted: 0,
        totalSimulatedActions: 0,
        stoppedByElapsedBudget: false,
        stoppedByRolloutCap: false,
        stoppedByActionCap: false,
        stoppedByStaleCallback: false
      },
      timing: {
        totalElapsedMs,
        stateReconstructionMs,
        candidateMappingMs: 0,
        determinizationMs: 0,
        rolloutExecutionMs: 0,
        aggregationMs: 0
      },
      warnings: [supportCheck.failureMessage, ...observed.provenance.warnings],
      knownLimitations: KNOWN_ROLLOUT_AND_MODEL_LIMITATIONS
    };
    config?.onReport?.(report);
    return report;
  }

  // 3. Map legacy candidates to SimulatedActions (preserving candidate immutability)
  const mapStartMs = nowMs();
  const effectivePhase = config?.determinizationOptions?.phaseOverride ?? observed.phase;
  const mappings = candidates.map((c) =>
    mapLegacyCandidateToSimulatedAction(c, observed, selfPlayerId, effectivePhase)
  );

  // Select up to budget.maxCandidates supported candidates, prioritizing isLegacyRecommended first, then legacyRank
  const supportedIndices = mappings
    .map((m, idx) => ({ m, idx }))
    .filter((item) => item.m.supported)
    .sort((a, b) => {
      if (a.m.candidate.isLegacyRecommended !== b.m.candidate.isLegacyRecommended) {
        return a.m.candidate.isLegacyRecommended ? -1 : 1;
      }
      return a.m.candidate.legacyRank - b.m.candidate.legacyRank;
    });

  const selectedIndexSet = new Set(
    supportedIndices.slice(0, Math.max(0, budget.maxCandidates)).map((item) => item.idx)
  );
  const candidatesSkippedByCap = Math.max(0, supportedIndices.length - selectedIndexSet.size);

  const accumulators: CandidateAccumulator[] = mappings.map((mapping, idx) => ({
    candidate: mapping.candidate,
    mapping,
    selectedForRollout: mapping.supported && selectedIndexSet.has(idx),
    determinizationAttempts: 0,
    determinizationSuccesses: 0,
    completedGames: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    maxTurnsCutoffs: 0,
    maxActionsCutoffs: 0,
    budgetCutoffs: 0,
    determinizationFailures: 0,
    illegalActionFailures: 0,
    rolloutErrors: 0,
    totalSimulatedActions: 0,
    elapsedMs: 0,
    completedTurnsList: [],
    completedActionsList: [],
    cutoffVpMargins: [],
    completedOutcomeByTrial: new Map()
  }));
  const candidateMappingMs = nowMs() - mapStartMs;

  // 4. Execute Paired Determinizations and Rollouts within Budget
  let determinizationMs = 0;
  let rolloutExecutionMs = 0;
  let determinizationsAttempted = 0;
  let determinizationsSucceeded = 0;
  let totalRolloutsExecuted = 0;
  let totalSimulatedActions = 0;
  let stoppedByElapsedBudget = false;
  let stoppedByRolloutCap = false;
  let stoppedByActionCap = false;
  let stoppedByStaleCallback = false;

  const activeAccumulators = accumulators.filter((a) => a.selectedForRollout);
  const effectiveDiceMode =
    config?.determinizationOptions?.diceModeOverride ?? observed.rules.diceMode.mode;
  const diceResolution = resolveDiceModelForRules(effectiveDiceMode, {
    modelId: config?.diceModelId,
    allowApproximationForUnknownMode: config?.allowApproximationForUnknownDiceMode
  });
  const diceModel = diceResolution.model;
  const baseRollHistory = observed.dice.observedRolls.map((r) => r.total);
  const alignmentStatus = observed.dice.alignmentStatus;

  if (activeAccumulators.length > 0 && budget.maxTrialsPerCandidate > 0) {
    for (let trialIdx = 0; trialIdx < budget.maxTrialsPerCandidate; trialIdx++) {
      if (isStaleCallback?.() === true) {
        stoppedByStaleCallback = true;
        break;
      }
      if (nowMs() - totalStartMs >= budget.maxElapsedMs) {
        stoppedByElapsedBudget = true;
        break;
      }
      if (totalRolloutsExecuted >= budget.maxTotalRollouts) {
        stoppedByRolloutCap = true;
        break;
      }
      if (totalSimulatedActions >= budget.maxTotalSimulatedActions) {
        stoppedByActionCap = true;
        break;
      }

      // Derive deterministic trial seed for determinization (independent of candidate order)
      const detSeed = deriveTrialSeed(baseSeed, trialIdx, "shadow-determinize");
      const detStart = nowMs();
      const detRes = sampleDeterminization(
        observed,
        createSeededRng(detSeed),
        config?.determinizationOptions
      );
      determinizationMs += nowMs() - detStart;
      determinizationsAttempted += 1;

      if (!detRes.ok) {
        for (const acc of activeAccumulators) {
          acc.determinizationAttempts += 1;
          acc.determinizationFailures += 1;
        }
        continue;
      }

      determinizationsSucceeded += 1;
      const baseConcreteState = detRes.state;

      // Common Random Numbers for trialIdx: all candidates share the same initial step outcome RNG seed
      // and continuation rollout RNG seed on trialIdx!
      const step0Seed = deriveTrialSeed(baseSeed, trialIdx, "shadow-step0-outcome");
      const contSeed = deriveTrialSeed(baseSeed, trialIdx, "shadow-rollout-continuation");

      for (const acc of activeAccumulators) {
        if (isStaleCallback?.() === true) {
          stoppedByStaleCallback = true;
          acc.budgetCutoffs += 1;
          break;
        }
        if (nowMs() - totalStartMs >= budget.maxElapsedMs) {
          stoppedByElapsedBudget = true;
          acc.budgetCutoffs += 1;
          break;
        }
        if (totalRolloutsExecuted >= budget.maxTotalRollouts) {
          stoppedByRolloutCap = true;
          acc.budgetCutoffs += 1;
          break;
        }
        if (totalSimulatedActions >= budget.maxTotalSimulatedActions) {
          stoppedByActionCap = true;
          acc.budgetCutoffs += 1;
          break;
        }

        acc.determinizationAttempts += 1;
        acc.determinizationSuccesses += 1;

        const candStartMs = nowMs();
        const action = acc.mapping.simulatedAction!;
        const stateCopy = cloneConcreteSimState(baseConcreteState);

        // Validate candidate legality via getLegalActions / isActionLegal
        if (!isActionLegal(stateCopy, selfPlayerId, action)) {
          acc.illegalActionFailures += 1;
          acc.elapsedMs += nowMs() - candStartMs;
          continue;
        }

        // Prepare step-0 ActionOutcome if the candidate action is stochastic (rollDice or moveRobber with victim)
        const step0Rng = createSeededRng(step0Seed);
        let step0Outcome: ActionOutcome | undefined;
        const trialRollHistory = [...baseRollHistory];

        if (action.type === "rollDice") {
          const sampledRoll = diceModel.sampleOutcome(step0Rng, {
            rollHistory: trialRollHistory,
            alignmentStatus
          });
          if (!sampledRoll.ok || !sampledRoll.outcome) {
            acc.rolloutErrors += 1;
            acc.elapsedMs += nowMs() - candStartMs;
            continue;
          }
          step0Outcome = { dice: sampledRoll.outcome };
          trialRollHistory.push(sampledRoll.outcome.total);
        } else if (action.type === "moveRobber" && typeof action.victimId === "string") {
          const victim = stateCopy.players.find((p) => p.id === action.victimId);
          if (victim && sumHand(victim.hand) > 0) {
            const weights = RESOURCES.map((r) => victim.hand[r]);
            const stolenResource = RESOURCES[step0Rng.weightedIndex(weights)];
            step0Outcome = { stolenResource };
          }
        }

        const stepRes = applyAction(stateCopy, selfPlayerId, action, step0Outcome);
        if (!stepRes.ok) {
          acc.illegalActionFailures += 1;
          acc.elapsedMs += nowMs() - candStartMs;
          continue;
        }

        if (config?.validateEveryStep) {
          const stepVal = validateConcreteSimState(stepRes.state);
          if (!stepVal.valid) {
            acc.rolloutErrors += 1;
            acc.elapsedMs += nowMs() - candStartMs;
            continue;
          }
        }

        const remainingActionBudget = Math.max(
          1,
          Math.min(
            budget.maxActionsPerRollout,
            budget.maxTotalSimulatedActions - totalSimulatedActions - 1
          )
        );

        const rolloutOptions: RolloutOptions = {
          maxTurns: budget.maxTurnsPerRollout,
          maxActions: remainingActionBudget,
          diceModel,
          initialRollHistory: trialRollHistory,
          diceAlignmentStatus: alignmentStatus,
          policy,
          validateEveryStep: config?.validateEveryStep ?? false
        };

        const rolloutRes = runRollout(
          stepRes.state,
          createSeededRng(contSeed),
          rolloutOptions
        );

        const candElapsed = nowMs() - candStartMs;
        acc.elapsedMs += candElapsed;
        rolloutExecutionMs += candElapsed;
        totalRolloutsExecuted += 1;

        const actionsUsed = 1 + rolloutRes.actionsSimulated;
        acc.totalSimulatedActions += actionsUsed;
        totalSimulatedActions += actionsUsed;

        if (rolloutRes.completed && rolloutRes.status === "completed") {
          acc.completedGames += 1;
          acc.completedTurnsList.push(rolloutRes.turnsSimulated);
          acc.completedActionsList.push(actionsUsed);
          if (rolloutRes.winnerId === selfPlayerId) {
            acc.wins += 1;
            acc.completedOutcomeByTrial.set(trialIdx, "win");
          } else if (rolloutRes.winnerId !== undefined) {
            acc.losses += 1;
            acc.completedOutcomeByTrial.set(trialIdx, "loss");
          } else {
            acc.draws += 1;
            acc.completedOutcomeByTrial.set(trialIdx, "draw");
          }
        } else if (rolloutRes.status === "max_turns_reached") {
          acc.maxTurnsCutoffs += 1;
          acc.cutoffVpMargins.push(computeCutoffVpMargin(rolloutRes.finalState, selfPlayerId));
        } else if (rolloutRes.status === "max_actions_reached") {
          acc.maxActionsCutoffs += 1;
          acc.cutoffVpMargins.push(computeCutoffVpMargin(rolloutRes.finalState, selfPlayerId));
        } else {
          acc.rolloutErrors += 1;
        }
      }
    }
  }

  // 5. Aggregate Per-Candidate Results and Paired Comparisons vs Legacy Top
  const aggStartMs = nowMs();
  const legacyTopAcc =
    accumulators.find((a) => a.candidate.isLegacyRecommended && a.selectedForRollout) ??
    activeAccumulators[0];

  const candidateEvaluations: CandidateShadowEvaluation[] = accumulators.map((acc) => {
    if (!acc.mapping.supported) {
      return {
        candidate: acc.candidate,
        mapping: acc.mapping,
        evaluationStatus: "unsupported_candidate",
        isSufficientlySupported: false,
        statusReason: acc.mapping.unsupportedReason,
        determinizationAttempts: 0,
        determinizationSuccesses: 0,
        completedGames: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        cutoffs: { total: 0, maxTurns: 0, maxActions: 0, budgetExhausted: 0 },
        failures: { total: 0, determinizationFailed: 0, illegalAction: 0, rolloutError: 0 },
        empiricalWinRateAmongCompleted: null,
        completionRate: 0,
        wilson95Interval: null,
        cutoffVpMarginEstimate: null,
        medianTurnsAmongCompleted: null,
        medianActionsAmongCompleted: null,
        totalSimulatedActions: 0,
        elapsedMs: 0
      };
    }

    if (!acc.selectedForRollout) {
      return {
        candidate: acc.candidate,
        mapping: acc.mapping,
        evaluationStatus: "skipped_budget_candidate_cap",
        isSufficientlySupported: false,
        statusReason: `Skipped due to budget.maxCandidates cap (${budget.maxCandidates}).`,
        determinizationAttempts: 0,
        determinizationSuccesses: 0,
        completedGames: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        cutoffs: { total: 0, maxTurns: 0, maxActions: 0, budgetExhausted: 0 },
        failures: { total: 0, determinizationFailed: 0, illegalAction: 0, rolloutError: 0 },
        empiricalWinRateAmongCompleted: null,
        completionRate: 0,
        wilson95Interval: null,
        cutoffVpMarginEstimate: null,
        medianTurnsAmongCompleted: null,
        medianActionsAmongCompleted: null,
        totalSimulatedActions: 0,
        elapsedMs: 0
      };
    }

    const totalCutoffs = acc.maxTurnsCutoffs + acc.maxActionsCutoffs + acc.budgetCutoffs;
    const totalFailures =
      acc.determinizationFailures + acc.illegalActionFailures + acc.rolloutErrors;
    const completionRate =
      acc.determinizationAttempts > 0 ? acc.completedGames / acc.determinizationAttempts : 0;
    const empiricalWinRate =
      acc.completedGames > 0 ? acc.wins / acc.completedGames : null;
    const wilson = computeWilson95Interval(acc.wins, acc.completedGames);
    const cutoffVpMargin =
      acc.cutoffVpMargins.length > 0
        ? acc.cutoffVpMargins.reduce((a, b) => a + b, 0) / acc.cutoffVpMargins.length
        : null;

    let evaluationStatus: CandidateEvaluationStatus;
    let statusReason: string;

    if (acc.determinizationSuccesses > 0 && acc.illegalActionFailures === acc.determinizationSuccesses) {
      evaluationStatus = "rejected_illegal_candidate";
      statusReason =
        "Mapped SimulatedAction was rejected as illegal by getLegalActions / applyAction in all concrete samples.";
    } else if (stoppedByStaleCallback) {
      evaluationStatus = "inconclusive_stale_aborted";
      statusReason = "Evaluation aborted early because the live game state became stale.";
    } else if (
      (stoppedByElapsedBudget || stoppedByRolloutCap || stoppedByActionCap) &&
      acc.completedGames < budget.minCompletedTrialsForSupport
    ) {
      evaluationStatus = "inconclusive_budget_exhausted";
      statusReason = `Runtime budget exhausted after ${acc.completedGames} completed trial(s) (minimum required: ${budget.minCompletedTrialsForSupport}).`;
    } else if (acc.completedGames < budget.minCompletedTrialsForSupport) {
      evaluationStatus = "inconclusive_low_sample";
      statusReason = `Completed trials (${acc.completedGames}) below minimum support threshold (${budget.minCompletedTrialsForSupport}).`;
    } else if (completionRate < budget.minCompletionRateForSupport) {
      evaluationStatus = "inconclusive_high_cutoff_rate";
      statusReason = `Completion rate (${(completionRate * 100).toFixed(1)}%) is below minimum threshold (${(budget.minCompletionRateForSupport * 100).toFixed(1)}%).`;
    } else {
      evaluationStatus = "sufficiently_supported";
      statusReason = `Completed ${acc.completedGames}/${acc.determinizationAttempts} matched rollout trials within budget.`;
    }

    const isSufficientlySupported = evaluationStatus === "sufficiently_supported";

    let comparisonVsLegacyTop: PairedComparisonSummary | undefined;
    if (legacyTopAcc) {
      if (acc.candidate.candidateId === legacyTopAcc.candidate.candidateId) {
        comparisonVsLegacyTop = {
          baselineCandidateId: legacyTopAcc.candidate.candidateId,
          pairedCompletedTrials: acc.completedGames,
          candidateWonBaselineLost: 0,
          baselineWonCandidateLost: 0,
          bothWon: acc.wins,
          bothLost: acc.losses,
          bothDrew: acc.draws,
          pairedWinRateDelta: 0,
          pairedDeltaStandardError: 0,
          classification: "self_baseline"
        };
      } else {
        let pairedCompleted = 0;
        let candWonBaseLost = 0;
        let baseWonCandLost = 0;
        let bothWon = 0;
        let bothLost = 0;
        let bothDrew = 0;

        for (const [trialIdx, candOut] of acc.completedOutcomeByTrial.entries()) {
          const baseOut = legacyTopAcc.completedOutcomeByTrial.get(trialIdx);
          if (!baseOut) continue;
          pairedCompleted += 1;
          if (candOut === "win" && baseOut === "win") bothWon += 1;
          else if (candOut === "loss" && baseOut === "loss") bothLost += 1;
          else if (candOut === "draw" && baseOut === "draw") bothDrew += 1;
          else if (candOut === "win" && baseOut !== "win") candWonBaseLost += 1;
          else if (baseOut === "win" && candOut !== "win") baseWonCandLost += 1;
        }

        const delta =
          pairedCompleted > 0 ? (candWonBaseLost - baseWonCandLost) / pairedCompleted : null;
        // Paired McNemar-style standard error on the difference of two correlated binary proportions
        const discordantFrac =
          pairedCompleted > 0 ? (candWonBaseLost + baseWonCandLost) / pairedCompleted : 0;
        const se =
          pairedCompleted > 0 && delta !== null
            ? Math.sqrt(Math.max(0, discordantFrac - delta * delta) / pairedCompleted)
            : null;

        const legacyTopSupported =
          legacyTopAcc.completedGames >= budget.minCompletedTrialsForSupport &&
          (legacyTopAcc.determinizationAttempts > 0
            ? legacyTopAcc.completedGames / legacyTopAcc.determinizationAttempts
            : 0) >= budget.minCompletionRateForSupport;

        let classification: PairedComparisonSummary["classification"];
        if (
          !isSufficientlySupported ||
          !legacyTopSupported ||
          pairedCompleted < budget.minCompletedTrialsForSupport ||
          delta === null ||
          se === null
        ) {
          classification = "inconclusive_difference";
        } else if (delta > 0 && delta - 1.96 * se > 0) {
          classification = "experimental_disagreement";
        } else if (delta <= 0) {
          classification = "agrees_with_legacy";
        } else {
          classification = "inconclusive_difference";
        }

        comparisonVsLegacyTop = {
          baselineCandidateId: legacyTopAcc.candidate.candidateId,
          pairedCompletedTrials: pairedCompleted,
          candidateWonBaselineLost: candWonBaseLost,
          baselineWonCandidateLost: baseWonCandLost,
          bothWon,
          bothLost,
          bothDrew,
          pairedWinRateDelta: delta,
          pairedDeltaStandardError: se,
          classification
        };
      }
    }

    return {
      candidate: acc.candidate,
      mapping: acc.mapping,
      evaluationStatus,
      isSufficientlySupported,
      statusReason,
      determinizationAttempts: acc.determinizationAttempts,
      determinizationSuccesses: acc.determinizationSuccesses,
      completedGames: acc.completedGames,
      wins: acc.wins,
      losses: acc.losses,
      draws: acc.draws,
      cutoffs: {
        total: totalCutoffs,
        maxTurns: acc.maxTurnsCutoffs,
        maxActions: acc.maxActionsCutoffs,
        budgetExhausted: acc.budgetCutoffs
      },
      failures: {
        total: totalFailures,
        determinizationFailed: acc.determinizationFailures,
        illegalAction: acc.illegalActionFailures,
        rolloutError: acc.rolloutErrors
      },
      empiricalWinRateAmongCompleted: empiricalWinRate,
      completionRate,
      wilson95Interval: wilson,
      cutoffVpMarginEstimate: cutoffVpMargin,
      medianTurnsAmongCompleted: computeMedian(acc.completedTurnsList),
      medianActionsAmongCompleted: computeMedian(acc.completedActionsList),
      totalSimulatedActions: acc.totalSimulatedActions,
      elapsedMs: acc.elapsedMs,
      ...(comparisonVsLegacyTop ? { comparisonVsLegacyTop } : {})
    };
  });

  const supportedEvals = candidateEvaluations.filter((e) => e.isSufficientlySupported);
  const sortedByWinRate = [...supportedEvals].sort(
    (a, b) =>
      (b.empiricalWinRateAmongCompleted ?? -1) - (a.empiricalWinRateAmongCompleted ?? -1) ||
      a.candidate.legacyRank - b.candidate.legacyRank
  );
  const experimentalTopCandidateId = sortedByWinRate[0]?.candidate.candidateId;

  const legacyTopEval = candidateEvaluations.find((e) => e.candidate.isLegacyRecommended);
  const experimentalAgreesWithLegacy =
    experimentalTopCandidateId && legacyTopEval?.isSufficientlySupported
      ? experimentalTopCandidateId === legacyTopEval.candidate.candidateId ||
        sortedByWinRate[0]?.comparisonVsLegacyTop?.classification !== "experimental_disagreement"
      : null;

  const anySufficient = supportedEvals.length > 0;
  const overallStatus: ShadowReportStatus = anySufficient ? "evaluated" : "inconclusive";
  const statusMessage = anySufficient
    ? `Evaluated ${activeAccumulators.length} candidate(s) across ${determinizationsSucceeded} matched determinization(s).`
    : stoppedByStaleCallback
      ? "Shadow evaluation stopped early due to stale state."
      : stoppedByElapsedBudget || stoppedByRolloutCap || stoppedByActionCap
        ? "Shadow evaluation stopped by runtime/rollout budget before reaching minimum support threshold."
        : "Shadow evaluation is inconclusive (insufficient completed trials or unsupported candidates).";

  const aggregationMs = nowMs() - aggStartMs;
  const totalElapsedMs = nowMs() - totalStartMs;

  const report: ShadowEvaluationReport = {
    mode: "shadow_only",
    status: overallStatus,
    fallbackToLegacyRecommendation: true,
    statusMessage,
    baseSeed,
    policyId: policy.id,
    legacyRecommendation: { ...legacySummary },
    epistemicLayers: reconResult.epistemicLayers,
    diceDiagnostics: supportCheck.diceDiagnostics,
    candidateEvaluations,
    ...(experimentalTopCandidateId !== undefined ? { experimentalTopCandidateId } : {}),
    experimentalAgreesWithLegacy,
    budgetDiagnostics: {
      configured: budget,
      candidatesSubmitted: candidates.length,
      candidatesSupported: supportedIndices.length,
      candidatesEvaluated: activeAccumulators.length,
      candidatesSkippedByCap,
      determinizationsAttempted,
      determinizationsSucceeded,
      totalRolloutsExecuted,
      totalSimulatedActions,
      stoppedByElapsedBudget,
      stoppedByRolloutCap,
      stoppedByActionCap,
      stoppedByStaleCallback
    },
    timing: {
      totalElapsedMs,
      stateReconstructionMs,
      candidateMappingMs,
      determinizationMs,
      rolloutExecutionMs,
      aggregationMs
    },
    warnings: [...observed.provenance.warnings],
    knownLimitations: KNOWN_ROLLOUT_AND_MODEL_LIMITATIONS
  };

  config?.onReport?.(report);
  return report;
}

// ============================================================================
// 9. Helpers for Opening & Robber Candidate Extraction
// ============================================================================

export function buildOpeningCandidatesFromPlan(plan: OpeningPlan): LegacyOpeningSettlementCandidate[] {
  return plan.picks.map((pick: OpeningPick, idx: number) => ({
    kind: "opening_settlement",
    candidateId: `opening_settle_${pick.at}`,
    label: `Settle ${pick.at} (${pick.numbers.join("/")}, ${pick.pips} pips)`,
    isLegacyRecommended: idx === 0,
    legacyRank: idx,
    legacyScore: pick.score,
    at: pick.at,
    ...(pick.followUp ? { followUpAt: pick.followUp.at } : {}),
    openingMode: plan.mode
  }));
}

export function buildRobberCandidatesFromTargets(
  targets: readonly RobberTarget[]
): LegacyRobberTargetCandidate[] {
  return targets.map((t, idx) => ({
    kind: "robber_target",
    candidateId: `robber_${t.hexId}`,
    label: `Rob hex ${t.hexId} (${t.number} ${t.resource ?? "desert"})`,
    isLegacyRecommended: idx === 0,
    legacyRank: idx,
    legacyScore: t.score,
    hexId: t.hexId,
    targets: [...t.targets]
  }));
}

export function evaluateOpeningShadow(
  board: Board,
  placements: Placements,
  me: string,
  plan: OpeningPlan,
  config?: ShadowRolloutConfig & {
    readonly snapshot?: GameSnapshot;
    readonly events?: GameEvent[];
    readonly observedStateOverride?: ObservedGameState;
  }
): ShadowEvaluationReport {
  const candidates = buildOpeningCandidatesFromPlan(plan);
  const top = plan.picks[0];
  const legacySummary: LegacyRecommendationSummary = {
    source: "coachedOpening",
    headline: top
      ? `Settle ${top.at} (${top.numbers.join("/")}, ${top.pips} pips)`
      : plan.note,
    primaryCandidateId: candidates[0]?.candidateId,
    primaryActionId: "opening_settlement",
    legacyScore: top?.score
  };
  return evaluateCandidatesShadow(
    {
      board,
      placements,
      me,
      snapshot: config?.snapshot,
      events: config?.events,
      observedStateOverride: config?.observedStateOverride
    },
    legacySummary,
    candidates,
    config
  );
}

registerOpeningShadowEvaluator(evaluateOpeningShadow);

export function evaluateRobberTargetsShadow(
  input: ShadowStateInput,
  targets: readonly RobberTarget[],
  config?: ShadowRolloutConfig
): ShadowEvaluationReport {
  const candidates = buildRobberCandidatesFromTargets(targets);
  const top = targets[0];
  const legacySummary: LegacyRecommendationSummary = {
    source: "robberTargets",
    headline: top
      ? `Rob hex ${top.hexId} (${top.number} ${top.resource ?? "desert"})`
      : "No robber target",
    primaryCandidateId: candidates[0]?.candidateId,
    primaryActionId: "robber_target",
    legacyScore: top?.score
  };
  return evaluateCandidatesShadow(input, legacySummary, candidates, config);
}


