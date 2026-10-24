/**
 * Stage 3.5 — Benchmark corpus construction from captured recordings.
 *
 * ADDITIVE / EVALUATION ONLY. Positions come from the same recording decoding path the existing
 * Stage 3.1–3.4 tests use (`decodeFrames` -> `stateDiffAdapter.parse` -> `buildObservedGameState`),
 * so no second parser or simulator is introduced.
 *
 * IMPORTANT: positions from the same recording are NOT treated as independent games. Every
 * position carries its `recordingId` as `groupId`, and grouped splitting helpers below keep whole
 * recordings on one side of any split.
 */

import { loadRecordingCorpus, recordingsStrict, resolveRecordingCorpusPath } from "../recordings/load";
import type { ResourceHand } from "../types";
import type { ActionDevCardKind, ConcreteDevCardKind, ConcreteSimulatedGameState } from "../engine/state";
import { decodeFrames } from "../decode";
import { stateDiffAdapter } from "../adapters/stateDiff";
import { placementsFrom } from "../advisor";
import { buildObservedGameState } from "../engine/state";
import type { ObservedGameState } from "../engine/state";
import { getLegalActions, materializeConcreteState } from "../engine/transition";
import { createSeededRng } from "../engine/rng";
import { sampleDeterminization } from "../engine/determinize";
import type { DeterminizationResult } from "../engine/determinize";
import type { Recording } from "../../shared/schema";
import {
  classifyPosition,
  cloneConcreteState,
  positionFromConcreteState,
  recomputePlayerVp
} from "./positions";
import type { BenchmarkPosition, BenchmarkStratum } from "./types";

/** Recording IDs referenced by the existing Stage 3.x suite. */
export const KNOWN_RECORDING_IDS: readonly string[] = ["farm9373", "edge9896", "deck7708"];

export const DEFAULT_RECORDINGS_PATH_CANDIDATES: readonly string[] = [
  "fixtures/colonist-recordings.json",
  "colonist-recordings.json"
];

export function resolveRecordingsPath(rootDir: string): string | undefined {
  return resolveRecordingCorpusPath(rootDir);
}

export function loadRecordings(rootDir: string): {
  path: string | undefined;
  recordings: Recording[];
} {
  try {
    const corpus = loadRecordingCorpus(rootDir);
    return { path: corpus.path, recordings: [...corpus.recordings] };
  } catch (error) {
    if (recordingsStrict()) throw error;
    return { path: undefined, recordings: [] };
  }
}

export interface CorpusCoverage {
  readonly recordingsAvailable: boolean;
  readonly recordingsPath?: string;
  readonly recordingsLoaded: number;
  readonly positionsBuilt: number;
  readonly positionsSkipped: number;
  readonly syntheticCasesUsed: number;
  /** True when the corpus had to fall back to synthetic positions. */
  readonly reducedCoverage: boolean;
  readonly coverageNote: string;
  readonly groupIds: readonly string[];
  readonly stratumCounts: Readonly<Record<string, number>>;
}

export interface BenchmarkCorpus {
  readonly positions: readonly BenchmarkPosition[];
  readonly coverage: CorpusCoverage;
  /** Distinct recording groups, so callers can split by group rather than by position. */
  readonly groupIds: readonly string[];
}

/**
 * Builds an `ObservedGameState` for a recording prefix, reusing the existing decode/parse path.
 * Returns undefined when the recording cannot produce a valid observed state.
 */
export function buildObservedFromRecording(
  recording: Recording,
  frameLimit?: number
): { observed: ObservedGameState; selfId: string } | undefined {
  const frames = frameLimit ? recording.frames.slice(0, frameLimit) : recording.frames;
  if (frames.length === 0) return undefined;
  let decoded;
  try {
    decoded = decodeFrames(frames).decoded;
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = stateDiffAdapter.parse(decoded);
  } catch {
    return undefined;
  }
  if (!parsed.board) return undefined;
  const placements = placementsFrom(parsed.events);
  const observed = buildObservedGameState({
    board: parsed.board,
    placements,
    snapshot: parsed.snapshot,
    events: parsed.events,
    selfId: parsed.selfId,
    warnings: parsed.warnings
  });
  const selfId = parsed.selfId ?? observed.selfId ?? observed.playerOrder[0];
  if (!selfId || !observed.playerById[selfId]) return undefined;
  return { observed, selfId };
}

