// Recovered from content.js (lines 1715-1725)

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 1831565813) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic 32-bit FNV-1a / Murmur-style avalanche hash for numeric or string seeds.
 * Never depends on global state or Math.random().
 */
export function hashSeed(seed: number | string): number {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) {
      throw new Error(`Invalid non-finite numeric seed: ${String(seed)}`);
    }
    let h = (Math.trunc(seed) >>> 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  if (typeof seed === "string") {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  throw new Error(`Unsupported seed type: ${typeof seed}`);
}

/**
 * Derives a reproducible 32-bit unsigned seed for an independent simulation trial `trialIndex`
 * from `baseSeed` and an optional `salt`, so batch rollout results never depend on execution order.
 */
export function deriveTrialSeed(baseSeed: number | string, trialIndex: number, salt?: number | string): number {
  if (!Number.isInteger(trialIndex) || trialIndex < 0) {
    throw new Error(`Invalid trialIndex: ${String(trialIndex)}. Must be a non-negative integer.`);
  }
  const base = typeof baseSeed === "number" && Number.isFinite(baseSeed) ? Math.trunc(baseSeed) >>> 0 : hashSeed(baseSeed);
  const mixedTrial = Math.imul((trialIndex + 1) >>> 0, 0x9e3779b9) >>> 0;
  const saltHash = salt !== undefined ? hashSeed(salt) : 0x6c62272e;
  return hashSeed((base ^ mixedTrial ^ saltHash) >>> 0);
}

/**
 * Injectable, seeded random-number source for all stochastic simulation operations
 * (hidden-information determinization, dice sampling, robber card-steal resolution, and rollout policy tie-breaking).
 */
export interface SeededRng {
  readonly initialSeed: number;
  readonly state: number;
  /** Returns a finite float in [0, 1). Guaranteed >= 0, < 1, and not NaN. */
  nextFloat(): number;
  /** Returns an unsigned 32-bit integer in [0, 0xFFFFFFFF]. */
  nextUint32(): number;
  /** Returns an integer in [0, maxExclusive - 1]. Throws if maxExclusive <= 0 or non-integer. */
  nextInt(maxExclusive: number): number;
  /** Returns an integer in [minInclusive, maxInclusive]. Throws if minInclusive > maxInclusive or non-integer. */
  nextIntRange(minInclusive: number, maxInclusive: number): number;
  /** Selects a uniformly random element from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /**
   * Samples an index in [0, weights.length - 1] proportional to non-negative finite weights.
   * Throws if weights is empty, contains NaN/negative/infinite values, or sums to <= 0.
   */
  weightedIndex(weights: readonly number[]): number;
  /** Returns a new Fisher-Yates shuffled copy of `items` without mutating the input array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Derives an independent child `SeededRng` deterministically from the current stream and optional salt. */
  fork(salt?: number | string): SeededRng;
  /** Returns an exact copy of this `SeededRng` at its current internal state. */
  clone(): SeededRng;
}

class Mulberry32SeededRng implements SeededRng {
  readonly initialSeed: number;
  private currentState: number;

  constructor(initialSeed: number, currentState: number) {
    this.initialSeed = initialSeed >>> 0;
    this.currentState = currentState >>> 0;
  }

  get state(): number {
    return this.currentState;
  }

  nextUint32(): number {
    this.currentState = (this.currentState + 0x6d2b79f5) >>> 0;
    let t = this.currentState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  nextFloat(): number {
    const u = this.nextUint32() / 4294967296;
    return u >= 1 ? 1 - Number.EPSILON : u < 0 ? 0 : u;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt requires a positive integer maxExclusive, got ${String(maxExclusive)}.`);
    }
    if (maxExclusive === 1) return 0;
    const idx = Math.floor(this.nextFloat() * maxExclusive);
    return idx < 0 ? 0 : idx >= maxExclusive ? maxExclusive - 1 : idx;
  }

  nextIntRange(minInclusive: number, maxInclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxInclusive) || minInclusive > maxInclusive) {
      throw new Error(`Invalid integer range [${String(minInclusive)}, ${String(maxInclusive)}].`);
    }
    const span = maxInclusive - minInclusive + 1;
    return minInclusive + this.nextInt(span);
  }

  pick<T>(items: readonly T[]): T {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Cannot pick from an empty array.");
    }
    return items[this.nextInt(items.length)];
  }

  weightedIndex(weights: readonly number[]): number {
    if (!Array.isArray(weights) || weights.length === 0) {
      throw new Error("weightedIndex requires a non-empty weights array.");
    }
    let total = 0;
    let lastPositiveIndex = -1;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      if (typeof w !== "number" || !Number.isFinite(w) || w < 0) {
        throw new Error(`Invalid weight at index ${i}: ${String(w)}. Weights must be finite and >= 0.`);
      }
      if (w > 0) {
        total += w;
        lastPositiveIndex = i;
      }
    }
    if (total <= 0 || lastPositiveIndex < 0) {
      throw new Error("weightedIndex requires at least one strictly positive weight.");
    }
    const target = this.nextFloat() * total;
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      if (w <= 0) continue;
      acc += w;
      if (target < acc) return i;
    }
    return lastPositiveIndex;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  fork(salt?: number | string): SeededRng {
    const stepWord = this.nextUint32();
    const saltWord = salt !== undefined ? hashSeed(salt) : 0x9e3779b9;
    const childSeed = hashSeed((stepWord ^ saltWord) >>> 0);
    return new Mulberry32SeededRng(childSeed, childSeed);
  }

  clone(): SeededRng {
    return new Mulberry32SeededRng(this.initialSeed, this.currentState);
  }
}

export function createSeededRng(seed: number | string, initialState?: number): SeededRng {
  const normalizedSeed =
    typeof seed === "number" && Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : hashSeed(seed);
  const state = initialState !== undefined ? initialState >>> 0 : normalizedSeed;
  return new Mulberry32SeededRng(normalizedSeed, state);
}

