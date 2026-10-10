import type { SeededRng } from "./rng";
import type { ConcreteSimulatedGameState, ObservedDiceState, ObservedRulesState } from "./state";
import type { ActionOutcome } from "./transition";

export const DICE_SUMS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type DiceSum = (typeof DICE_SUMS)[number];

export type DiceModelId =
  | "standard_fair_2d6"
  | "balanced_24_of_36_shoe_approx"
  | "balanced_stationary_marginal_approx"
  | "unsupported_dice_mode";

export type DiceModelStatus = "exact_validated" | "empirical_approximation" | "unsupported_mode";

export type DiceDistribution = Record<DiceSum, number>;

export const FAIR_2D6_COMBINATION_COUNTS: Readonly<Record<DiceSum, number>> = {
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
  7: 6,
  8: 5,
  9: 4,
  10: 3,
  11: 2,
  12: 1
};

export const FAIR_2D6_PROBABILITIES: Readonly<DiceDistribution> = {
  2: 1 / 36,
  3: 2 / 36,
  4: 3 / 36,
  5: 4 / 36,
  6: 5 / 36,
  7: 6 / 36,
  8: 5 / 36,
  9: 4 / 36,
  10: 3 / 36,
  11: 2 / 36,
  12: 1 / 36
};

/**
 * All 36 ordered (d1, d2) pairs grouped by their sum (2..12).
 * Used to sample valid (d1, d2) die faces that sum to a sampled DiceSum.
 */
const ORDERED_DICE_PAIRS_BY_SUM: Readonly<Record<DiceSum, ReadonlyArray<readonly [number, number]>>> = (() => {
  const bySum = {} as Record<DiceSum, Array<readonly [number, number]>>;
  for (const s of DICE_SUMS) bySum[s] = [];
  for (let d1 = 1; d1 <= 6; d1++) {
    for (let d2 = 1; d2 <= 6; d2++) {
      bySum[(d1 + d2) as DiceSum].push([d1, d2] as const);
    }
  }
  return bySum;
})();

/**
 * Empirical summary from the 53 captured Colonist recordings (`colonist-recordings-2026-10-08.json`),
 * strictly partitioned by game mode and evaluated with recording-level holdouts:
 * - Partition A (1v1 Balanced Dice): 51 games (`diceSetting: 1, modeSetting: 0, maxPlayers: 2, vpToWin: 15`), 3,568 rolls.
 *   Split at the recording level into 35 training games (2,424 rolls) and 16 held-out evaluation games (1,144 rolls).
 * - Partition B (4P Rush Balanced Dice): 2 games (`diceSetting: 1, modeSetting: 12, maxPlayers: 4, vpToWin: 10`), 140 rolls.
 *   Kept strictly separate from 1v1 training and evaluation.
 */
export const COLONIST_1V1_EMPIRICAL_DICE_SUMMARY = {
  datasetName: "colonist-recordings-2026-10-08.json",
  partitions: {
    standard1v1Balanced: {
      gameCount: 51,
      totalRolls: 3568,
      trainGameCount: 35,
      trainRolls: 2424,
      holdoutGameCount: 16,
      holdoutRolls: 1144,
      observedSumCountsAll51: {
        2: 113,
        3: 217,
        4: 313,
        5: 399,
        6: 483,
        7: 557,
        8: 471,
        9: 389,
        10: 325,
        11: 196,
        12: 105
      } as Readonly<Record<DiceSum, number>>,
      observedSumCountsTrain35: {
        2: 75,
        3: 147,
        4: 207,
        5: 277,
        6: 332,
        7: 383,
        8: 319,
        9: 263,
        10: 218,
        11: 132,
        12: 71
      } as Readonly<Record<DiceSum, number>>,
      sevenFrequencyAll51: 557 / 3568,
      fairSevenFrequency: 6 / 36,
      lag1RepeatRateAll51: 0.0742,
      lag2RepeatRateAll51: 0.0565,
      fairRepeatRate: 58 / 518.4, // sum_{s=2..12} (FACE[s]/36)^2 = 146/1296 = 0.112654
      disjoint36RollWindowViolations: { violatingWindows: 91, totalWindows: 128 },
      disjoint24RollWindowViolations: { violatingWindows: 0, totalWindows: 174 },
      holdoutCalibration16Games: {
        standardFair2d6: { nllPerRoll: 2.29546, brierPerRoll: 0.89218 },
        stationaryEmpiricalMarginal: { nllPerRoll: 2.29537, brierPerRoll: 0.89217 },
        balanced24Of36ShoeApprox: { nllPerRoll: 2.18357, brierPerRoll: 0.87673 }
      }
    },
    rush4pBalanced: {
      gameCount: 2,
      totalRolls: 140
    }
  }
} as const;