/**
 * Result of materializing a benchmark position. Uses a small local union because
 * `sampleDeterminization` and `materializeConcreteState` have distinct error-code vocabularies.
 */
export type MaterializePositionResult =
  | { readonly ok: true; readonly state: ConcreteSimulatedGameState }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Materializes a fully-determined concrete state for one observed position.
 *
 * Opponent hands and face-down dev cards are sampled once with a fixed seed, so the SAME
 * `sampleSeed` always produces the SAME concrete state. This keeps tactical cases deterministic
 * and reproducible while keeping sampled hidden information strictly inside the simulation layer.
 */
export function materializePosition(
  observed: ObservedGameState,
  sampleSeed: number | string
): MaterializePositionResult {
  const det = sampleDeterminization(
    observed,
    createSeededRng(typeof sampleSeed === "number" ? sampleSeed : hashStringToSeed(sampleSeed)),
    {
      ...(observed.rules.diceMode.mode === "unknown" ? { diceModeOverride: "balanced" as const } : {})
    }
  );
  if (!det.ok) {
    return { ok: false, code: det.error.code, message: det.error.message };
  }

  // Feed the sampled hidden state back through `materializeConcreteState`, which re-validates
  // every invariant and fails closed on anything unresolved.
  const materialized = materializeConcreteState(observed, {
    handsByPlayerId: handsFrom(det.state),
    unknownDevsByPlayerId: devsFrom(det.state),
    devDeckOrder: det.state.devDeckOrder,
    ...(observed.turnPlayerId !== undefined ? { turnPlayerId: observed.turnPlayerId } : {}),
    ...(observed.robberHexIndex !== null ? { robberHexIndex: observed.robberHexIndex } : {}),
    ...(observed.rules.diceMode.mode === "unknown" ? { diceMode: "balanced" as const } : {})
  });
  if (!materialized.ok) {
    return { ok: false, code: materialized.error.code, message: materialized.error.message };
  }
  return { ok: true, state: materialized.state };
}

function hashStringToSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function handsFrom(
  state: ConcreteSimulatedGameState
): Record<string, ResourceHand> {
  const out: Record<string, ResourceHand> = {};
  for (const p of state.players) out[p.id] = { ...p.hand };
  return out;
}

function devsFrom(state: ConcreteSimulatedGameState): Record<
  string,
  { ready: ActionDevCardKind[]; boughtThisTurn: ActionDevCardKind[]; vp: number }
> {
  const out: Record<
    string,
    { ready: ActionDevCardKind[]; boughtThisTurn: ActionDevCardKind[]; vp: number }
  > = {};
  for (const p of state.players) {
    out[p.id] = {
      ready: [...p.readyDevs],
      boughtThisTurn: [...p.boughtDevsThisTurn],
      vp: p.vpDevs
    };
  }
  return out;
}



export interface BuildCorpusOptions {
  /** Fractional prefixes of each recording to sample, e.g. [0.25, 0.5, 0.75, 1]. */
  readonly frameFractions?: readonly number[];
  /** Fixed determinization seed so the corpus is byte-for-byte reproducible. */
  readonly sampleSeed?: number | string;
  /** Only keep positions whose primary stratum is in this set (undefined = keep all). */
  readonly strataFilter?: readonly BenchmarkStratum[];
  /** Only keep positions where it is `selfId`'s turn and the phase is simulatable. */
  readonly requireSelfTurn?: boolean;
}

const SIMULATABLE_PHASES = new Set([
  "setup_settlement",
  "setup_road",
  "pre_roll",
  "main",
  "robber_move",
  "discard",
  "road_building_1",
  "road_building_2",
  "year_of_plenty",
  "monopoly"
]);

/**
 * Builds the offline benchmark corpus from available recordings.
 *
 * Each recording contributes at most one position per requested frame fraction, so positions from
 * the same recording stay grouped under a shared `groupId`. Recordings that cannot be decoded,
 * validated, or materialized are skipped and counted in `positionsSkipped`.
 */
