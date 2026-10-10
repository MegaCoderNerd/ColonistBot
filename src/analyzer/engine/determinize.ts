import { RESOURCES, type DevCardKind, type Resource, type ResourceHand } from "../types";
import type { SeededRng } from "./rng";
import {
  BANK_RESOURCE_CAP,
  STANDARD_DEV_DECK_COUNTS,
  validateConcreteSimState,
  type ActionDevCardKind,
  type ConcreteDevCardKind,
  type ConcreteSimulatedGameState,
  type ConcreteTurnPhase,
  type ObservedGameState
} from "./state";
import { materializeConcreteState, validateSupportedVariantAndRuleset } from "./transition";

export type ResourceSamplingPolicy = "likely_prior" | "uniform_within_bounds";

export interface DeterminizationOptions {
  /**
   * Sampling policy for uncertain opponent/self resource hands within hard `[knownMin, maxPossible]` bounds:
   * - `"likely_prior"` (default): uses `hand.likely` as a soft positive prior weight within the hard bounds.
   * - `"uniform_within_bounds"`: weights feasible resource allocations uniformly by remaining bound capacity.
   */
  readonly resourceSamplingPolicy?: ResourceSamplingPolicy;
  /** Optional explicit diceMode override when `observed.rules.diceMode.mode === "unknown"`. */
  readonly diceModeOverride?: "balanced" | "random";
  /** Optional explicit phase override when `observed.phase === "unknown"`. */
  readonly phaseOverride?: ConcreteTurnPhase;
  /** Optional explicit active turnPlayerId override when `observed.turnPlayerId` is missing. */
  readonly turnPlayerIdOverride?: string;
  /** Optional explicit robberHexIndex override when `observed.robberHexIndex === null`. */
  readonly robberHexIndexOverride?: number;
  /** Optional per-player upper bound override on sampled unrevealed VP dev cards. */
  readonly maxSampledVpDevsByPlayerId?: Readonly<Record<string, number>>;
}

export type DeterminizationErrorCode =
  | "unsupported_variant"
  | "unsupported_ruleset"
  | "unsupported_phase"
  | "unsupported_dice_mode"
  | "invalid_observed_state"
  | "inconsistent_resource_constraints"
  | "resource_conservation_impossible"
  | "inconsistent_dev_constraints"
  | "dev_conservation_impossible";

export interface PlayerHandSamplingDiagnostics {
  readonly playerId: string;
  readonly handSize: number;
  readonly unknownCount: number;
  readonly mode: "exact_authoritative" | "sampled_bounded" | "sampled_count_only";
  readonly inferenceSource: ObservedGameState["players"][number]["hand"]["inferenceSource"];
  readonly usedLikelyPrior: boolean;
  readonly appliedKnownMin: ResourceHand;
  readonly appliedMaxPossible: ResourceHand;
  readonly sampledHand: ResourceHand;
}

export interface PlayerDevSamplingDiagnostics {
  readonly playerId: string;
  readonly totalInHand: number;
  readonly confirmedInHand: number;
  readonly unknownInHand: number;
  readonly unknownPlayableNow: number;
  readonly unknownBoughtThisTurn: number;
  readonly sampledReadyActionDevs: readonly ActionDevCardKind[];
  readonly sampledBoughtThisTurnActionDevs: readonly ActionDevCardKind[];
  readonly sampledHiddenVpDevs: number;
}

export interface DeterminizationDiagnostics {
  readonly seed: number;
  readonly resourceSamplingPolicy: ResourceSamplingPolicy;
  readonly bankConstraintMode: "exact_bank" | "supply_cap_only";
  readonly playerHands: readonly PlayerHandSamplingDiagnostics[];
  readonly playerDevs: readonly PlayerDevSamplingDiagnostics[];
  readonly sampledBankResources: ResourceHand;
  readonly sampledDevDeckRemaining: number;
}

export interface DeterminizationFailure {
  readonly ok: false;
  readonly state?: undefined;
  readonly diagnostics?: undefined;
  readonly error: {
    readonly code: DeterminizationErrorCode;
    readonly message: string;
    readonly playerId?: string;
    readonly resource?: Resource;
  };
}

export interface DeterminizationSuccess {
  readonly ok: true;
  readonly state: ConcreteSimulatedGameState;
  readonly diagnostics: DeterminizationDiagnostics;
  readonly error?: undefined;
}

export type DeterminizationResult = DeterminizationSuccess | DeterminizationFailure;

const emptyHand = (): ResourceHand => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
const sumHand = (h: ResourceHand): number => RESOURCES.reduce((s, r) => s + h[r], 0);

function failDet(
  code: DeterminizationErrorCode,
  message: string,
  extra?: { playerId?: string; resource?: Resource }
): DeterminizationFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(extra?.playerId !== undefined ? { playerId: extra.playerId } : {}),
      ...(extra?.resource !== undefined ? { resource: extra.resource } : {})
    }
  };
}