/**
 * Smoothed stationary empirical marginal distribution fitted ONLY on the 35 training 1v1 games
 * (2,424 rolls + Dirichlet prior of weight 72 centered on fair 2d6).
 */
export const BALANCED_TRAIN_EMPIRICAL_MARGINAL: Readonly<DiceDistribution> = (() => {
  const priorWeight = 72;
  const trainCounts = COLONIST_1V1_EMPIRICAL_DICE_SUMMARY.partitions.standard1v1Balanced.observedSumCountsTrain35;
  const raw = {} as Record<DiceSum, number>;
  let total = 0;
  for (const s of DICE_SUMS) {
    const val = trainCounts[s] + priorWeight * FAIR_2D6_PROBABILITIES[s];
    raw[s] = val;
    total += val;
  }
  const dist = {} as Record<DiceSum, number>;
  for (const s of DICE_SUMS) {
    dist[s] = raw[s] / total;
  }
  return dist;
})();

export interface DiceRollRecord {
  readonly total: number;
  readonly d1?: number;
  readonly d2?: number;
}

export interface DiceModelContext {
  /** Prior rolls observed or simulated in the current game, in chronological order. */
  readonly rollHistory?: ReadonlyArray<number | DiceRollRecord>;
  /**
   * Whether `rollHistory` starts at the very first roll of the game (`"aligned"`).
   * When `"misaligned_midgame"` or `"unknown"`, cyclic shoe models must not assume `rollHistory.length % 24`
   * equals the server's internal shoe position.
   */
  readonly alignmentStatus?: ObservedDiceState["alignmentStatus"];
}

export interface DiceModelDiagnostics {
  readonly modelId: DiceModelId;
  readonly fallbackModelId?: DiceModelId;
  readonly mode: "random" | "balanced" | "unknown";
  readonly status: DiceModelStatus;
  readonly isExact: boolean;
  readonly confidence: "exact" | "provisional_empirical" | "unsupported";
  readonly alignmentUsed: boolean;
  readonly cycleRollsUsed: number;
  readonly bagRemainingInShoe: number | null;
  /**
   * Whether this dice model represents Colonist's documented 1v1 per-player seven-streak /
   * relative seven-distribution balancing (conditioning next-7 probability on which player rolled prior 7s).
   */
  readonly modelsPlayerSevenStreakBalancing: boolean;
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
  readonly trainingDataSummary?: string;
}

export interface DiceDistributionResult {
  readonly ok: boolean;
  readonly probabilities: DiceDistribution;
  readonly diagnostics: DiceModelDiagnostics;
  readonly error?: string;
}

export interface DiceSampleResult {
  readonly ok: boolean;
  readonly outcome?: NonNullable<ActionOutcome["dice"]> & {
    readonly d1: number;
    readonly d2: number;
    readonly total: DiceSum;
  };
  readonly probabilities: DiceDistribution;
  readonly diagnostics: DiceModelDiagnostics;
  readonly error?: string;
}

export interface DiceModel {
  readonly id: DiceModelId;
  readonly mode: "random" | "balanced" | "unknown";
  readonly status: DiceModelStatus;
  /** True ONLY when the model is an exact, mathematically known distribution (`standard_fair_2d6`). */
  readonly isExact: boolean;
  getDistribution(context?: DiceModelContext): DiceDistributionResult;
  sampleOutcome(rng: SeededRng, context?: DiceModelContext): DiceSampleResult;
}

function extractSum(r: number | DiceRollRecord): number {
  return typeof r === "number" ? r : r.total;
}

