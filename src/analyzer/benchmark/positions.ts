/**
 * Stage 3.5 — Benchmark position construction, feature extraction, and stratification.
 *
 * ADDITIVE / EVALUATION ONLY. Reuses the Stage 3.1–3.2 engine (`getLegalActions`,
 * `findImmediateWinningAction`) rather than reimplementing rules.
 */

import { RESOURCES, type ResourceHand } from "../types";
import type { ConcreteSimulatedGameState, ObservedGameState } from "../engine/state";
import { getLegalActions } from "../engine/transition";
import { findImmediateWinningAction } from "../engine/rollout";
import type {
  BenchmarkPosition,
  BenchmarkPositionFeatures,
  BenchmarkPositionSource,
  BenchmarkStratum
} from "./types";

const VP_TO_WIN_DEFAULT = 15;

function handTotal(h: ResourceHand): number {
  return RESOURCES.reduce((s, r) => s + (h[r] ?? 0), 0);
}

function robberBlocksSelfProduction(state: ConcreteSimulatedGameState, selfId: string): boolean {
  if (state.robberHexIndex < 0) return false;
  const hex = state.topology.hexes[state.robberHexIndex];
  if (!hex) return false;
  return hex.cornerIndices.some((ci) => state.cornerOwner[ci] === selfId);
}

/**
 * Extracts tactical features using ONLY legal engine queries on the concrete state.
 * Never peeks at `devDeckOrder` or opponent hands.
 */
export function extractPositionFeatures(
  state: ConcreteSimulatedGameState,
  selfId: string
): BenchmarkPositionFeatures {
  const self = state.players.find((p) => p.id === selfId) ?? state.players[state.turnPlayerIndex];
  const opponents = state.players.filter((p) => p.id !== selfId);
  const bestOpponentVisibleVp = opponents.reduce((m, p) => Math.max(m, p.visibleVp), 0);
  const bestOpponentRoadLength = opponents.reduce((m, p) => Math.max(m, p.roadLength), 0);
  const bestOpponentKnightsPlayed = opponents.reduce((m, p) => Math.max(m, p.knightsPlayed), 0);
  const legalActions = getLegalActions(state, selfId);

  return {
    phase: state.phase,
    completedTurns: state.completedTurns,
    selfVisibleVp: self.visibleVp,
    bestOpponentVisibleVp,
    visibleVpGap: self.visibleVp - bestOpponentVisibleVp,
    selfHandTotal: handTotal(self.hand),
    selfHand: { ...self.hand },
    legalCityCorners: legalActions.filter((a) => a.type === "buildCity").length,
    legalSettlementCorners: legalActions.filter((a) => a.type === "buildSettlement").length,
    legalRoadEdges: legalActions.filter((a) => a.type === "buildRoad").length,
    hasImmediateWinningAction: findImmediateWinningAction(state, selfId, legalActions) !== undefined,
    robberOnSelfProduction: robberBlocksSelfProduction(state, selfId),
    selfRoadLength: self.roadLength,
    bestOpponentRoadLength,
    selfKnightsPlayed: self.knightsPlayed,
    bestOpponentKnightsPlayed,
    pendingDiscardCount: self.pendingDiscardCount,
    legalActionCount: legalActions.length,
    bankTradeCount: legalActions.filter((a) => a.type === "bankTrade").length
  };
}

/**
 * Assigns every applicable stratum label plus one primary bucket for stratified reporting.
 * A pure function of the extracted features, so classification is reproducible.
 */