function isActionDev(c: DevCardKind): c is ActionDevCardKind {
  return c === "knight" || c === "roadBuilding" || c === "yearOfPlenty" || c === "monopoly";
}

function isConcreteDev(c: DevCardKind): c is ConcreteDevCardKind {
  return isActionDev(c) || c === "victoryPoint";
}

/**
 * Exact bounded integer matrix feasibility check for residual resource allocation across P players and 5 resources.
 * Determines whether there exists an integer matrix `A[p][r]` for `p in pIdx..P-1, r in 0..4` such that:
 * - `0 <= A[p][r] <= cellCap[p][r]`
 * - `sum_r A[p][r] === remPlayerNeeds[p]`
 * - `resMinNeeds[r] <= sum_p A[p][r] <= resMaxCap[r]`
 */
function hasFeasibleResidualResourceAssignment(
  remPlayerNeeds: readonly number[],
  cellCap: ReadonlyArray<readonly number[]>,
  resMinNeeds: readonly number[],
  resMaxCap: readonly number[]
): boolean {
  const numPlayers = remPlayerNeeds.length;
  const numRes = RESOURCES.length;

  let totalNeeded = 0;
  for (let p = 0; p < numPlayers; p++) {
    if (remPlayerNeeds[p] < 0) return false;
    let maxRowCap = 0;
    for (let r = 0; r < numRes; r++) {
      maxRowCap += Math.min(cellCap[p][r], resMaxCap[r]);
    }
    if (remPlayerNeeds[p] > maxRowCap) return false;
    totalNeeded += remPlayerNeeds[p];
  }

  let sumMinRes = 0;
  let sumMaxRes = 0;
  for (let r = 0; r < numRes; r++) {
    if (resMaxCap[r] < 0 || resMinNeeds[r] > resMaxCap[r]) return false;
    let maxColCap = 0;
    for (let p = 0; p < numPlayers; p++) {
      maxColCap += Math.min(cellCap[p][r], remPlayerNeeds[p]);
    }
    if (resMinNeeds[r] > maxColCap) return false;
    sumMinRes += Math.max(0, resMinNeeds[r]);
    sumMaxRes += Math.min(maxColCap, resMaxCap[r]);
  }

  if (totalNeeded < sumMinRes || totalNeeded > sumMaxRes) return false;
  if (totalNeeded === 0) return sumMinRes === 0;

  const pNeeds = [...remPlayerNeeds];
  const rMin = [...resMinNeeds];
  const rMax = [...resMaxCap];

  const solve = (pIdx: number, rIdx: number): boolean => {
    while (pIdx < numPlayers && pNeeds[pIdx] === 0) {
      pIdx += 1;
      rIdx = 0;
    }
    if (pIdx >= numPlayers) {
      for (let r = 0; r < numRes; r++) {
        if (rMin[r] > 0) return false;
      }
      return true;
    }

    if (rIdx === numRes - 1) {
      const val = pNeeds[pIdx];
      if (val < 0 || val > cellCap[pIdx][rIdx] || val > rMax[rIdx]) return false;
      let maxRemainingInCol = 0;
      for (let q = pIdx + 1; q < numPlayers; q++) {
        maxRemainingInCol += Math.min(cellCap[q][rIdx], pNeeds[q]);
      }
      if (rMin[rIdx] - val > maxRemainingInCol) return false;

      const prevP = pNeeds[pIdx];
      const prevMin = rMin[rIdx];
      const prevMax = rMax[rIdx];
      pNeeds[pIdx] = 0;
      rMin[rIdx] = Math.max(0, prevMin - val);
      rMax[rIdx] = prevMax - val;
      const ok = solve(pIdx + 1, 0);
      pNeeds[pIdx] = prevP;
      rMin[rIdx] = prevMin;
      rMax[rIdx] = prevMax;
      return ok;
    }

    let maxAfterColsForPlayer = 0;
    for (let c = rIdx + 1; c < numRes; c++) {
      maxAfterColsForPlayer += Math.min(cellCap[pIdx][c], rMax[c]);
    }
    let maxAfterPlayersForCol = 0;
    for (let q = pIdx + 1; q < numPlayers; q++) {
      maxAfterPlayersForCol += Math.min(cellCap[q][rIdx], pNeeds[q]);
    }

    const low = Math.max(0, pNeeds[pIdx] - maxAfterColsForPlayer, rMin[rIdx] - maxAfterPlayersForCol);
    const high = Math.min(pNeeds[pIdx], cellCap[pIdx][rIdx], rMax[rIdx]);
    if (low > high) return false;

    const prevP = pNeeds[pIdx];
    const prevMin = rMin[rIdx];
    const prevMax = rMax[rIdx];

    for (let val = low; val <= high; val++) {
      pNeeds[pIdx] = prevP - val;
      rMin[rIdx] = Math.max(0, prevMin - val);
      rMax[rIdx] = prevMax - val;
      if (solve(pIdx, rIdx + 1)) {
        pNeeds[pIdx] = prevP;
        rMin[rIdx] = prevMin;
        rMax[rIdx] = prevMax;
        return true;
      }
    }

    pNeeds[pIdx] = prevP;
    rMin[rIdx] = prevMin;
    rMax[rIdx] = prevMax;
    return false;
  };

  return solve(0, 0);
}