function normalizeProbabilities(rawWeights: Readonly<Record<DiceSum, number>>): DiceDistribution {
  let sum = 0;
  for (const s of DICE_SUMS) {
    const w = rawWeights[s];
    if (typeof w === "number" && Number.isFinite(w) && w > 0) {
      sum += w;
    }
  }
  if (sum <= 0) {
    return { ...FAIR_2D6_PROBABILITIES };
  }
  const out = {} as DiceDistribution;
  let running = 0;
  for (let i = 0; i < DICE_SUMS.length - 1; i++) {
    const s = DICE_SUMS[i];
    const w = rawWeights[s];
    const p = typeof w === "number" && Number.isFinite(w) && w > 0 ? w / sum : 0;
    out[s] = p;
    running += p;
  }
  out[12] = Math.max(0, 1 - running);
  return out;
}

function sampleDiceOutcomeFromProbabilities(
  rng: SeededRng,
  probabilities: DiceDistribution,
  diagnostics: DiceModelDiagnostics
): DiceSampleResult {
  const weights = DICE_SUMS.map((s) => Math.max(0, probabilities[s] ?? 0));
  const sumIdx = rng.weightedIndex(weights);
  const total = DICE_SUMS[sumIdx];
  const pairs = ORDERED_DICE_PAIRS_BY_SUM[total];
  const [d1, d2] = rng.pick(pairs);
  return {
    ok: true,
    outcome: { d1, d2, total },
    probabilities,
    diagnostics
  };
}

/**
 * Case A: Standard independent fair two-dice distribution (`diceSetting === 0` / `diceMode === "random"`).
 * Status: `exact_validated` (`isExact: true`).
 */
export class StandardFairDiceModel implements DiceModel {
  readonly id: DiceModelId = "standard_fair_2d6";
  readonly mode = "random" as const;
  readonly status: DiceModelStatus = "exact_validated";
  readonly isExact = true;

  getDistribution(_context?: DiceModelContext): DiceDistributionResult {
    const probabilities: DiceDistribution = { ...FAIR_2D6_PROBABILITIES };
    const diagnostics: DiceModelDiagnostics = {
      modelId: this.id,
      mode: this.mode,
      status: this.status,
      isExact: true,
      confidence: "exact",
      alignmentUsed: false,
      cycleRollsUsed: 0,
      bagRemainingInShoe: null,
      modelsPlayerSevenStreakBalancing: false,
      assumptions: ["Two independent, fair six-sided dice (36 equally likely ordered pairs)."],
      limitations: ["Applies only to standard random-dice games (`diceMode === 'random'`), not Colonist Balanced Dice."]
    };
    return {
      ok: true,
      probabilities,
      diagnostics
    };
  }

  sampleOutcome(rng: SeededRng, context?: DiceModelContext): DiceSampleResult {
    const dist = this.getDistribution(context);
    return sampleDiceOutcomeFromProbabilities(rng, dist.probabilities, dist.diagnostics);
  }
}

/**
 * Case B1: Colonist Balanced Dice 24-of-36 cyclic deck shoe empirical approximation.
 * Status: `empirical_approximation` (`isExact: false`).
 *
 * Validated on the 51 recorded 1v1 Balanced Dice games (`3,568` rolls; 35 train / 16 holdout):
 * - Disjoint 36-roll windows violate 36-card deck caps in 91/128 windows (falsifying a full 36-draw deck).
 * - Disjoint 24-roll windows (`rolls[24k .. 24k+23]`) have 0/174 cap violations across all 51 1v1 games (and 0/180 across all 53 recordings).
 * - Achieve held-out NLL = 2.18357 (Brier = 0.87673) vs fair 2d6 NLL = 2.29546 (Brier = 0.89218) on the 16 held-out 1v1 games.
 * - When `alignmentStatus` is not `"aligned"`, falls back to the unaligned repeat-damped empirical distribution
 *   rather than guessing the server's 24-roll cycle offset.
 */
export class Balanced24Of36ShoeDiceModel implements DiceModel {
  readonly id: DiceModelId = "balanced_24_of_36_shoe_approx";
  readonly mode = "balanced" as const;
  readonly status: DiceModelStatus = "empirical_approximation";
  readonly isExact = false;

  private readonly repeatMultiplier: number;
  private readonly lag2Multiplier: number;

  constructor(options?: { repeatMultiplier?: number; lag2Multiplier?: number }) {
    this.repeatMultiplier = options?.repeatMultiplier ?? 0.7;
    this.lag2Multiplier = options?.lag2Multiplier ?? 0.85;
  }