export function buildRecordingCorpus(
  recordings: readonly Recording[],
  options?: BuildCorpusOptions
): BenchmarkCorpus {
  const fractions = options?.frameFractions ?? [0.3, 0.55, 0.8, 1];
  const sampleSeed = options?.sampleSeed ?? "stage-3.5-corpus";
  const requireSelfTurn = options?.requireSelfTurn ?? true;

  const positions: BenchmarkPosition[] = [];
  let positionsSkipped = 0;

  for (const recording of recordings) {
    if (recording.frames.length === 0) {
      positionsSkipped += 1;
      continue;
    }
    for (const fraction of fractions) {
      const frameLimit = Math.max(1, Math.floor(recording.frames.length * fraction));
      const built = buildObservedFromRecording(recording, frameLimit);
      if (!built) {
        positionsSkipped += 1;
        continue;
      }
      const { observed, selfId } = built;

      if (requireSelfTurn && observed.turnPlayerId !== selfId) {
        positionsSkipped += 1;
        continue;
      }
      if (!SIMULATABLE_PHASES.has(observed.phase)) {
        positionsSkipped += 1;
        continue;
      }

      const materialized = materializePosition(observed, sampleSeed);
      if (!materialized.ok) {
        positionsSkipped += 1;
        continue;
      }
      const concrete = cloneConcreteState(materialized.state);
      // Ensure VP fields are consistent with the board before feature extraction.
      recomputePlayerVp(concrete);
      // A recording frame can expose a transient/inconsistent phase snapshot (for example,
      // `main` with dice.thrown=false). Such a state is not simulatable and must not enter the
      // policy corpus as a zero-action position.
      if (getLegalActions(concrete, selfId).length === 0) {
        positionsSkipped += 1;
        continue;
      }

      const position = positionFromConcreteState({
        positionId: `${recording.id}@${frameLimit}`,
        groupId: recording.id,
        source: "recording",
        recordingId: recording.id,
        frameIndex: frameLimit,
        selfId,
        concrete,
        observed
      });

      if (options?.strataFilter && !options.strataFilter.includes(position.primaryStratum)) {
        positionsSkipped += 1;
        continue;
      }
      positions.push(position);
    }
  }

  const groupIds = [...new Set(positions.map((p) => p.groupId))];
  const stratumCounts: Record<string, number> = {};
  for (const p of positions) {
    stratumCounts[p.primaryStratum] = (stratumCounts[p.primaryStratum] ?? 0) + 1;
  }

  return {
    positions,
    groupIds,
    coverage: {
      recordingsAvailable: recordings.length > 0,
      recordingsLoaded: recordings.length,
      positionsBuilt: positions.length,
      positionsSkipped,
      syntheticCasesUsed: 0,
      reducedCoverage: recordings.length === 0,
      coverageNote:
        recordings.length === 0
          ? "No recording dataset was available; the corpus is empty and synthetic cases must be used instead."
          : `Built ${positions.length} position(s) from ${recordings.length} recording(s); ` +
            `${positionsSkipped} candidate position(s) were skipped as unsupported, non-self-turn, or out of stratum.`,
      groupIds,
      stratumCounts
    }
  };
}

/**
 * Groups positions by `groupId` so every recording stays intact. Callers MUST split by group
 * (never by individual position) to avoid leaking the same game across evaluation splits.
 */
export function groupPositionsByRecording(
  positions: readonly BenchmarkPosition[]
): Map<string, BenchmarkPosition[]> {
  const out = new Map<string, BenchmarkPosition[]>();
  for (const p of positions) {
    const list = out.get(p.groupId);
    if (list) list.push(p);
    else out.set(p.groupId, [p]);
  }
  return out;
}

/** True when the corpus has at least one position in each requested stratum. */
export function hasFullStratumCoverage(
  corpus: BenchmarkCorpus,
  strata: readonly BenchmarkStratum[]
): { covered: boolean; missing: readonly BenchmarkStratum[] } {
  const present = new Set(corpus.positions.map((p) => p.primaryStratum));
  const missing = strata.filter((s) => !present.has(s));
  return { covered: missing.length === 0, missing };
}