/**
 * Samples a fully determined `ConcreteSimulatedGameState` from an `ObservedGameState` using `rng`,
 * or returns a structured `DeterminizationFailure` if the observed constraints, phase, or ruleset are inconsistent/unsupported.
 *
 * Guarantees for every successful sample:
 * - Preserves exact authoritative hands (`hand.exact !== null && inferenceSource === "authoritative"`).
 * - Preserves every player's `handSize` and `[knownMin, maxPossible]` per-resource bounds.
 * - Treats `hand.likely` strictly as a soft sampling prior (`resourceSamplingPolicy: "likely_prior"`), never as a hard fact.
 * - Enforces strict 19-per-resource supply conservation across all players and the bank.
 * - Samples unknown opponent/self dev cards and the bank dev deck order without replacement from the remaining 25-card pool,
 *   respecting `unknownBoughtThisTurn` vs `unknownPlayableNow` and `maxUnrevealedVpDevs`.
 * - Never mutates `observed`.
 * - Passes `validateConcreteSimState`.
 */
export function sampleDeterminization(
  observed: ObservedGameState,
  rng: SeededRng,
  options?: DeterminizationOptions
): DeterminizationResult {
  if (!observed || observed.kind !== "observed") {
    return failDet("invalid_observed_state", "Expected a valid ObservedGameState (kind === 'observed').");
  }

  const resolvedDiceMode =
    options?.diceModeOverride ??
    (observed.rules.diceMode.mode !== "unknown" ? observed.rules.diceMode.mode : undefined);
  if (!resolvedDiceMode) {
    return failDet(
      "unsupported_dice_mode",
      `Observed diceMode is '${observed.rules.diceMode.mode}' (setting=${String(observed.rules.diceMode.setting)}). Supply options.diceModeOverride to determinize; refusing to silently assume standard fair dice.`
    );
  }

  const candidateRules: ConcreteSimulatedGameState["rules"] = {
    victoryPointsToWin: observed.rules.victoryPointsToWin.value,
    cardDiscardLimit: observed.rules.cardDiscardLimit.value,
    friendlyRobber: observed.rules.friendlyRobber.value,
    friendlyRobberMinVisibleVp: observed.rules.friendlyRobber.minVisibleVp,
    diceMode: resolvedDiceMode,
    maxPlayers: observed.rules.maxPlayers.value,
    bankResourceCap: BANK_RESOURCE_CAP,
    devDeckComposition: { ...STANDARD_DEV_DECK_COUNTS },
    ...(observed.rules.extensionSetting !== undefined ? { extensionSetting: observed.rules.extensionSetting } : {}),
    ...(observed.rules.mapSetting !== undefined ? { mapSetting: observed.rules.mapSetting } : {})
  };

  const variantFailure = validateSupportedVariantAndRuleset(
    observed.topology,
    observed.players.length,
    candidateRules
  );
  if (variantFailure !== null) {
    return failDet(
      variantFailure.error.code === "unsupported_variant" ? "unsupported_variant" : "unsupported_ruleset",
      variantFailure.error.message
    );
  }

  const phase = options?.phaseOverride ?? (observed.phase !== "unknown" ? observed.phase : undefined);
  if (!phase || phase === "setup_waiting") {
    return failDet(
      "unsupported_phase",
      `Cannot determinize ObservedGameState in unresolved or unsupported phase '${observed.phase}'.`
    );
  }

  const turnPlayerId = options?.turnPlayerIdOverride ?? observed.turnPlayerId;
  if (!turnPlayerId || !observed.playerOrder.includes(turnPlayerId)) {
    return failDet("invalid_observed_state", "Cannot determinize without a valid seated turnPlayerId.");
  }

  const robberHexIndex = options?.robberHexIndexOverride ?? observed.robberHexIndex;
  if (robberHexIndex === null || robberHexIndex < 0 || robberHexIndex >= observed.topology.hexes.length) {
    return failDet("invalid_observed_state", "Cannot determinize without a valid robberHexIndex.");
  }

  // ---------------------------------------------------------------------------
  // 1. Validate & Sample Resource Hands across all players
  // ---------------------------------------------------------------------------
  const numPlayers = observed.players.length;
  const numRes = RESOURCES.length;
  const policy: ResourceSamplingPolicy = options?.resourceSamplingPolicy ?? "likely_prior";

  const minMatrix: number[][] = [];
  const maxMatrix: number[][] = [];
  const allocatedMatrix: number[][] = [];
  const remPlayerNeeds: number[] = [];
  const cellCap: number[][] = [];

  for (let pIdx = 0; pIdx < numPlayers; pIdx++) {
    const p = observed.players[pIdx];
    const hSize = p.hand.handSize;
    if (!Number.isInteger(hSize) || hSize < 0 || hSize > BANK_RESOURCE_CAP * numRes) {
      return failDet(
        "inconsistent_resource_constraints",
        `Player '${p.id}' has invalid handSize=${hSize}.`,
        { playerId: p.id }
      );
    }

    const rowMin = new Array<number>(numRes).fill(0);
    const rowMax = new Array<number>(numRes).fill(0);

    if (p.hand.exact !== null) {
      if (p.hand.inferenceSource !== "authoritative") {
        return failDet(
          "inconsistent_resource_constraints",
          `Player '${p.id}' has non-null exact hand with non-authoritative inferenceSource='${p.hand.inferenceSource}'.`,
          { playerId: p.id }
        );
      }
      if (p.hand.unknownCount !== 0) {
        return failDet(
          "inconsistent_resource_constraints",
          `Player '${p.id}' has exact hand but unknownCount=${p.hand.unknownCount} !== 0.`,
          { playerId: p.id }
        );
      }
      const exactSum = sumHand(p.hand.exact);
      if (exactSum !== hSize) {
        return failDet(
          "inconsistent_resource_constraints",
          `Player '${p.id}' exact hand sum (${exactSum}) !== handSize (${hSize}).`,
          { playerId: p.id }
        );
      }
      for (let rIdx = 0; rIdx < numRes; rIdx++) {
        const r = RESOURCES[rIdx];
        const v = p.hand.exact[r];
        if (!Number.isInteger(v) || v < 0 || v > BANK_RESOURCE_CAP) {
          return failDet(
            "inconsistent_resource_constraints",
            `Player '${p.id}' has out-of-range exact[${r}]=${v}.`,
            { playerId: p.id, resource: r }
          );
        }
        if (v < p.hand.knownMin[r] || v > p.hand.maxPossible[r]) {
          return failDet(
            "inconsistent_resource_constraints",
            `Player '${p.id}' exact[${r}]=${v} violates bounds [${p.hand.knownMin[r]}, ${p.hand.maxPossible[r]}].`,
            { playerId: p.id, resource: r }
          );
        }
        rowMin[rIdx] = v;
        rowMax[rIdx] = v;
      }
    } else {
      let minSum = 0;
      let maxSum = 0;
      for (let rIdx = 0; rIdx < numRes; rIdx++) {
        const r = RESOURCES[rIdx];
        const kMin = p.hand.knownMin[r];
        const mPoss = p.hand.maxPossible[r];
        if (!Number.isInteger(kMin) || !Number.isInteger(mPoss) || kMin < 0 || mPoss < 0) {
          return failDet(
            "inconsistent_resource_constraints",
            `Player '${p.id}' has negative or non-integer resource bounds for '${r}': [${kMin}, ${mPoss}].`,
            { playerId: p.id, resource: r }
          );
        }
        if (kMin > mPoss) {
          return failDet(
            "inconsistent_resource_constraints",
            `Player '${p.id}' has knownMin[${r}]=${kMin} > maxPossible[${r}]=${mPoss}.`,
            { playerId: p.id, resource: r }
          );
        }
        if (kMin > BANK_RESOURCE_CAP) {
          return failDet(
            "resource_conservation_impossible",
            `Player '${p.id}' has knownMin[${r}]=${kMin} exceeding bank supply cap ${BANK_RESOURCE_CAP}.`,
            { playerId: p.id, resource: r }
          );
        }
        const effectiveMax = Math.min(hSize, mPoss, BANK_RESOURCE_CAP);
        if (kMin > effectiveMax) {
          return failDet(
            "inconsistent_resource_constraints",
            `Player '${p.id}' has knownMin[${r}]=${kMin} exceeding effective max ${effectiveMax} (handSize=${hSize}).`,
            { playerId: p.id, resource: r }
          );
        }
        rowMin[rIdx] = kMin;
        rowMax[rIdx] = effectiveMax;
        minSum += kMin;
        maxSum += effectiveMax;
      }

      if (minSum > hSize) {
        return failDet(
          "inconsistent_resource_constraints",
          `Player '${p.id}' sum of knownMin (${minSum}) exceeds handSize (${hSize}).`,
          { playerId: p.id }
        );
      }
      if (maxSum < hSize) {
        return failDet(
          "inconsistent_resource_constraints",
          `Player '${p.id}' sum of maxPossible (${maxSum}) is less than handSize (${hSize}).`,
          { playerId: p.id }
        );
      }
    }

    const rowMinSum = rowMin.reduce((a, b) => a + b, 0);
    minMatrix.push(rowMin);
    maxMatrix.push(rowMax);
    allocatedMatrix.push([...rowMin]);
    remPlayerNeeds.push(hSize - rowMinSum);
    cellCap.push(rowMax.map((u, rIdx) => u - rowMin[rIdx]));
  }

  // Global bank & 19-card supply constraints per resource
  const resMinNeeds = new Array<number>(numRes).fill(0);
  const resMaxCap = new Array<number>(numRes).fill(0);
  const hasExactBank = observed.bank.resources !== null;

  for (let rIdx = 0; rIdx < numRes; rIdx++) {
    const r = RESOURCES[rIdx];
    let minHeldAcrossPlayers = 0;
    let maxHeldAcrossPlayers = 0;
    for (let pIdx = 0; pIdx < numPlayers; pIdx++) {
      minHeldAcrossPlayers += minMatrix[pIdx][rIdx];
      maxHeldAcrossPlayers += maxMatrix[pIdx][rIdx];
    }

    if (minHeldAcrossPlayers > BANK_RESOURCE_CAP) {
      return failDet(
        "resource_conservation_impossible",
        `Sum of knownMin for '${r}' across all players (${minHeldAcrossPlayers}) exceeds supply cap (${BANK_RESOURCE_CAP}).`,
        { resource: r }
      );
    }

    if (hasExactBank) {
      const bankCount = observed.bank.resources![r];
      if (!Number.isInteger(bankCount) || bankCount < 0 || bankCount > BANK_RESOURCE_CAP) {
        return failDet(
          "inconsistent_resource_constraints",
          `Observed bank count for '${r}' is out of range: ${bankCount}.`,
          { resource: r }
        );
      }
      const targetHeld = BANK_RESOURCE_CAP - bankCount;
      if (targetHeld < minHeldAcrossPlayers || targetHeld > maxHeldAcrossPlayers) {
        return failDet(
          "resource_conservation_impossible",
          `Exact bank count for '${r}' (${bankCount}) requires players to hold ${targetHeld} copies, which is outside player bounds [${minHeldAcrossPlayers}, ${maxHeldAcrossPlayers}].`,
          { resource: r }
        );
      }
      resMinNeeds[rIdx] = targetHeld - minHeldAcrossPlayers;
      resMaxCap[rIdx] = targetHeld - minHeldAcrossPlayers;
    } else {
      resMinNeeds[rIdx] = 0;
      resMaxCap[rIdx] = Math.min(BANK_RESOURCE_CAP, maxHeldAcrossPlayers) - minHeldAcrossPlayers;
    }
  }

  if (!hasFeasibleResidualResourceAssignment(remPlayerNeeds, cellCap, resMinNeeds, resMaxCap)) {
    return failDet(
      "resource_conservation_impossible",
      "No joint resource hand assignment satisfies all player hand sizes, per-resource bounds, and 19-card bank conservation constraints simultaneously."
    );
  }

  // Step-by-step joint sampling guarded by exact lookahead feasibility
  for (let pIdx = 0; pIdx < numPlayers; pIdx++) {
    const p = observed.players[pIdx];
    while (remPlayerNeeds[pIdx] > 0) {
      const feasibleRIndices: number[] = [];
      const weights: number[] = [];

      for (let rIdx = 0; rIdx < numRes; rIdx++) {
        if (cellCap[pIdx][rIdx] <= 0 || resMaxCap[rIdx] <= 0) continue;

        // Tentatively allocate 1 card of rIdx to pIdx and verify residual feasibility
        const prevNeed = remPlayerNeeds[pIdx];
        const prevCap = cellCap[pIdx][rIdx];
        const prevMin = resMinNeeds[rIdx];
        const prevMax = resMaxCap[rIdx];

        remPlayerNeeds[pIdx] = prevNeed - 1;
        cellCap[pIdx][rIdx] = prevCap - 1;
        resMinNeeds[rIdx] = Math.max(0, prevMin - 1);
        resMaxCap[rIdx] = prevMax - 1;

        const feasible = hasFeasibleResidualResourceAssignment(remPlayerNeeds, cellCap, resMinNeeds, resMaxCap);

        remPlayerNeeds[pIdx] = prevNeed;
        cellCap[pIdx][rIdx] = prevCap;
        resMinNeeds[rIdx] = prevMin;
        resMaxCap[rIdx] = prevMax;

        if (!feasible) continue;

        const r = RESOURCES[rIdx];
        let w: number;
        if (policy === "uniform_within_bounds") {
          w = cellCap[pIdx][rIdx];
        } else {
          const likelyCount = Math.max(0, p.hand.likely[r] ?? 0);
          const unfilledLikely = Math.max(0, likelyCount - allocatedMatrix[pIdx][rIdx]);
          w = 1 + 3 * unfilledLikely + 0.25 * cellCap[pIdx][rIdx];
        }
        feasibleRIndices.push(rIdx);
        weights.push(w);
      }

      if (feasibleRIndices.length === 0) {
        return failDet(
          "resource_conservation_impossible",
          `Failed to find a feasible resource step for player '${p.id}'.`,
          { playerId: p.id }
        );
      }

      const chosenIdx = feasibleRIndices[rng.weightedIndex(weights)];
      allocatedMatrix[pIdx][chosenIdx] += 1;
      remPlayerNeeds[pIdx] -= 1;
      cellCap[pIdx][chosenIdx] -= 1;
      resMinNeeds[chosenIdx] = Math.max(0, resMinNeeds[chosenIdx] - 1);
      resMaxCap[chosenIdx] -= 1;
    }
  }

  const handsByPlayerId: Record<string, ResourceHand> = {};
  const playerHandDiagnostics: PlayerHandSamplingDiagnostics[] = [];

  for (let pIdx = 0; pIdx < numPlayers; pIdx++) {
    const p = observed.players[pIdx];
    const sampledHand = emptyHand();
    const appliedMin = emptyHand();
    const appliedMax = emptyHand();
    for (let rIdx = 0; rIdx < numRes; rIdx++) {
      const r = RESOURCES[rIdx];
      sampledHand[r] = allocatedMatrix[pIdx][rIdx];
      appliedMin[r] = minMatrix[pIdx][rIdx];
      appliedMax[r] = maxMatrix[pIdx][rIdx];
    }
    handsByPlayerId[p.id] = sampledHand;

    const isExactAuth = p.hand.exact !== null && p.hand.inferenceSource === "authoritative";
    const hasNonTrivialBounds = RESOURCES.some(
      (r) => appliedMin[r] > 0 || appliedMax[r] < Math.min(p.hand.handSize, BANK_RESOURCE_CAP)
    );
    const mode: PlayerHandSamplingDiagnostics["mode"] = isExactAuth
      ? "exact_authoritative"
      : hasNonTrivialBounds || p.hand.confidence === "bounded"
        ? "sampled_bounded"
        : "sampled_count_only";
    const usedLikelyPrior = !isExactAuth && policy === "likely_prior" && sumHand(p.hand.likely) > 0;

    playerHandDiagnostics.push({
      playerId: p.id,
      handSize: p.hand.handSize,
      unknownCount: p.hand.unknownCount,
      mode,
      inferenceSource: p.hand.inferenceSource,
      usedLikelyPrior,
      appliedKnownMin: appliedMin,
      appliedMaxPossible: appliedMax,
      sampledHand: { ...sampledHand }
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Validate & Sample Development Cards without replacement
  // ---------------------------------------------------------------------------
  const confirmedCounts: Record<ConcreteDevCardKind, number> = {
    knight: 0,
    victoryPoint: 0,
    roadBuilding: 0,
    yearOfPlenty: 0,
    monopoly: 0
  };

  let totalUnknownInHands = 0;
  let totalUnknownPlayed = 0;
  const maxVpForPlayer: number[] = [];
  const minActionForPlayer: number[] = [];

  for (let pIdx = 0; pIdx < numPlayers; pIdx++) {
    const p = observed.players[pIdx];
    if (
      p.devs.totalInHand < 0 ||
      p.devs.unknownInHand < 0 ||
      p.devs.unknownBoughtThisTurn < 0 ||
      p.devs.unknownPlayableNow < 0 ||
      p.devs.confirmedVpDevs < 0
    ) {
      return failDet(
        "inconsistent_dev_constraints",
        `Player '${p.id}' has negative development card count.`,
        { playerId: p.id }
      );
    }

    const confirmedInHand =
      p.devs.readyActionDevs.length + p.devs.boughtActionDevsThisTurn.length + p.devs.confirmedVpDevs;
    if (confirmedInHand + p.devs.unknownInHand !== p.devs.totalInHand) {
      return failDet(
        "inconsistent_dev_constraints",
        `Player '${p.id}' dev hand mismatch: confirmed(${confirmedInHand}) + unknown(${p.devs.unknownInHand}) !== totalInHand(${p.devs.totalInHand}).`,
        { playerId: p.id }
      );
    }
    if (p.devs.unknownBoughtThisTurn + p.devs.unknownPlayableNow !== p.devs.unknownInHand) {
      return failDet(
        "inconsistent_dev_constraints",
        `Player '${p.id}' unknownBoughtThisTurn(${p.devs.unknownBoughtThisTurn}) + unknownPlayableNow(${p.devs.unknownPlayableNow}) !== unknownInHand(${p.devs.unknownInHand}).`,
        { playerId: p.id }
      );
    }

    for (const c of p.devs.readyActionDevs) confirmedCounts[c] += 1;
    for (const c of p.devs.boughtActionDevsThisTurn) confirmedCounts[c] += 1;
    confirmedCounts.victoryPoint += p.devs.confirmedVpDevs;

    const playedKnightsInList = p.devs.playedCards.filter((c) => c === "knight").length;
    if (p.devs.knightsPlayed < playedKnightsInList) {
      return failDet(
        "inconsistent_dev_constraints",
        `Player '${p.id}' knightsPlayed (${p.devs.knightsPlayed}) < played knight cards (${playedKnightsInList}).`,
        { playerId: p.id }
      );
    }
    for (const c of p.devs.playedCards) {
      if (isConcreteDev(c)) confirmedCounts[c] += 1;
      else totalUnknownPlayed += 1;
    }

    totalUnknownInHands += p.devs.unknownInHand;

    const explicitMaxVp = options?.maxSampledVpDevsByPlayerId?.[p.id];
    const allowedVp = Math.min(
      p.devs.unknownInHand,
      p.vp.maxUnrevealedVpDevs,
      ...(explicitMaxVp !== undefined ? [explicitMaxVp] : [])
    );
    if (allowedVp < 0) {
      return failDet(
        "inconsistent_dev_constraints",
        `Player '${p.id}' has negative maxAllowedVpDevs=${allowedVp}.`,
        { playerId: p.id }
      );
    }
    maxVpForPlayer.push(allowedVp);
    minActionForPlayer.push(p.devs.unknownInHand - allowedVp);
  }

  if (totalUnknownPlayed > 0) {
    return failDet(
      "inconsistent_dev_constraints",
      `Observed state contains ${totalUnknownPlayed} played dev card(s) with unresolved 'unknown' identity.`
    );
  }

  const expectedUnseenPool: Record<ConcreteDevCardKind, number> = { ...STANDARD_DEV_DECK_COUNTS };
  for (const kind of Object.keys(STANDARD_DEV_DECK_COUNTS) as ConcreteDevCardKind[]) {
    if (confirmedCounts[kind] > STANDARD_DEV_DECK_COUNTS[kind]) {
      return failDet(
        "dev_conservation_impossible",
        `Confirmed '${kind}' count (${confirmedCounts[kind]}) exceeds standard deck composition (${STANDARD_DEV_DECK_COUNTS[kind]}).`
      );
    }
    expectedUnseenPool[kind] = STANDARD_DEV_DECK_COUNTS[kind] - confirmedCounts[kind];
    if (observed.devDeck.unseenPool[kind] < 0 || observed.devDeck.unseenPool[kind] !== expectedUnseenPool[kind]) {
      return failDet(
        "inconsistent_dev_constraints",
        `observed.devDeck.unseenPool['${kind}'] (${observed.devDeck.unseenPool[kind]}) is inconsistent with confirmed cards (expected ${expectedUnseenPool[kind]}).`
      );
    }
  }

  const unseenTotal = Object.values(expectedUnseenPool).reduce((a, b) => a + b, 0);
  if (observed.devDeck.unseenTotal !== unseenTotal) {
    return failDet(
      "inconsistent_dev_constraints",
      `observed.devDeck.unseenTotal (${observed.devDeck.unseenTotal}) !== sum(unseenPool) (${unseenTotal}).`
    );
  }

  if (observed.devDeck.bankRemaining < 0) {
    return failDet(
      "inconsistent_dev_constraints",
      `Negative observed.devDeck.bankRemaining=${observed.devDeck.bankRemaining}.`
    );
  }

  if (totalUnknownInHands > unseenTotal) {
    return failDet(
      "dev_conservation_impossible",
      `Total unknown dev cards held by players (${totalUnknownInHands}) exceeds remaining unseen pool (${unseenTotal}).`
    );
  }

  if (
    observed.devDeck.bankRemainingConfidence === "authoritative" ||
    observed.devDeck.bankRemainingConfidence === "derived_from_25_deck"
  ) {
    if (totalUnknownInHands + observed.devDeck.bankRemaining !== unseenTotal) {
      return failDet(
        "dev_conservation_impossible",
        `Dev card conservation violated: unknownInHands(${totalUnknownInHands}) + bankRemaining(${observed.devDeck.bankRemaining}) !== unseenTotal(${unseenTotal}).`
      );
    }
  }

  let vpCardsLeft = expectedUnseenPool.victoryPoint;
  const rawActionPool: ActionDevCardKind[] = [];
  for (const kind of ["knight", "roadBuilding", "yearOfPlenty", "monopoly"] as const) {
    for (let i = 0; i < expectedUnseenPool[kind]; i++) {
      rawActionPool.push(kind);
    }
  }
  const actionPool = rng.shuffle(rawActionPool);

  let totalMinActionNeeded = minActionForPlayer.reduce((a, b) => a + b, 0);
  if (totalMinActionNeeded > actionPool.length) {
    return failDet(
      "inconsistent_dev_constraints",
      `Players require at least ${totalMinActionNeeded} non-VP action dev cards to satisfy maxUnrevealedVpDevs bounds, but only ${actionPool.length} unseen action cards exist.`
    );
  }

  const unknownDevsByPlayerId: Record<
    string,
    {
      ready: ActionDevCardKind[];
      boughtThisTurn: ActionDevCardKind[];
      vp: number;
    }
  > = {};
  const playerDevDiagnostics: PlayerDevSamplingDiagnostics[] = [];

  for (let pIdx = 0; pIdx < numPlayers; pIdx++) {
    const p = observed.players[pIdx];
    const u = p.devs.unknownInHand;
    const uBought = p.devs.unknownBoughtThisTurn;
    const uPlayable = p.devs.unknownPlayableNow;
    const ready: ActionDevCardKind[] = [];
    const boughtThisTurn: ActionDevCardKind[] = [];
    let sampledVp = 0;

    let remPlayerSlots = u;
    let remPlayerMaxVp = maxVpForPlayer[pIdx];
    let remPlayerMinAction = minActionForPlayer[pIdx];
    totalMinActionNeeded -= remPlayerMinAction;

    // Sample each unknown slot without replacement, then randomly assign which slots were bought this turn vs prior turns
    const sampledCardsForPlayer: ConcreteDevCardKind[] = [];
    while (remPlayerSlots > 0) {
      const minActionForOthers = totalMinActionNeeded;
      const minActionAfterIfVp = Math.max(0, remPlayerSlots - 1 - (remPlayerMaxVp - 1)) + minActionForOthers;
      const canPickVp = vpCardsLeft > 0 && remPlayerMaxVp > 0 && actionPool.length >= minActionAfterIfVp;

      const minActionAfterIfAction = Math.max(0, remPlayerSlots - 1 - remPlayerMaxVp) + minActionForOthers;
      const canPickAction =
        actionPool.length > 0 &&
        actionPool.length - 1 >= minActionAfterIfAction &&
        vpCardsLeft >= remPlayerSlots - 1 - (actionPool.length - 1 - minActionForOthers);

      if (!canPickVp && !canPickAction) {
        return failDet(
          "dev_conservation_impossible",
          `Could not sample a valid dev card for player '${p.id}' within VP and deck conservation bounds.`,
          { playerId: p.id }
        );
      }

      const vpWeight = canPickVp ? vpCardsLeft : 0;
      const actionWeight = canPickAction ? actionPool.length : 0;
      const pickChoice = rng.weightedIndex([vpWeight, actionWeight]);

      if (pickChoice === 0) {
        sampledCardsForPlayer.push("victoryPoint");
        vpCardsLeft -= 1;
        remPlayerMaxVp -= 1;
      } else {
        const card = actionPool.pop()!;
        sampledCardsForPlayer.push(card);
        remPlayerMinAction = Math.max(0, remPlayerMinAction - 1);
      }
      remPlayerSlots -= 1;
    }

    // Shuffle the player's sampled cards so bought-this-turn vs playable-now assignment is unbiased
    const shuffledPlayerDevs = rng.shuffle(sampledCardsForPlayer);
    for (let i = 0; i < shuffledPlayerDevs.length; i++) {
      const card = shuffledPlayerDevs[i];
      if (card === "victoryPoint") {
        sampledVp += 1;
      } else if (i < uBought) {
        boughtThisTurn.push(card);
      } else {
        ready.push(card);
      }
    }

    if (u > 0) {
      unknownDevsByPlayerId[p.id] = { ready, boughtThisTurn, vp: sampledVp };
    }

    playerDevDiagnostics.push({
      playerId: p.id,
      totalInHand: p.devs.totalInHand,
      confirmedInHand: p.devs.readyActionDevs.length + p.devs.boughtActionDevsThisTurn.length + p.devs.confirmedVpDevs,
      unknownInHand: u,
      unknownPlayableNow: uPlayable,
      unknownBoughtThisTurn: uBought,
      sampledReadyActionDevs: ready,
      sampledBoughtThisTurnActionDevs: boughtThisTurn,
      sampledHiddenVpDevs: sampledVp
    });
  }

  const remainingBankPool: ConcreteDevCardKind[] = [...actionPool];
  for (let i = 0; i < vpCardsLeft; i++) {
    remainingBankPool.push("victoryPoint");
  }
  const devDeckOrder = rng.shuffle(remainingBankPool);

  // Materialize and validate the ConcreteSimulatedGameState
  const matResult = materializeConcreteState(observed, {
    handsByPlayerId,
    unknownDevsByPlayerId,
    devDeckOrder,
    phase,
    turnPlayerId,
    robberHexIndex,
    diceMode: resolvedDiceMode
  });

  if (!matResult.ok) {
    return failDet("invalid_observed_state", matResult.error.message, {
      ...(matResult.error.playerId !== undefined ? { playerId: matResult.error.playerId } : {})
    });
  }

  const concreteValidation = validateConcreteSimState(matResult.state);
  if (!concreteValidation.valid) {
    return failDet(
      "invalid_observed_state",
      `Sampled ConcreteSimulatedGameState failed validation: ${concreteValidation.errors.join("; ")}`
    );
  }

  const diagnostics: DeterminizationDiagnostics = {
    seed: rng.initialSeed,
    resourceSamplingPolicy: policy,
    bankConstraintMode: hasExactBank ? "exact_bank" : "supply_cap_only",
    playerHands: playerHandDiagnostics,
    playerDevs: playerDevDiagnostics,
    sampledBankResources: { ...matResult.state.bank },
    sampledDevDeckRemaining: matResult.state.devDeckOrder.length
  };

  return {
    ok: true,
    state: matResult.state,
    diagnostics
  };
}