  getDistribution(context?: DiceModelContext): DiceDistributionResult {
    const history = context?.rollHistory ?? [];
    const alignmentStatus = context?.alignmentStatus ?? "aligned";
    const lastSum = history.length >= 1 ? extractSum(history[history.length - 1]) : undefined;
    const prev2Sum = history.length >= 2 ? extractSum(history[history.length - 2]) : undefined;

    if (alignmentStatus === "aligned") {
      const into = history.length % 24;
      const cycleSlice = into === 0 ? [] : history.slice(-into);
      const remaining: Record<DiceSum, number> = { ...FAIR_2D6_COMBINATION_COUNTS };
      let cycleValid = true;
      for (const r of cycleSlice) {
        const s = extractSum(r) as DiceSum;
        if (s < 2 || s > 12 || !Number.isInteger(s)) {
          cycleValid = false;
          break;
        }
        if (remaining[s] <= 0) {
          cycleValid = false;
          break;
        }
        remaining[s] -= 1;
      }

      if (cycleValid) {
        const raw = {} as Record<DiceSum, number>;
        let bagRemaining = 0;
        for (const s of DICE_SUMS) {
          bagRemaining += remaining[s];
          let w = remaining[s];
          if (w > 0 && lastSum === s) {
            w *= this.repeatMultiplier;
          }
          raw[s] = w;
        }
        const probabilities = normalizeProbabilities(raw);
        const diagnostics: DiceModelDiagnostics = {
          modelId: this.id,
          mode: this.mode,
          status: this.status,
          isExact: false,
          confidence: "provisional_empirical",
          alignmentUsed: true,
          cycleRollsUsed: into,
          bagRemainingInShoe: bagRemaining,
          modelsPlayerSevenStreakBalancing: false,
          assumptions: [
            "Models Colonist Balanced Dice as a 36-combination shoe that reshuffles every 24 rolls (12 combinations left at reshuffle).",
            `Applies a ${this.repeatMultiplier}x damping multiplier to immediate consecutive sum repeats when roll history is aligned from turn 0.`
          ],
          limitations: [
            "Server-side Colonist Balanced Dice source code is proprietary; this model is an empirical approximation, not an exact specification.",
            "Requires complete roll history from turn 0 (`alignmentStatus === 'aligned'`) to track the 24-roll shoe phase.",
            "Does not model per-player 1v1 seven-streak or relative seven-distribution balancing (who rolled prior 7s); 7 probability is conditioned only on aggregate roll history."
          ],
          trainingDataSummary:
            "Validated on 51 1v1 Balanced Dice games (35 train [2,424 rolls], 16 holdout [1,144 rolls]): 0/174 24-roll shoe violations, holdout NLL=2.18357 vs 2.29546 for fair 2d6."
        };
        return { ok: true, probabilities, diagnostics };
      }
    }

    // Fallback when roll history is misaligned mid-game or violates a 24-roll shoe cycle:
    // use the training-set empirical marginal with lag-1 / lag-2 repeat damping.
    const raw = {} as Record<DiceSum, number>;
    for (const s of DICE_SUMS) {
      let w = BALANCED_TRAIN_EMPIRICAL_MARGINAL[s];
      if (lastSum === s) w *= this.repeatMultiplier;
      if (prev2Sum === s) w *= this.lag2Multiplier;
      raw[s] = w;
    }
    const probabilities = normalizeProbabilities(raw);
    const diagnostics: DiceModelDiagnostics = {
      modelId: this.id,
      fallbackModelId: "balanced_stationary_marginal_approx",
      mode: this.mode,
      status: this.status,
      isExact: false,
      confidence: "provisional_empirical",
      alignmentUsed: false,
      cycleRollsUsed: 0,
      bagRemainingInShoe: null,
      modelsPlayerSevenStreakBalancing: false,
      assumptions: [
        "Roll history is misaligned or outside a 24-roll shoe cycle; uses stationary 1v1 empirical marginal with lag-1/lag-2 repeat damping."
      ],
      limitations: [
        "Server-side Colonist Balanced Dice algorithm is not publicly specified; mid-game reconnects obscure the 24-roll shoe offset.",
        "Does not model per-player 1v1 seven-streak or relative seven-distribution balancing (who rolled prior 7s); 7 probability is conditioned only on aggregate roll history."
      ],
      trainingDataSummary:
        "Fitted on 35 training 1v1 Balanced Dice games (2,424 rolls) and evaluated on 16 held-out 1v1 games (1,144 rolls)."
    };
    return { ok: true, probabilities, diagnostics };
  }