export function classifyPosition(features: BenchmarkPositionFeatures): {
  primaryStratum: BenchmarkStratum;
  strata: BenchmarkStratum[];
} {
  const strata: BenchmarkStratum[] = [];
  const vpToWin = VP_TO_WIN_DEFAULT;

  if (features.hasImmediateWinningAction) strata.push("immediate_win_or_urgent_defense");
  else if (
    features.bestOpponentVisibleVp >= vpToWin - 3 &&
    features.visibleVpGap <= 0 &&
    features.phase !== "setup_settlement" &&
    features.phase !== "setup_road"
  ) {
    // Trailing a near-winning opponent is an urgent-defense situation.
    strata.push("immediate_win_or_urgent_defense");
  }

  if (features.phase === "setup_settlement" || features.phase === "setup_road") {
    strata.push("opening_expansion");
  } else if (features.completedTurns >= 8 && features.completedTurns < 24) {
    strata.push("opening_expansion");
  }

  if (features.legalCityCorners > 0) strata.push("city_dev_opportunity");

  if (features.legalSettlementCorners > 0 || features.legalRoadEdges > 0) {
    strata.push("road_settlement_placement");
  }

  if (
    (features.selfRoadLength >= 4 && features.selfRoadLength <= features.bestOpponentRoadLength + 1) ||
    features.bestOpponentRoadLength >= 5 ||
    features.selfKnightsPlayed >= 2 ||
    features.bestOpponentKnightsPlayed >= 3
  ) {
    strata.push("longest_road_largest_army");
  }

  if (features.phase === "robber_move" || features.pendingDiscardCount > 0) {
    strata.push("robber_discard");
  } else if (features.robberOnSelfProduction && features.phase === "main") {
    strata.push("robber_discard");
  }

  if (
    features.completedTurns >= 16 &&
    features.selfHandTotal >= 5 &&
    features.legalCityCorners === 0 &&
    features.legalSettlementCorners === 0
  ) {
    strata.push("midgame_resource_imbalance");
  }

  const priority: BenchmarkStratum[] = [
    "immediate_win_or_urgent_defense",
    "robber_discard",
    "city_dev_opportunity",
    "opening_expansion",
    "longest_road_largest_army",
    "midgame_resource_imbalance",
    "road_settlement_placement",
    "other"
  ];
  const primaryStratum = priority.find((s) => strata.includes(s)) ?? "other";
  // Guarantee at least one label so every position is reportable.
  if (strata.length === 0) strata.push("other");
  return { primaryStratum, strata };
}

/** Deep-clones a concrete state so callers never mutate shared benchmark fixtures. */
export function cloneConcreteState(state: ConcreteSimulatedGameState): ConcreteSimulatedGameState {
  return {
    ...state,
    cornerOwner: [...state.cornerOwner],
    cornerPiece: new Uint8Array(state.cornerPiece),
    edgeOwner: [...state.edgeOwner],
    devDeckOrder: [...state.devDeckOrder],
    players: state.players.map((p) => ({
      ...p,
      hand: { ...p.hand },
      ratios: { ...p.ratios },
      readyDevs: [...p.readyDevs],
      boughtDevsThisTurn: [...p.boughtDevsThisTurn],
      playedDevs: [...p.playedDevs]
    })),
    ...(state.playerOrder ? { playerOrder: [...state.playerOrder] } : {}),
    dice: { ...state.dice },
    rules: { ...state.rules }
  };
}

/**
 * Recomputes VP fields from authoritative board state, mirroring the engine's own invariant
 * (`visibleVp + vpDevs === actualSimulatedVp`). Used after hand-editing a synthetic fixture.
 */
export function recomputePlayerVp(state: ConcreteSimulatedGameState): void {
  const settlements = new Map<string, number>();
  const cities = new Map<string, number>();
  for (let ci = 0; ci < state.topology.corners.length; ci++) {
    const owner = state.cornerOwner[ci];
    if (!owner) continue;
    if (state.cornerPiece[ci] === 1) settlements.set(owner, (settlements.get(owner) ?? 0) + 1);
    else if (state.cornerPiece[ci] === 2) cities.set(owner, (cities.get(owner) ?? 0) + 1);
  }
  for (const p of state.players) {
    const visibleVp =
      (settlements.get(p.id) ?? 0) +
      (cities.get(p.id) ?? 0) * 2 +
      (p.hasLongestRoad ? 2 : 0) +
      (p.hasLargestArmy ? 2 : 0);
    p.visibleVp = visibleVp;
    p.observedConfirmedVp = Math.max(p.observedConfirmedVp, visibleVp);
    p.actualSimulatedVp = visibleVp + p.vpDevs;
  }
}

/** Builds a `BenchmarkPosition` from an already-concrete, fully-determined state. */
export function positionFromConcreteState(options: {
  positionId: string;
  groupId: string;
  source: BenchmarkPositionSource;
  recordingId?: string;
  frameIndex?: number;
  selfId: string;
  concrete: ConcreteSimulatedGameState;
  observed: ObservedGameState;
}): BenchmarkPosition {
  const features = extractPositionFeatures(options.concrete, options.selfId);
  const { primaryStratum, strata } = classifyPosition(features);
  return {
    positionId: options.positionId,
    groupId: options.groupId,
    source: options.source,
    ...(options.recordingId !== undefined ? { recordingId: options.recordingId } : {}),
    ...(options.frameIndex !== undefined ? { frameIndex: options.frameIndex } : {}),
    primaryStratum,
    strata,
    selfId: options.selfId,
    features,
    concrete: options.concrete,
    observed: options.observed
  };
}