  sampleOutcome(rng: SeededRng, context?: DiceModelContext): DiceSampleResult {
    const dist = this.getDistribution(context);
    return sampleDiceOutcomeFromProbabilities(rng, dist.probabilities, dist.diagnostics);
  }
}

/**
 * Case B2: Colonist Balanced Dice stationary empirical marginal + short-lag repeat damping approximation.
 * Status: `empirical_approximation` (`isExact: false`).
 *
 * Does not assume a rigid 24-roll cycle boundary; useful both when roll alignment is unavailable
 * and for sensitivity analysis comparing against `Balanced24Of36ShoeDiceModel`.
 */
export class BalancedStationaryMarginalDiceModel implements DiceModel {
  readonly id: DiceModelId = "balanced_stationary_marginal_approx";
  readonly mode = "balanced" as const;
  readonly status: DiceModelStatus = "empirical_approximation";
  readonly isExact = false;

  private readonly lag1Multiplier: number;
  private readonly lag2Multiplier: number;

  constructor(options?: { lag1Multiplier?: number; lag2Multiplier?: number }) {
    this.lag1Multiplier = options?.lag1Multiplier ?? 0.68;
    this.lag2Multiplier = options?.lag2Multiplier ?? 0.78;
  }

  getDistribution(context?: DiceModelContext): DiceDistributionResult {
    const history = context?.rollHistory ?? [];
    const lastSum = history.length >= 1 ? extractSum(history[history.length - 1]) : undefined;
    const prev2Sum = history.length >= 2 ? extractSum(history[history.length - 2]) : undefined;

    const raw = {} as Record<DiceSum, number>;
    for (const s of DICE_SUMS) {
      let w = BALANCED_TRAIN_EMPIRICAL_MARGINAL[s];
      if (lastSum === s) w *= this.lag1Multiplier;
      if (prev2Sum === s) w *= this.lag2Multiplier;
      raw[s] = w;
    }
    const probabilities = normalizeProbabilities(raw);
    const diagnostics: DiceModelDiagnostics = {
      modelId: this.id,
      mode: this.mode,
      status: this.status,
      isExact: false,
      confidence: "provisional_empirical",
      alignmentUsed: false,
      cycleRollsUsed: Math.min(2, history.length),
      bagRemainingInShoe: null,
      modelsPlayerSevenStreakBalancing: false,
      assumptions: [
        "Uses the Dirichlet-smoothed 1v1 empirical marginal distribution from 35 training recordings with lag-1 (0.68x) and lag-2 (0.78x) repeat damping.",
        "Does not depend on a 24-roll shoe reset boundary."
      ],
      limitations: [
        "Empirical approximation only (`isExact: false`); does not capture within-cycle card depletion beyond lag-2 repeat suppression.",
        "Does not model per-player 1v1 seven-streak or relative seven-distribution balancing (who rolled prior 7s); 7 probability is conditioned only on aggregate roll history."
      ],
      trainingDataSummary:
        "Fitted on 35 training 1v1 Balanced Dice games (2,424 rolls; 7s=15.80%, lag-1 repeat=7.42%) and evaluated on 16 held-out 1v1 games (1,144 rolls)."
    };
    return { ok: true, probabilities, diagnostics };
  }

  sampleOutcome(rng: SeededRng, context?: DiceModelContext): DiceSampleResult {
    const dist = this.getDistribution(context);
    return sampleDiceOutcomeFromProbabilities(rng, dist.probabilities, dist.diagnostics);
  }
}

/**
 * Case C: Unsupported or unknown dice mode.
 * Fails closed rather than silently falling back to standard fair 2d6.
 */
export class UnsupportedDiceModel implements DiceModel {
  readonly id: DiceModelId = "unsupported_dice_mode";
  readonly mode = "unknown" as const;
  readonly status: DiceModelStatus = "unsupported_mode";
  readonly isExact = false;
  private readonly reason: string;

  constructor(reason = "Dice mode is unknown or unsupported; select an explicit dice model or approximation.") {
    this.reason = reason;
  }

  getDistribution(_context?: DiceModelContext): DiceDistributionResult {
    const diagnostics: DiceModelDiagnostics = {
      modelId: this.id,
      mode: this.mode,
      status: this.status,
      isExact: false,
      confidence: "unsupported",
      alignmentUsed: false,
      cycleRollsUsed: 0,
      bagRemainingInShoe: null,
      modelsPlayerSevenStreakBalancing: false,
      assumptions: [],
      limitations: [this.reason]
    };
    return {
      ok: false,
      probabilities: { ...FAIR_2D6_PROBABILITIES },
      diagnostics,
      error: this.reason
    };
  }

  sampleOutcome(_rng: SeededRng, context?: DiceModelContext): DiceSampleResult {
    const dist = this.getDistribution(context);
    return {
      ok: false,
      probabilities: dist.probabilities,
      diagnostics: dist.diagnostics,
      error: this.reason
    };
  }
}

export function createDiceModel(modelId: Exclude<DiceModelId, "unsupported_dice_mode">): DiceModel {
  switch (modelId) {
    case "standard_fair_2d6":
      return new StandardFairDiceModel();
    case "balanced_24_of_36_shoe_approx":
      return new Balanced24Of36ShoeDiceModel();
    case "balanced_stationary_marginal_approx":
      return new BalancedStationaryMarginalDiceModel();
  }
}

export interface ResolveDiceModelOptions {
  /**
   * Optional explicit model selection.
   * For `"balanced"` mode, callers can select `"balanced_24_of_36_shoe_approx"` (default)
   * or `"balanced_stationary_marginal_approx"` to compare model sensitivity.
   */
  readonly modelId?: Exclude<DiceModelId, "unsupported_dice_mode">;
  /**
   * Must be set to `true` along with `modelId` to permit simulating a state whose observed
   * `diceMode` is `"unknown"`. Prevents silent fallback to standard fair dice.
   */
  readonly allowApproximationForUnknownMode?: boolean;
}

export function resolveDiceModelForRules(
  diceMode: ObservedRulesState["diceMode"]["mode"] | ConcreteSimulatedGameState["rules"]["diceMode"],
  options?: ResolveDiceModelOptions
):
  | { readonly ok: true; readonly model: DiceModel; readonly error?: undefined }
  | { readonly ok: false; readonly model: UnsupportedDiceModel; readonly error: string } {
  if (diceMode === "random") {
    if (options?.modelId && options.modelId !== "standard_fair_2d6") {
      return {
        ok: true,
        model: createDiceModel(options.modelId)
      };
    }
    return { ok: true, model: new StandardFairDiceModel() };
  }

  if (diceMode === "balanced") {
    const selectedId = options?.modelId ?? "balanced_24_of_36_shoe_approx";
    return { ok: true, model: createDiceModel(selectedId) };
  }

  if (options?.allowApproximationForUnknownMode && options.modelId) {
    return { ok: true, model: createDiceModel(options.modelId) };
  }

  const reason = `Unsupported or unknown diceMode '${String(diceMode)}'. Simulation refuses to silently fall back to standard fair dice; supply an explicit modelId with allowApproximationForUnknownMode: true.`;
  return {
    ok: false,
    model: new UnsupportedDiceModel(reason),
    error: reason
  };
}

export interface EmpiricalRollSequenceStats {
  readonly gameCount: number;
  readonly totalRolls: number;
  readonly sumCounts: Record<DiceSum, number>;
  readonly sumFrequencies: Record<DiceSum, number>;
  readonly sevenFrequency: number;
  readonly lag1RepeatRate: number;
  readonly lag2RepeatRate: number;
  readonly disjoint36WindowViolations: { readonly violatingWindows: number; readonly totalWindows: number };
  readonly disjoint24WindowViolations: { readonly violatingWindows: number; readonly totalWindows: number };
}

export interface HoldoutModelCalibrationResult {
  readonly modelId: string;
  readonly isExact: boolean;
  readonly status: DiceModelStatus;
  readonly rollsEvaluated: number;
  readonly nllPerRoll: number;
  readonly brierPerRoll: number;
}

export function computeRollSequenceStats(games: ReadonlyArray<ReadonlyArray<number>>): EmpiricalRollSequenceStats {
  const sumCounts = {} as Record<DiceSum, number>;
  for (const s of DICE_SUMS) sumCounts[s] = 0;
  let totalRolls = 0;
  let lag1Same = 0;
  let lag1Pairs = 0;
  let lag2Same = 0;
  let lag2Pairs = 0;
  let w36Violations = 0;
  let w36Total = 0;
  let w24Violations = 0;
  let w24Total = 0;

  for (const rolls of games) {
    for (let i = 0; i < rolls.length; i++) {
      const r = rolls[i] as DiceSum;
      if (r >= 2 && r <= 12) {
        sumCounts[r] += 1;
        totalRolls += 1;
      }
      if (i >= 1) {
        lag1Pairs += 1;
        if (rolls[i] === rolls[i - 1]) lag1Same += 1;
      }
      if (i >= 2) {
        lag2Pairs += 1;
        if (rolls[i] === rolls[i - 2]) lag2Same += 1;
      }
    }

    for (let start = 0; start < rolls.length; start += 36) {
      const end = Math.min(rolls.length, start + 36);
      w36Total += 1;
      const counts = {} as Record<DiceSum, number>;
      for (const s of DICE_SUMS) counts[s] = 0;
      let violated = false;
      for (let j = start; j < end; j++) {
        const s = rolls[j] as DiceSum;
        counts[s] += 1;
        if (counts[s] > FAIR_2D6_COMBINATION_COUNTS[s]) {
          violated = true;
          break;
        }
      }
      if (violated) w36Violations += 1;
    }

    for (let start = 0; start < rolls.length; start += 24) {
      const end = Math.min(rolls.length, start + 24);
      w24Total += 1;
      const counts = {} as Record<DiceSum, number>;
      for (const s of DICE_SUMS) counts[s] = 0;
      let violated = false;
      for (let j = start; j < end; j++) {
        const s = rolls[j] as DiceSum;
        counts[s] += 1;
        if (counts[s] > FAIR_2D6_COMBINATION_COUNTS[s]) {
          violated = true;
          break;
        }
      }
      if (violated) w24Violations += 1;
    }
  }

  const sumFrequencies = {} as Record<DiceSum, number>;
  for (const s of DICE_SUMS) {
    sumFrequencies[s] = totalRolls > 0 ? sumCounts[s] / totalRolls : 0;
  }

  return {
    gameCount: games.length,
    totalRolls,
    sumCounts,
    sumFrequencies,
    sevenFrequency: sumFrequencies[7],
    lag1RepeatRate: lag1Pairs > 0 ? lag1Same / lag1Pairs : 0,
    lag2RepeatRate: lag2Pairs > 0 ? lag2Same / lag2Pairs : 0,
    disjoint36WindowViolations: { violatingWindows: w36Violations, totalWindows: w36Total },
    disjoint24WindowViolations: { violatingWindows: w24Violations, totalWindows: w24Total }
  };
}

/**
 * Evaluates a set of DiceModel instances on recording-level held-out games,
 * computing negative log-likelihood (NLL) per roll and multi-class Brier score per roll.
 */
export function evaluateDiceModelsOnHoldoutGames(
  models: readonly DiceModel[],
  holdoutGames: ReadonlyArray<ReadonlyArray<number>>,
  alignmentStatus: ObservedDiceState["alignmentStatus"] = "aligned"
): HoldoutModelCalibrationResult[] {
  return models.map((model) => {
    let nll = 0;
    let brier = 0;
    let rollsEvaluated = 0;

    for (const rolls of holdoutGames) {
      const history: number[] = [];
      for (const r of rolls) {
        const sum = r as DiceSum;
        if (sum < 2 || sum > 12) continue;
        const dist = model.getDistribution({ rollHistory: history, alignmentStatus });
        const p = Math.max(1e-9, dist.probabilities[sum] ?? 1e-9);
        nll += -Math.log(p);
        for (const s of DICE_SUMS) {
          const y = s === sum ? 1 : 0;
          const ps = dist.probabilities[s] ?? 0;
          brier += (ps - y) * (ps - y);
        }
        history.push(sum);
        rollsEvaluated += 1;
      }
    }

    return {
      modelId: model.id,
      isExact: model.isExact,
      status: model.status,
      rollsEvaluated,
      nllPerRoll: rollsEvaluated > 0 ? nll / rollsEvaluated : NaN,
      brierPerRoll: rollsEvaluated > 0 ? brier / rollsEvaluated : NaN
    };
  });
}
