import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { decodeFrames } from "../src/analyzer/decode";
import { stateDiffAdapter } from "../src/analyzer/adapters/stateDiff";
import { placementsFrom } from "../src/analyzer/advisor";
import { HandTracker } from "../src/analyzer/tracker";
import { LogParser } from "../src/analyzer/adapters/logText";
import { networkLength } from "../src/analyzer/engine/roads";
import {
  buildBoardTopology,
  getBoardTopology,
  STANDARD_COLONIST_CORNER_AT_BY_ID,
  STANDARD_COLONIST_EDGE_AT_BY_ID
} from "../src/analyzer/engine/topology";
import {
  buildObservedGameState,
  classifyTurnPhase,
  cloneConcreteSimState,
  cloneObservedGameState,
  validateConcreteSimState,
  validateObservedState,
  type ConcreteSimulatedGameState
} from "../src/analyzer/engine/state";
import {
  applyAction,
  createInitialConcreteState,
  getEligibleRobberVictims,
  getLegalActions,
  getLegalCityCorners,
  getLegalRoadEdges,
  getLegalRobberMoves,
  getLegalSettlementCorners,
  getLegalSetupRoadEdges,
  getLegalSetupSettlementCorners,
  isActionLegal,
  materializeConcreteState,
  updateLargestArmyAward,
  updateLongestRoadAward,
  type ActionOutcome,
  type SimulatedAction
} from "../src/analyzer/engine/transition";
import { createSeededRng, deriveTrialSeed, hashSeed } from "../src/analyzer/engine/rng";
import {
  Balanced24Of36ShoeDiceModel,
  BalancedStationaryMarginalDiceModel,
  COLONIST_1V1_EMPIRICAL_DICE_SUMMARY,
  computeRollSequenceStats,
  createDiceModel,
  DICE_SUMS,
  evaluateDiceModelsOnHoldoutGames,
  FAIR_2D6_COMBINATION_COUNTS,
  FAIR_2D6_PROBABILITIES,
  resolveDiceModelForRules,
  StandardFairDiceModel,
  UnsupportedDiceModel
} from "../src/analyzer/engine/diceModel";
import { sampleDeterminization } from "../src/analyzer/engine/determinize";
import {
  baselineRolloutPolicy,
  findImmediateWinningAction,
  runDeterminizedRollouts,
  runRollout,
  type RolloutPolicy
} from "../src/analyzer/engine/rollout";
import {
  buildOpeningCandidatesFromPlan,
  buildRobberCandidatesFromTargets,
  checkShadowEngineSupport,
  computeWilson95Interval,
  evaluateCandidatesShadow,
  evaluateOpeningShadow,
  evaluateRobberTargetsShadow,
  mapLegacyCandidateToSimulatedAction,
  reconstructObservedStateForShadow,
  type LegacyRecommendationCandidate
} from "../src/analyzer/engine/shadow";
import { planTurn } from "../src/analyzer/engine/decide";
import { coachedOpening } from "../src/analyzer/engine/opening";
import { robberTargets } from "../src/analyzer/advisor";
import { createHelper } from "../src/extension/helper";
import type { Recording } from "../src/shared/schema";

const RECORDINGS_PATH =
  process.env.COLONIST_RECORDINGS_PATH ??
  [resolve(__dirname, "../fixtures/colonist-recordings.json"), resolve(__dirname, "../colonist-recordings.json")].find(
    (path) => existsSync(path)
  );
const recordingsAvailable = RECORDINGS_PATH !== undefined && existsSync(RECORDINGS_PATH);

function loadRecordings(): Recording[] {
  if (!RECORDINGS_PATH || !existsSync(RECORDINGS_PATH)) return [];
  const raw = JSON.parse(readFileSync(RECORDINGS_PATH, "utf8")) as { recordings: Recording[] };
  return raw.recordings;
}

describe("Stage 3.1 — Board Topology & Canonical Observed State Reconstruction", () => {
  const recordings = loadRecordings();

  describe("1. BoardTopology Construction, Reciprocal Adjacency & Colonist ID Mapping", () => {
    it.skipIf(!recordingsAvailable)("constructs complete 19-hex, 54-corner, 72-edge, 9-port topology with reciprocal adjacency and cached lookup (recording fixture required)", () => {
      const farm = recordings.find((r) => r.id === "farm9373")!;
      const parsed = stateDiffAdapter.parse(decodeFrames(farm.frames).decoded);
      const board = parsed.board!;

      const topo = buildBoardTopology(board);
      expect(topo.hexes.length).toBe(19);
      expect(topo.corners.length).toBe(54);
      expect(topo.edges.length).toBe(72);
      expect(topo.ports.length).toBe(9);
      expect(topo.colonistIdsSource).toBe("board");

      // Verify WeakMap caching returns the exact same instance
      expect(getBoardTopology(board)).toBe(getBoardTopology(board));

      // Verify every hex has 6 corners and 6 edges
      for (const hex of topo.hexes) {
        expect(hex.cornerIndices.length).toBe(6);
        expect(hex.edgeIndices.length).toBe(6);
        expect(topo.hexIndexByColonistId.get(hex.colonistId)).toBe(hex.index);
        expect(topo.colonistIdByHexIndex[hex.index]).toBe(hex.colonistId);
        expect(topo.hexIndexByCoord.get(hex.coordKey)).toBe(hex.index);
        if (hex.number !== null) {
          expect(topo.hexIndicesByDiceNumber.get(hex.number)).toContain(hex.index);
        }
      }

      // Verify reciprocal corner adjacency and consistent corner-edge connectivity
      for (const corner of topo.corners) {
        expect(corner.adjacentCornerIndices.length).toBeGreaterThanOrEqual(2);
        expect(corner.adjacentCornerIndices.length).toBeLessThanOrEqual(3);
        expect(corner.incidentEdgeIndices.length).toBe(corner.adjacentCornerIndices.length);
        expect(corner.hexIndices.length).toBeGreaterThanOrEqual(1);
        expect(corner.hexIndices.length).toBeLessThanOrEqual(3);

        for (let k = 0; k < corner.adjacentCornerIndices.length; k++) {
          const nbrIdx = corner.adjacentCornerIndices[k];
          const edgeIdx = corner.incidentEdgeIndices[k];
          const nbr = topo.corners[nbrIdx];
          expect(nbr.adjacentCornerIndices).toContain(corner.index);
          expect(topo.edgeIndexBetweenCorners(corner.index, nbrIdx)).toBe(edgeIdx);
          expect(topo.otherCornerOfEdge(edgeIdx, corner.index)).toBe(nbrIdx);
          expect(topo.otherCornerOfEdge(edgeIdx, nbrIdx)).toBe(corner.index);
        }
      }

      // Verify every edge connects two distinct adjacent corners and touches 1 or 2 land hexes
      for (const edge of topo.edges) {
        expect(edge.c1).toBeLessThan(edge.c2);
        expect(topo.corners[edge.c1].incidentEdgeIndices).toContain(edge.index);
        expect(topo.corners[edge.c2].incidentEdgeIndices).toContain(edge.index);
        expect(edge.hexIndices.length).toBeGreaterThanOrEqual(1);
        expect(edge.hexIndices.length).toBeLessThanOrEqual(2);
      }

      // Verify every port maps to 2 valid coastal corners and an edge index
      for (const port of topo.ports) {
        const [c1, c2] = port.cornerIndices;
        expect(topo.corners[c1].port).toBe(port.kind);
        expect(topo.corners[c2].port).toBe(port.kind);
        expect(port.edgeIndex).toBeDefined();
      }
    });

    it.skipIf(!recordingsAvailable)("preserves original Colonist corner, edge, and hex IDs distinctly from internal array indices (recording fixture required)", () => {
      const farm = recordings.find((r) => r.id === "farm9373")!;
      const parsed = stateDiffAdapter.parse(decodeFrames(farm.frames).decoded);
      const topo = getBoardTopology(parsed.board!);

      // Prove that internal edge array indices are NOT identical to Colonist numeric edge IDs
      const differingEdges = topo.edges.filter((e) => String(e.index) !== e.colonistId);
      expect(differingEdges.length).toBeGreaterThan(20);

      // Prove that even when board.hexes is in a different order (so internal hex and corner indices shift),
      // Colonist hex, corner, and edge IDs remain preserved and map back to the exact geometric coordinates
      const reorderedTopo = buildBoardTopology({
        ...parsed.board!,
        hexes: [...parsed.board!.hexes].reverse()
      });
      const differingCornersOnReordered = reorderedTopo.corners.filter((c) => String(c.index) !== c.colonistId);
      expect(differingCornersOnReordered.length).toBeGreaterThan(20);

      // Verify all 54 Colonist corner IDs ("0".."53") map to their exact geometric coordinates on both topologies
      for (const t of [topo, reorderedTopo]) {
        expect(t.cornerIndexByColonistId.size).toBe(54);
        for (const [colId, expectedAt] of Object.entries(STANDARD_COLONIST_CORNER_AT_BY_ID)) {
          const idx = t.cornerIndexByColonistId.get(colId);
          expect(idx).toBeDefined();
          expect(t.corners[idx!].colonistId).toBe(colId);
          expect(t.corners[idx!].at).toBe(expectedAt);
          expect(t.colonistIdByCornerIndex[idx!]).toBe(colId);
        }

        // Verify all 72 Colonist edge IDs ("0".."71") map to their exact geometric coordinates
        expect(t.edgeIndexByColonistId.size).toBe(72);
        for (const [colId, expectedAt] of Object.entries(STANDARD_COLONIST_EDGE_AT_BY_ID)) {
          const idx = t.edgeIndexByColonistId.get(colId);
          expect(idx).toBeDefined();
          expect(t.edges[idx!].colonistId).toBe(colId);
          expect(t.edges[idx!].at).toBe(expectedAt);
          expect(t.colonistIdByEdgeIndex[idx!]).toBe(colId);
        }
      }
    });
  });

  describe("2. Canonical Observed State Reconstruction & Confidence Boundaries", () => {
    it.skipIf(!recordingsAvailable)("reconstructs placements, road lengths, public/hidden VP, and uncertain opponent state on edge9896, farm9373, and deck7708 (recording fixture required)", () => {
      // 1. edge9896: self (c5) has 8 visible VP + 0 hidden VP; opponent (c1) has 14 visible VP + 0 confirmed hidden VP + 2 unknown devs (maxPossibleVp = 16)
      const edgeRec = recordings.find((r) => r.id === "edge9896")!;
      const edgeParsed = stateDiffAdapter.parse(decodeFrames(edgeRec.frames).decoded);
      const edgePlacements = placementsFrom(edgeParsed.events);
      const edgeState = buildObservedGameState({
        board: edgeParsed.board!,
        placements: edgePlacements,
        snapshot: edgeParsed.snapshot,
        events: edgeParsed.events,
        selfId: edgeParsed.selfId,
        warnings: edgeParsed.warnings
      });

      const edgeVal = validateObservedState(edgeState);
      expect(edgeVal.valid, edgeVal.errors.join("; ")).toBe(true);

      const edgeSelf = edgeState.playerById["c5"];
      const edgeOpp = edgeState.playerById["c1"];
      expect(edgeSelf.vp.visibleVp).toBe(8);
      expect(edgeSelf.vp.confirmedHiddenVp).toBe(0);
      expect(edgeSelf.vp.totalConfirmedVp).toBe(8);
      expect(edgeSelf.devs.unknownInHand).toBe(0);
      expect(edgeOpp.vp.visibleVp).toBe(14);
      expect(edgeOpp.vp.confirmedHiddenVp).toBe(0);
      expect(edgeOpp.vp.totalConfirmedVp).toBe(14);
      expect(edgeOpp.devs.unknownInHand).toBe(2);
      expect(edgeOpp.vp.maxUnrevealedVpDevs).toBe(2);
      expect(edgeOpp.vp.maxPossibleVp).toBe(16);

      // Verify road lengths match roads.ts networkLength
      expect(edgeSelf.awards.computedRoadLength).toBe(networkLength(edgeParsed.board!, edgePlacements, "c5"));
      expect(edgeOpp.awards.computedRoadLength).toBe(networkLength(edgeParsed.board!, edgePlacements, "c1"));

      // 2. farm9373: opponent (c1) holds 2 face-down dev cards (ID 10); verify they remain unknown and are not fabricated into confirmed VP
      const farmRec = recordings.find((r) => r.id === "farm9373")!;
      const farmParsed = stateDiffAdapter.parse(decodeFrames(farmRec.frames).decoded);
      const farmPlacements = placementsFrom(farmParsed.events);
      const farmParser = new LogParser(farmRec.meta.me);
      const farmTracker = new HandTracker();
      for (const row of farmRec.log) {
        if (!row.text) continue;
        const r = farmParser.push(row);
        if (r.kind === "event") farmTracker.apply(r.event);
      }
      const oppView = farmTracker.views().find((v) => v.name !== farmRec.meta.me);

      const farmState = buildObservedGameState({
        board: farmParsed.board!,
        placements: farmPlacements,
        snapshot: farmParsed.snapshot,
        events: farmParsed.events,
        selfId: farmParsed.selfId,
        oppHandView: oppView,
        warnings: farmParsed.warnings
      });
      const farmVal = validateObservedState(farmState);
      expect(farmVal.valid, farmVal.errors.join("; ")).toBe(true);

      const farmSelf = farmState.playerById["c5"];
      const farmOpp = farmState.playerById["c1"];
      expect(farmSelf.devs.confirmedVpDevs).toBe(1);
      expect(farmSelf.devs.unknownInHand).toBe(0);
      expect(farmSelf.devs.confidence).toBe("exact");
      expect(farmSelf.hand.confidence).toBe("exact");
      expect(farmSelf.hand.inferenceSource).toBe("authoritative");
      expect(farmSelf.hand.exact).not.toBeNull();

      expect(farmOpp.devs.totalInHand).toBe(2);
      expect(farmOpp.devs.unknownInHand).toBe(2);
      expect(farmOpp.devs.confirmedVpDevs).toBe(0);
      expect(farmOpp.devs.confidence).toBe("partial_unknown_faces");
      expect(farmOpp.vp.visibleVp).toBe(14);
      expect(farmOpp.vp.confirmedHiddenVp).toBe(0);
      expect(farmOpp.vp.totalConfirmedVp).toBe(14);
      expect(farmOpp.vp.maxUnrevealedVpDevs).toBe(2);
      expect(farmOpp.vp.maxPossibleVp).toBe(16);

      // Even when HandTracker has 0 unknown cards from log events, an opponent's hand is an INFERENCE
      // (inferenceSource: "hand_tracker"), never promoted into a directly observed `exact` hand (`exact === null`).
      expect(farmOpp.hand.exact).toBeNull();
      expect(farmOpp.hand.inferenceSource).toBe("hand_tracker");
      expect(farmOpp.hand.confidence).toBe("bounded");
      expect(farmOpp.hand.handSize).toBe(7);

      // Verify opponent resource hand also remains uncertain (exact === null, inferenceSource: "table_read")
      // when reconstructed from WebSocket state + events alone, or when HandTracker has unknown steals
      const farmWsOnlyState = buildObservedGameState({
        board: farmParsed.board!,
        placements: farmPlacements,
        snapshot: farmParsed.snapshot,
        events: farmParsed.events,
        selfId: farmParsed.selfId,
        warnings: farmParsed.warnings
      });
      const farmWsOpp = farmWsOnlyState.playerById["c1"];
      expect(farmWsOpp.hand.exact).toBeNull();
      expect(farmWsOpp.hand.handSize).toBe(7);
      expect(farmWsOpp.hand.unknownCount).toBe(7);
      expect(farmWsOpp.hand.confidence).toBe("bounded");
      expect(farmWsOpp.hand.inferenceSource).toBe("table_read");

      // When HandTracker has an unattributed/unknown steal, exact must also remain null with unknownCount = 2
      const uncertainTracker = HandTracker.restore(farmTracker.toJSON());
      const oppName = oppView!.name;
      uncertainTracker.ensure(oppName).unknown = 2;
      uncertainTracker.ensure(oppName).hand.brick = Math.max(0, uncertainTracker.ensure(oppName).hand.brick - 2);
      const uncertainOppState = buildObservedGameState({
        board: farmParsed.board!,
        placements: farmPlacements,
        snapshot: farmParsed.snapshot,
        events: farmParsed.events,
        selfId: farmParsed.selfId,
        oppHandView: uncertainTracker.view(oppName),
        warnings: farmParsed.warnings
      });
      expect(validateObservedState(uncertainOppState).valid).toBe(true);
      expect(uncertainOppState.playerById["c1"].hand.exact).toBeNull();
      expect(uncertainOppState.playerById["c1"].hand.unknownCount).toBe(2);
      expect(uncertainOppState.playerById["c1"].hand.confidence).toBe("bounded");

      // 3. deck7708: self (c5) holds 3 confirmed hidden VP dev cards (12 visible + 3 hidden = 15 totalConfirmedVp); opponent (c1) has 10 visible + 1 unknown dev
      const deckRec = recordings.find((r) => r.id === "deck7708")!;
      const deckParsed = stateDiffAdapter.parse(decodeFrames(deckRec.frames).decoded);
      const deckPlacements = placementsFrom(deckParsed.events);
      const deckState = buildObservedGameState({
        board: deckParsed.board!,
        placements: deckPlacements,
        snapshot: deckParsed.snapshot,
        events: deckParsed.events,
        selfId: deckParsed.selfId,
        warnings: deckParsed.warnings
      });
      expect(validateObservedState(deckState).valid).toBe(true);
      expect(deckState.playerById["c5"].vp).toMatchObject({
        visibleVp: 12,
        confirmedHiddenVp: 3,
        totalConfirmedVp: 15
      });
      expect(deckState.playerById["c1"].vp).toMatchObject({
        visibleVp: 10,
        confirmedHiddenVp: 0,
        totalConfirmedVp: 10,
        maxUnrevealedVpDevs: 1,
        maxPossibleVp: 11
      });
    });

    it.skipIf(!recordingsAvailable)("preserves authoritative gameSettings, distinguishes defaults and unknown values, and refuses to map unrecognized phases to main (recording fixture required)", () => {
      const farmRec = recordings.find((r) => r.id === "farm9373")!;
      const farmParsed = stateDiffAdapter.parse(decodeFrames(farmRec.frames).decoded);
      const farmPlacements = placementsFrom(farmParsed.events);

      const state = buildObservedGameState({
        board: farmParsed.board!,
        placements: farmPlacements,
        snapshot: farmParsed.snapshot,
        events: farmParsed.events,
        selfId: farmParsed.selfId
      });

      expect(state.topology.variant).toEqual({
        hexCount: 19,
        cornerCount: 54,
        edgeCount: 72,
        portCount: 9,
        isStandard19Hex: true
      });
      expect(state.rules.maxPlayers).toEqual({ value: 2, source: "authoritative" });
      expect(state.rules.victoryPointsToWin).toEqual({ value: 15, source: "authoritative" });
      expect(state.rules.cardDiscardLimit).toEqual({ value: 9, source: "authoritative" });
      expect(state.rules.friendlyRobber).toEqual({ value: true, minVisibleVp: 3, source: "authoritative" });
      expect(state.rules.hideBankCards).toEqual({ value: true, source: "authoritative" });
      expect(state.rules.diceMode).toEqual({ setting: 1, mode: "balanced", source: "authoritative" });
      expect(state.dice.alignmentStatus).toBe("aligned");
      expect(state.dice.distributionConfidence).toBe("approximate_heuristic");

      // When snapshot has no gameSettings, rules fall back to explicit "default" / "unknown" sources
      const noSettingsState = buildObservedGameState({
        board: farmParsed.board!,
        placements: farmPlacements
      });
      expect(noSettingsState.rules.maxPlayers).toEqual({ value: 2, source: "default" });
      expect(noSettingsState.rules.victoryPointsToWin).toEqual({ value: 15, source: "default" });
      expect(noSettingsState.rules.cardDiscardLimit).toEqual({ value: 9, source: "default" });
      expect(noSettingsState.rules.diceMode).toEqual({ setting: undefined, mode: "unknown", source: "unknown" });
      expect(noSettingsState.phase).toBe("unknown");
      expect(noSettingsState.phaseConfidence).toBe("missing");

      // Verify phase classification across known and unrecognized (turnState, actionState) pairs
      expect(classifyTurnPhase(0, 1)).toEqual({ phase: "setup_settlement", confidence: "authoritative" });
      expect(classifyTurnPhase(0, 3)).toEqual({ phase: "setup_road", confidence: "authoritative" });
      expect(classifyTurnPhase(1, 0)).toEqual({ phase: "pre_roll", confidence: "authoritative" });
      expect(classifyTurnPhase(1, 24)).toEqual({ phase: "robber_move", confidence: "authoritative" });
      expect(classifyTurnPhase(1, 28)).toEqual({ phase: "discard", confidence: "authoritative" });
      expect(classifyTurnPhase(1, 30)).toEqual({ phase: "road_building_1", confidence: "authoritative" });
      expect(classifyTurnPhase(1, 32)).toEqual({ phase: "year_of_plenty", confidence: "authoritative" });
      expect(classifyTurnPhase(2, 0)).toEqual({ phase: "main", confidence: "authoritative" });
      expect(classifyTurnPhase(2, 31)).toEqual({ phase: "road_building_2", confidence: "authoritative" });
      expect(classifyTurnPhase(2, 33)).toEqual({ phase: "monopoly", confidence: "authoritative" });
      expect(classifyTurnPhase(3, 0)).toEqual({ phase: "game_over", confidence: "authoritative" });

      // Unrecognized numeric states must map to "unknown" with "unrecognized" confidence, NEVER "main"
      expect(classifyTurnPhase(2, 99)).toEqual({ phase: "unknown", confidence: "unrecognized" });
      expect(classifyTurnPhase(1, 99)).toEqual({ phase: "unknown", confidence: "unrecognized" });
      expect(classifyTurnPhase(9, 0)).toEqual({ phase: "unknown", confidence: "unrecognized" });
    });

    it.skipIf(!recordingsAvailable)("handles mid-game or incomplete observations without fabricating exact state and separates observed vs concrete simulation validation (recording fixture required)", () => {
      const farmRec = recordings.find((r) => r.id === "farm9373")!;
      const farmParsed = stateDiffAdapter.parse(decodeFrames(farmRec.frames).decoded);
      const farmPlacements = placementsFrom(farmParsed.events);

      const midgameState = buildObservedGameState({
        board: farmParsed.board!,
        placements: farmPlacements,
        events: farmParsed.events.slice(-10),
        warnings: ["Recording appears to start mid-game; earlier moves are missing."]
      });

      expect(midgameState.provenance.fullGameFromStart).toBe(false);
      expect(midgameState.dice.alignmentStatus).toBe("misaligned_midgame");
      expect(midgameState.dice.distributionConfidence).toBe("unaligned_prior");
      expect(midgameState.bank.resources).toBeNull();
      expect(midgameState.bank.confidence).toBe("unknown");
      expect(midgameState.players[0].supplies.confidence).toBe("partial_midgame");
      expect(midgameState.players[0].hand.exact).toBeNull();
      expect(validateObservedState(midgameState).valid).toBe(true);

      // Verify ConcreteSimulatedGameState strict validator enforces exact 19-resource and 25-dev conservation
      // and distinguishes observedConfirmedVp from actualSimulatedVp
      const topo = midgameState.topology;
      const simState: ConcreteSimulatedGameState = {
        kind: "simulated",
        topology: topo,
        cornerOwner: new Array(topo.corners.length).fill(null),
        cornerPiece: new Uint8Array(topo.corners.length),
        edgeOwner: new Array(topo.edges.length).fill(null),
        robberHexIndex: 0,
        bank: { lumber: 17, brick: 18, wool: 18, grain: 18, ore: 18 },
        devDeckOrder: new Array(23).fill("knight"),
        players: [
          {
            id: "c1",
            hand: { lumber: 1, brick: 1, wool: 0, grain: 0, ore: 0 },
            ratios: { lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 },
            settlementsLeft: 3,
            citiesLeft: 4,
            roadsLeft: 13,
            readyDevs: [],
            boughtDevsThisTurn: [],
            vpDevs: 0,
            playedDevs: [],
            knightsPlayed: 0,
            hasUsedDevThisTurn: false,
            hasLongestRoad: false,
            hasLargestArmy: false,
            roadLength: 2,
            visibleVp: 2,
            observedConfirmedVp: 2,
            actualSimulatedVp: 2,
            pendingDiscardCount: 0
          },
          {
            id: "c2",
            hand: { lumber: 1, brick: 0, wool: 1, grain: 1, ore: 1 },
            ratios: { lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 },
            settlementsLeft: 3,
            citiesLeft: 4,
            roadsLeft: 13,
            readyDevs: ["knight"],
            boughtDevsThisTurn: [],
            vpDevs: 1, // Sampled hidden VP dev card from opponent's unknownDevsInHand
            playedDevs: [],
            knightsPlayed: 0,
            hasUsedDevThisTurn: false,
            hasLongestRoad: false,
            hasLargestArmy: false,
            roadLength: 2,
            visibleVp: 2,
            observedConfirmedVp: 2, // Live observer only knows 2 VP
            actualSimulatedVp: 3, // Simulated trial tracks 3 VP (2 visible + 1 sampled VP dev)
            pendingDiscardCount: 0
          }
        ],
        turnPlayerIndex: 0,
        phase: "main",
        completedTurns: 4,
        dice: { thrown: true, d1: 3, d2: 5, total: 8 },
        rules: {
          victoryPointsToWin: 15,
          cardDiscardLimit: 9,
          friendlyRobber: true,
          friendlyRobberMinVisibleVp: 3,
          diceMode: "balanced"
        }
      };
      expect(validateConcreteSimState(simState).valid).toBe(true);

      // Corrupting resource conservation in ConcreteSimulatedGameState is caught immediately
      simState.bank.lumber = 18;
      expect(validateConcreteSimState(simState).valid).toBe(false);
    });

    it.skipIf(!recordingsAvailable)("supports 2–6 player seat order structurally and preserves boundaries for adaptive behavior telemetry, imperfect priors, and observed trades (recording fixture required)", () => {
      const farmRec = recordings.find((r) => r.id === "farm9373")!;
      const farmParsed = stateDiffAdapter.parse(decodeFrames(farmRec.frames).decoded);

      const multiState = buildObservedGameState({
        board: farmParsed.board!,
        placements: {
          settlements: new Map([
            ["0,-2,0", "c1"],
            ["-2,1,0", "c2"],
            ["2,0,0", "c3"],
            ["0,2,0", "c4"]
          ]),
          cities: new Map(),
          roads: new Map([
            ["0,-2,0", "c1"],
            ["-2,1,0", "c2"],
            ["2,0,0", "c3"],
            ["0,2,0", "c4"]
          ])
        },
        players: [
          { id: "c1", name: "Alice", color: 1 },
          { id: "c2", name: "Bob", color: 2 },
          { id: "c3", name: "Carol", color: 3 },
          { id: "c4", name: "Dave", color: 4 }
        ],
        selfId: "c1",
        selfHand: { lumber: 1, brick: 1, wool: 0, grain: 1, ore: 0 },
        snapshot: {
          players: [
            { id: "c1", vp: 1, visibleVp: 1, hiddenVp: 0, handSize: 3, ratios: {}, roadLength: 1, hasLongestRoad: false, army: 0, hasLargestArmy: false, devsInHand: 0, unknownDevsInHand: 0, devsPlayed: 0, knights: 0, settlementsLeft: 4, citiesLeft: 4, roadsLeft: 14 },
            { id: "c2", vp: 1, visibleVp: 1, hiddenVp: 0, handSize: 2, ratios: {}, roadLength: 1, hasLongestRoad: false, army: 0, hasLargestArmy: false, devsInHand: 1, unknownDevsInHand: 1, devsPlayed: 0, knights: 0, settlementsLeft: 4, citiesLeft: 4, roadsLeft: 14 },
            { id: "c3", vp: 1, visibleVp: 1, hiddenVp: 0, handSize: 1, ratios: {}, roadLength: 1, hasLongestRoad: false, army: 0, hasLargestArmy: false, devsInHand: 0, unknownDevsInHand: 0, devsPlayed: 0, knights: 0, settlementsLeft: 4, citiesLeft: 4, roadsLeft: 14 },
            { id: "c4", vp: 1, visibleVp: 1, hiddenVp: 0, handSize: 0, ratios: {}, roadLength: 1, hasLongestRoad: false, army: 0, hasLargestArmy: false, devsInHand: 0, unknownDevsInHand: 0, devsPlayed: 0, knights: 0, settlementsLeft: 4, citiesLeft: 4, roadsLeft: 14 }
          ],
          turnPlayer: "c3",
          turnState: 2,
          actionState: 0,
          completedTurns: 9,
          gameSettings: { maxPlayers: 4, victoryPointsToWin: 10, cardDiscardLimit: 7 }
        },
        events: [
          { type: "roll", player: "c1", d1: 3, d2: 5, total: 8, t: 1, turn: 1 },
          { type: "trade", player: "c2", partner: "c3", gave: { lumber: 1 }, got: { ore: 1 }, t: 2, turn: 1 },
          { type: "bankTrade", player: "c1", gave: { grain: 4 }, got: { brick: 1 }, t: 3, turn: 1 }
        ],
        opponentPriorsByPlayer: {
          c2: { rankTier: "Diamond", rating: 1750, historicalMatchesObserved: 4, priorConfidence: "imperfect_prior" }
        }
      });

      const val = validateObservedState(multiState);
      expect(val.valid, val.errors.join("; ")).toBe(true);
      expect(multiState.players.length).toBe(4);
      expect(multiState.playerOrder).toEqual(["c1", "c2", "c3", "c4"]);
      expect(multiState.turnPlayerId).toBe("c3");
      expect(multiState.turnPlayerIndex).toBe(2);
      expect(multiState.rules.maxPlayers).toEqual({ value: 4, source: "authoritative" });
      expect(multiState.observedTrades.length).toBe(2);
      expect(multiState.playerById["c2"].behavior.playerTradesCount).toBe(1);
      expect(multiState.playerById["c3"].behavior.playerTradesCount).toBe(1);
      expect(multiState.playerById["c1"].behavior.bankTradesCount).toBe(1);
      expect(multiState.playerById["c2"].behavior.prior).toEqual({
        rankTier: "Diamond",
        rating: 1750,
        historicalMatchesObserved: 4,
        priorConfidence: "imperfect_prior"
      });
    });

    it.skipIf(!recordingsAvailable)("reconstructs valid ObservedGameState across all 53 captured recordings and measures reconstruction & clone latency (recording fixture required)", () => {
      let buildTopoMs = 0;
      let cachedTopoMs = 0;
      let buildStateWithReadMs = 0;
      let buildStateSnapshotMs = 0;
      let cloneStateMs = 0;
      let validCount = 0;

      for (const rec of recordings) {
        if (!rec.frames?.length) continue;
        const { decoded } = decodeFrames(rec.frames);
        const parsed = stateDiffAdapter.parse(decoded);
        if (!parsed.board) continue;
        const placements = placementsFrom(parsed.events);

        const t0 = performance.now();
        const topo = buildBoardTopology(parsed.board);
        const t1 = performance.now();
        buildTopoMs += t1 - t0;

        const t2 = performance.now();
        const cached = getBoardTopology(parsed.board);
        const t3 = performance.now();
        cachedTopoMs += t3 - t2;
        expect(cached.corners.length).toBe(topo.corners.length);

        const t4 = performance.now();
        const state = buildObservedGameState({
          board: parsed.board,
          placements,
          snapshot: parsed.snapshot,
          events: parsed.events,
          selfId: parsed.selfId,
          warnings: parsed.warnings
        });
        const t5 = performance.now();
        buildStateWithReadMs += t5 - t4;

        const t4b = performance.now();
        const snapOnlyState = buildObservedGameState({
          board: parsed.board,
          placements,
          snapshot: parsed.snapshot,
          selfId: parsed.selfId,
          warnings: parsed.warnings
        });
        const t5b = performance.now();
        buildStateSnapshotMs += t5b - t4b;
        expect(validateObservedState(snapOnlyState).valid).toBe(true);

        const t6 = performance.now();
        const cloned = cloneObservedGameState(state);
        const t7 = performance.now();
        cloneStateMs += t7 - t6;

        expect(cloned).not.toBe(state);
        expect(cloned.players[0]).not.toBe(state.players[0]);
        expect(cloned.players[0].vp).toEqual(state.players[0].vp);

        const res = validateObservedState(state);
        expect(res.valid, `Invalid state in ${rec.id}: ${res.errors.join("; ")}`).toBe(true);
        validCount++;
      }

      expect(validCount).toBe(53);
      const avgBuildTopoUs = (buildTopoMs * 1000) / validCount;
      const avgCachedTopoUs = (cachedTopoMs * 1000) / validCount;
      const avgBuildStateWithReadUs = (buildStateWithReadMs * 1000) / validCount;
      const avgBuildStateSnapUs = (buildStateSnapshotMs * 1000) / validCount;
      const avgCloneStateUs = (cloneStateMs * 1000) / validCount;

      console.log(
        `[Stage 3.1 Benchmarks across ${validCount} games] buildBoardTopology: ${avgBuildTopoUs.toFixed(1)} µs/game | cached getBoardTopology: ${avgCachedTopoUs.toFixed(1)} µs/game | buildObservedGameState (snapshot/pre-read): ${avgBuildStateSnapUs.toFixed(1)} µs/game | buildObservedGameState (with full-game readTable): ${avgBuildStateWithReadUs.toFixed(1)} µs/game | cloneObservedGameState: ${avgCloneStateUs.toFixed(1)} µs/game`
      );
    });
  });

  describe.skipIf(!recordingsAvailable)("Stage 3.2 — Rule-Correct Shared-Board Legal-Action & State-Transition Engine (recording fixture required)", () => {
    function getStandardTopology() {
      const farm = recordings.find((r) => r.id === "farm9373")!;
      const parsed = stateDiffAdapter.parse(decodeFrames(farm.frames).decoded);
      return getBoardTopology(parsed.board!);
    }

    function snapshotStateForImmutability(state: ConcreteSimulatedGameState) {
      return JSON.stringify({
        ...state,
        topology: undefined,
        cornerPiece: Array.from(state.cornerPiece)
      });
    }

    function expectRejectedUnchanged(
      state: ConcreteSimulatedGameState,
      playerId: string,
      action: SimulatedAction,
      expectedCode: string,
      outcome?: ActionOutcome
    ) {
      const before = snapshotStateForImmutability(state);
      const res = applyAction(state, playerId, action, outcome);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(expectedCode);
      }
      expect(snapshotStateForImmutability(state)).toBe(before);
    }

    function assertAllLegalActionsSucceed(
      state: ConcreteSimulatedGameState,
      playerId?: string,
      includeDomesticTrades = false
    ) {
      const actions = getLegalActions(state, playerId, { includeDomesticTrades });
      const effectivePlayerId =
        playerId ??
        (state.phase === "discard"
          ? state.players.find((p) => p.pendingDiscardCount > 0)?.id ?? state.players[state.turnPlayerIndex].id
          : state.players[state.turnPlayerIndex].id);

      for (const action of actions) {
        expect(isActionLegal(state, effectivePlayerId, action)).toBe(true);
        let outcome: ActionOutcome | undefined;
        if (action.type === "rollDice") {
          outcome = { dice: { d1: 3, d2: 5, total: 8 } };
        } else if (action.type === "moveRobber" && typeof action.victimId === "string") {
          const victim = state.players.find((p) => p.id === action.victimId)!;
          const res = (["lumber", "brick", "wool", "grain", "ore"] as const).find((r) => victim.hand[r] > 0)!;
          outcome = { stolenResource: res };
        }
        const before = snapshotStateForImmutability(state);
        const res = applyAction(state, effectivePlayerId, action, outcome);
        expect(res.ok, !res.ok ? `${action.type}: ${res.error.code} - ${res.error.message}` : "").toBe(true);
        expect(snapshotStateForImmutability(state)).toBe(before);
        if (res.ok) {
          const val = validateConcreteSimState(res.state);
          expect(val.valid, val.errors.join("; ")).toBe(true);
        }
      }
    }

    it.skipIf(!recordingsAvailable)("1. Setup snake order, initial resource grant on 2nd settlement, setup road attachment, and farm9373 replay parity (recording fixture required)", () => {
      const topo = getStandardTopology();
      const initRes = createInitialConcreteState({
        topology: topo,
        playerIds: ["c1", "c5"]
      });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      let state = initRes.state;

      expect(state.phase).toBe("setup_settlement");
      expect(state.turnPlayerIndex).toBe(0);
      expect(state.completedTurns).toBe(0);
      assertAllLegalActionsSucceed(state);

      // Replay the exact setup placements from farm9373:
      // Turn 0 (c1): corner "15" -> edge "21"
      // Turn 1 (c5): corner "2"  -> edge "2"
      // Turn 2 (c5): corner "49" -> edge "63" (grants 1 grain, 1 ore, 1 wool)
      // Turn 3 (c1): corner "44" -> edge "53" (grants 1 lumber, 1 grain, 1 ore)
      const c15 = topo.cornerIndexByColonistId.get("15")!;
      const e21 = topo.edgeIndexByColonistId.get("21")!;
      const c2 = topo.cornerIndexByColonistId.get("2")!;
      const e2 = topo.edgeIndexByColonistId.get("2")!;
      const c49 = topo.cornerIndexByColonistId.get("49")!;
      const e63 = topo.edgeIndexByColonistId.get("63")!;
      const c44 = topo.cornerIndexByColonistId.get("44")!;
      const e53 = topo.edgeIndexByColonistId.get("53")!;

      // Reject wrong player during setup
      expectRejectedUnchanged(state, "c5", { type: "placeSetupSettlement", cornerIndex: c15 }, "not_active_player");
      // Reject road before settlement
      expectRejectedUnchanged(state, "c1", { type: "placeSetupRoad", edgeIndex: e21 }, "wrong_phase");

      // Step 1: c1 places 1st settlement at c15
      let step = applyAction(state, "c1", { type: "placeSetupSettlement", cornerIndex: c15 });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      expect(state.phase).toBe("setup_road");
      expect(state.players[0].hand).toEqual({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
      expect(state.players[0].visibleVp).toBe(1);
      assertAllLegalActionsSucceed(state);

      // Reject unconnected setup road
      expectRejectedUnchanged(state, "c1", { type: "placeSetupRoad", edgeIndex: e2 }, "unconnected_road");

      // Step 2: c1 places 1st road at e21 -> advances to c5 (turnPlayerIndex = 1, completedTurns = 1)
      step = applyAction(state, "c1", { type: "placeSetupRoad", edgeIndex: e21 });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      expect(state.phase).toBe("setup_settlement");
      expect(state.turnPlayerIndex).toBe(1);
      expect(state.completedTurns).toBe(1);

      // Distance rule: c5 cannot place on c15 or any neighbor of c15
      expectRejectedUnchanged(state, "c5", { type: "placeSetupSettlement", cornerIndex: c15 }, "occupied_corner");
      for (const adj of topo.corners[c15].adjacentCornerIndices) {
        expectRejectedUnchanged(state, "c5", { type: "placeSetupSettlement", cornerIndex: adj }, "distance_rule_violation");
      }

      // Step 3: c5 places 1st settlement at c2 and road at e2 -> snake order keeps c5 active (completedTurns = 2, turnPlayerIndex = 1)
      step = applyAction(state, "c5", { type: "placeSetupSettlement", cornerIndex: c2 });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      step = applyAction(state, "c5", { type: "placeSetupRoad", edgeIndex: e2 });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      expect(state.completedTurns).toBe(2);
      expect(state.turnPlayerIndex).toBe(1); // Snake turn-back: c5 places 2nd settlement immediately
      expect(state.phase).toBe("setup_settlement");

      // Step 4: c5 places 2nd settlement at c49 -> receives starting resources (1 wool, 1 grain, 1 ore, matching farm9373 Frame 101)
      step = applyAction(state, "c5", { type: "placeSetupSettlement", cornerIndex: c49 });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      expect(state.phase).toBe("setup_road");
      expect(state.players[1].hand).toEqual({ lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 });
      expect(state.bank).toEqual({ lumber: 19, brick: 19, wool: 18, grain: 18, ore: 18 });

      // Crucial setup rule: 2nd setup road MUST attach to the 2nd settlement (c49), NOT the 1st settlement (c2)!
      const otherEdgeOnFirstSettlement = topo.corners[c2].incidentEdgeIndices.find((ei) => ei !== e2)!;
      expectRejectedUnchanged(
        state,
        "c5",
        { type: "placeSetupRoad", edgeIndex: otherEdgeOnFirstSettlement },
        "unconnected_road"
      );
      expect(getLegalSetupRoadEdges(state, "c5")).not.toContain(otherEdgeOnFirstSettlement);

      step = applyAction(state, "c5", { type: "placeSetupRoad", edgeIndex: e63 });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      expect(state.completedTurns).toBe(3);
      expect(state.turnPlayerIndex).toBe(0); // Back to c1 for final setup pick
      expect(state.phase).toBe("setup_settlement");

      // Step 5: c1 places 2nd settlement at c44 and road at e53 -> transitions to normal play (completedTurns = 4, phase = "pre_roll", c1 active)
      step = applyAction(state, "c1", { type: "placeSetupSettlement", cornerIndex: c44 });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      expect(state.players[0].hand).toEqual({ lumber: 1, brick: 0, wool: 0, grain: 1, ore: 1 });
      expect(state.bank).toEqual({ lumber: 18, brick: 19, wool: 18, grain: 17, ore: 17 });

      step = applyAction(state, "c1", { type: "placeSetupRoad", edgeIndex: e53 });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      expect(state.completedTurns).toBe(4);
      expect(state.turnPlayerIndex).toBe(0);
      expect(state.phase).toBe("pre_roll");
      expect(state.dice.thrown).toBe(false);
      expect(validateConcreteSimState(state).valid).toBe(true);

      // Replay Turn 4 (c1 rolls 5+4=9, gets 1 brick, builds road on edge "30", ends turn -> matches farm9373 Frames 128-139)
      step = applyAction(state, "c1", { type: "rollDice", d1: 5, d2: 4 });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      expect(state.phase).toBe("main");
      expect(state.players[0].hand).toEqual({ lumber: 1, brick: 1, wool: 0, grain: 1, ore: 1 });
      expect(state.bank.brick).toBe(18);
      assertAllLegalActionsSucceed(state);

      const e30 = topo.edgeIndexByColonistId.get("30")!;
      step = applyAction(state, "c1", { type: "buildRoad", edgeIndex: e30 });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      expect(state.players[0].roadLength).toBe(2);
      expect(state.players[0].roadsLeft).toBe(12);
      expect(state.bank.lumber).toBe(19);
      expect(state.bank.brick).toBe(19);

      step = applyAction(state, "c1", { type: "endTurn" });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      expect(state.completedTurns).toBe(5);
      expect(state.turnPlayerIndex).toBe(1);
      expect(state.phase).toBe("pre_roll");
      expect(validateConcreteSimState(state).valid).toBe(true);
    });

    it("2. Enforces road, settlement, and city legality, opponent building road-continuation blocks, port ratios, and city settlement-supply return", () => {
      const topo = getStandardTopology();
      const initRes = createInitialConcreteState({ topology: topo, playerIds: ["c1", "c2"] });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      const state = initRes.state;

      // Put state into "main" phase for c1 with known resources
      state.phase = "main";
      state.completedTurns = 4;
      state.dice = { thrown: true, d1: 3, d2: 5, total: 8 };

      // Find an interior corner c0 and a 2-step chain c0 -e1-> c1 -e2-> c2
      const c0 = topo.corners.find((c) => c.adjacentCornerIndices.length === 3)!;
      const e1 = c0.incidentEdgeIndices[0];
      const c1Idx = topo.otherCornerOfEdge(e1, c0.index)!;
      const e2 = topo.corners[c1Idx].incidentEdgeIndices.find((ei) => ei !== e1)!;
      const c2Idx = topo.otherCornerOfEdge(e2, c1Idx)!;

      // Place c1's settlement at c0.index and road on e1
      state.cornerOwner[c0.index] = "c1";
      state.cornerPiece[c0.index] = 1;
      state.players[0].settlementsLeft = 4;
      state.edgeOwner[e1] = "c1";
      state.players[0].roadsLeft = 14;

      // Give c1 resources for road, settlement, and city
      state.players[0].hand = { lumber: 3, brick: 3, wool: 2, grain: 4, ore: 3 };
      state.bank = { lumber: 16, brick: 16, wool: 17, grain: 15, ore: 16 };
      updateLongestRoadAward(state);

      // 1. Before opponent builds at c1Idx, e2 is legal for c1 to build a road
      expect(getLegalRoadEdges(state, "c1")).toContain(e2);

      // 2. Now suppose opponent c2 owns a settlement at c2Idx and builds a road + settlement at c1Idx?
      // Wait: c1Idx is adjacent to c0.index, so a settlement at c1Idx would violate the distance rule with c0.index.
      // Let's extend 1 more step: c0 -e1-> c1Idx -e2-> c2Idx -e3-> c3Idx, where c2Idx is 2 edges away from c0!
      const e3 = topo.corners[c2Idx].incidentEdgeIndices.find((ei) => ei !== e2)!;
      let res = applyAction(state, "c1", { type: "buildRoad", edgeIndex: e2 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      let cur = res.state;
      expect(cur.edgeOwner[e2]).toBe("c1");
      expect(getLegalRoadEdges(cur, "c1")).toContain(e3);

      // Now place opponent c2's settlement at c2Idx (which is 2 edges from c0, so distance-rule legal!)
      cur.cornerOwner[c2Idx] = "c2";
      cur.cornerPiece[c2Idx] = 1;
      cur.players[1].settlementsLeft = 4;
      updateLongestRoadAward(cur);

      // Because c2 owns a settlement at c2Idx, c1 is BLOCKED from continuing a new road onto e3 through c2Idx!
      expect(getLegalRoadEdges(cur, "c1")).not.toContain(e3);
      expectRejectedUnchanged(cur, "c1", { type: "buildRoad", edgeIndex: e3 }, "blocked_by_opponent_building");

      // 3. Test settlement on a port corner updates player trade ratios (3:1 "any" and 2:1 specific port)
      const anyPort = topo.ports.find((p) => p.kind === "any")!;
      const specificPort = topo.ports.find((p) => p.kind !== "any")!;
      const portCornerIdx = specificPort.cornerIndices[0];
      const portIncidentEdge = topo.corners[portCornerIdx].incidentEdgeIndices[0];
      cur.edgeOwner[portIncidentEdge] = "c1";
      cur.players[0].roadsLeft -= 1;

      res = applyAction(cur, "c1", { type: "buildSettlement", cornerIndex: portCornerIdx });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      cur = res.state;
      expect(cur.players[0].ratios[specificPort.kind as Exclude<typeof specificPort.kind, "any">]).toBe(2);

      // Also place a settlement on the 3:1 port and verify 3:1 updates 4 -> 3 without overwriting the 2:1 ratio
      const anyPortCornerIdx = anyPort.cornerIndices.find(
        (ci) => cur.cornerPiece[ci] === 0 && topo.corners[ci].adjacentCornerIndices.every((adj) => cur.cornerPiece[adj] === 0)
      )!;
      const anyPortEdge = topo.corners[anyPortCornerIdx].incidentEdgeIndices[0];
      cur.edgeOwner[anyPortEdge] = "c1";
      cur.players[0].roadsLeft -= 1;

      res = applyAction(cur, "c1", { type: "buildSettlement", cornerIndex: anyPortCornerIdx });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      cur = res.state;
      for (const r of ["lumber", "brick", "wool", "grain", "ore"] as const) {
        if (r === specificPort.kind) expect(cur.players[0].ratios[r]).toBe(2);
        else expect(cur.players[0].ratios[r]).toBe(3);
      }

      // 4. Test city upgrade returns 1 settlement to settlementsLeft (allowing a player at 0 settlementsLeft to build again after upgrading)
      cur.players[0].settlementsLeft = 0;
      expectRejectedUnchanged(cur, "c1", { type: "buildCity", cornerIndex: c2Idx }, "invalid_city_upgrade");
      res = applyAction(cur, "c1", { type: "buildCity", cornerIndex: c0.index });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      cur = res.state;
      expect(cur.cornerPiece[c0.index]).toBe(2);
      expect(cur.players[0].citiesLeft).toBe(3);
      expect(cur.players[0].settlementsLeft).toBe(1); // Returned to supply!
      expect(validateConcreteSimState(cur).valid).toBe(true);
      assertAllLegalActionsSucceed(cur);
    });

    it("3. Computes exact Longest Road on branched graphs and handles claim, tie retention, overtake, and opponent-settlement road breaks (including 3p tie -> unclaimed)", () => {
      const topo = getStandardTopology();
      const initRes = createInitialConcreteState({ topology: topo, playerIds: ["c1", "c2", "c3"] });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      const state = initRes.state;
      state.phase = "main";
      state.completedTurns = 6;
      state.dice = { thrown: true, d1: 4, d2: 4, total: 8 };

      // 1. Branched Y-network of 5 total road pieces where longest simple trail is only 4 must NOT claim Longest Road
      // Find an interior corner with 3 incident edges: eA, eB, eC
      const hub = topo.corners.find(
        (c) =>
          c.incidentEdgeIndices.length === 3 &&
          c.adjacentCornerIndices.every((nbr) => topo.corners[nbr].incidentEdgeIndices.length === 3)
      )!;
      const [eA, eB, eC] = hub.incidentEdgeIndices;
      const nA = topo.otherCornerOfEdge(eA, hub.index)!;
      const nB = topo.otherCornerOfEdge(eB, hub.index)!;
      const eA2 = topo.corners[nA].incidentEdgeIndices.find((ei) => ei !== eA)!;
      const eB2 = topo.corners[nB].incidentEdgeIndices.find((ei) => ei !== eB)!;

      // Y-shape: 2 edges on branch A (eA, eA2), 2 edges on branch B (eB, eB2), 1 edge on branch C (eC) = 5 road pieces, max trail = 4 (eA2-eA-eB-eB2)
      for (const ei of [eA, eA2, eB, eB2, eC]) {
        state.edgeOwner[ei] = "c1";
      }
      state.players[0].roadsLeft = 10;
      updateLongestRoadAward(state);
      expect(state.players[0].roadLength).toBe(4);
      expect(state.players[0].hasLongestRoad).toBe(false);

      // 2. Extend branch A by 1 more edge (eA3) so trail becomes eA3-eA2-eA-eB-eB2 = length 5 -> c1 claims Longest Road (+2 VP)
      const nA2 = topo.otherCornerOfEdge(eA2, nA)!;
      const eA3 = topo.corners[nA2].incidentEdgeIndices.find((ei) => ei !== eA2 && state.edgeOwner[ei] === null)!;
      state.edgeOwner[eA3] = "c1";
      state.players[0].roadsLeft = 9;
      updateLongestRoadAward(state);
      expect(state.players[0].roadLength).toBe(5);
      expect(state.players[0].hasLongestRoad).toBe(true);
      expect(state.players[0].visibleVp).toBe(2);

      // 3. Build a 5-edge simple path for c2 on a disjoint hex -> tie at 5, incumbent c1 RETAINS Longest Road
      const c2Hex = topo.hexes.find((h) => h.edgeIndices.every((ei) => state.edgeOwner[ei] === null))!;
      const c2HexEdges = c2Hex.edgeIndices;
      for (let k = 0; k < 5; k++) {
        state.edgeOwner[c2HexEdges[k]] = "c2";
      }
      state.players[1].roadsLeft = 10;
      updateLongestRoadAward(state);
      expect(state.players[1].roadLength).toBe(5);
      expect(state.players[0].hasLongestRoad).toBe(true);
      expect(state.players[1].hasLongestRoad).toBe(false);

      // 4. Give c2 the 6th edge of c2Hex -> c2 reaches length 6 and strictly overtakes c1!
      state.edgeOwner[c2HexEdges[5]] = "c2";
      state.players[1].roadsLeft = 9;
      updateLongestRoadAward(state);
      expect(state.players[1].roadLength).toBe(6);
      expect(state.players[0].hasLongestRoad).toBe(false);
      expect(state.players[0].visibleVp).toBe(0);
      expect(state.players[1].hasLongestRoad).toBe(true);
      expect(state.players[1].visibleVp).toBe(2);

      // 5. Also give c3 a 5-edge path on another disjoint hex (so c1 has 5, c3 has 5, and c2 holds Longest Road with 6)
      const disjointHex = topo.hexes.find(
        (h) => h.edgeIndices.every((ei) => state.edgeOwner[ei] === null)
      )!;
      for (let k = 0; k < 5; k++) {
        state.edgeOwner[disjointHex.edgeIndices[k]] = "c3";
      }
      state.players[2].roadsLeft = 10;
      updateLongestRoadAward(state);
      expect(state.players[2].roadLength).toBe(5);
      expect(state.players[1].hasLongestRoad).toBe(true);

      // 6. Now break c2's 6-edge cycle on c2Hex with TWO opponent settlements at opposite corners of c2Hex
      // so c2's road length drops from 6 to 3!
      // Then c1 (length 5) and c3 (length 5) are TIED for the new maximum >= 5.
      // By Catan Almanac rules, c2 loses Longest Road and the award becomes UNCLAIMED (neither c1 nor c3 gets it)!
      const c2BreakCorner1 = c2Hex.cornerIndices[0];
      const c2BreakCorner2 = c2Hex.cornerIndices[3]; // opposite corner on c2Hex (3 steps away)
      state.cornerOwner[c2BreakCorner1] = "c1";
      state.cornerPiece[c2BreakCorner1] = 1;
      state.cornerOwner[c2BreakCorner2] = "c1";
      state.cornerPiece[c2BreakCorner2] = 1;
      updateLongestRoadAward(state);

      expect(state.players[1].roadLength).toBe(3);
      expect(state.players[0].roadLength).toBe(5);
      expect(state.players[2].roadLength).toBe(5);
      expect(state.players[0].hasLongestRoad).toBe(false);
      expect(state.players[1].hasLongestRoad).toBe(false);
      expect(state.players[2].hasLongestRoad).toBe(false);

      // 7. When c3's road is shortened below 5 (or c1 extends to 6), the sole leader >= 5 claims Longest Road
      state.edgeOwner[disjointHex.edgeIndices[4]] = null;
      updateLongestRoadAward(state);
      expect(state.players[2].roadLength).toBe(4);
      expect(state.players[0].roadLength).toBe(5);
      expect(state.players[0].hasLongestRoad).toBe(true);
    });

    it("4. Enforces Largest Army transitions, ties, strict overtaking, and immediate Knight victory before robber move (spot195 rule)", () => {
      const topo = getStandardTopology();
      const initRes = createInitialConcreteState({ topology: topo, playerIds: ["c1", "c2"] });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      let state = initRes.state;
      state.phase = "pre_roll";
      state.completedTurns = 4;
      state.players[0].readyDevs = ["knight"];
      state.players[0].knightsPlayed = 2;
      state.players[0].playedDevs = ["knight", "knight"];
      state.players[1].knightsPlayed = 3;
      state.players[1].playedDevs = ["knight", "knight", "knight"];
      state.players[1].hasLargestArmy = true;
      state.devDeckOrder = state.devDeckOrder.slice(6);
      updateLargestArmyAward(state);
      expect(state.players[1].hasLargestArmy).toBe(true);
      expect(state.players[1].visibleVp).toBe(2);

      // c1 plays 3rd Knight in pre_roll -> ties c2 at 3 Knights -> c2 retains Largest Army, phase becomes "robber_move"
      let res = applyAction(state, "c1", { type: "playKnight" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.players[0].knightsPlayed).toBe(3);
      expect(state.players[0].hasLargestArmy).toBe(false);
      expect(state.players[1].hasLargestArmy).toBe(true);
      expect(state.phase).toBe("robber_move");

      // Move robber in pre_roll -> returns to "pre_roll" because dice.thrown is still false!
      const targetHex = topo.hexes.find((h) => h.index !== state.robberHexIndex)!.index;
      res = applyAction(state, "c1", { type: "moveRobber", hexIndex: targetHex, victimId: null });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.phase).toBe("pre_roll");
      expect(state.dice.thrown).toBe(false);

      // Cannot play a second Knight on the same turn
      state.players[0].readyDevs.push("knight");
      state.devDeckOrder.pop();
      expectRejectedUnchanged(state, "c1", { type: "playKnight" }, "dev_card_already_played_this_turn");

      // Advance to c1's next turn where c1 has 13 VP and plays 4th Knight to overtake Largest Army (+2 VP = 15 VP -> immediate game_over!)
      state.players[0].hasUsedDevThisTurn = false;
      state.players[0].vpDevs = 13;
      state.devDeckOrder.splice(0, 13);
      updateLargestArmyAward(state);
      expect(state.players[0].actualSimulatedVp).toBe(13);

      res = applyAction(state, "c1", { type: "playKnight" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.players[0].knightsPlayed).toBe(4);
      expect(state.players[0].hasLargestArmy).toBe(true);
      expect(state.players[1].hasLargestArmy).toBe(false);
      expect(state.players[0].actualSimulatedVp).toBe(15);
      expect(state.phase).toBe("game_over");
      expect(state.winnerId).toBe("c1");
    });

    it("5. Enforces dev-card timing, Road Building (2 roads, 1 road supply, mid-card win), Year of Plenty bank limits, Monopoly conservation, and VP dev immediate win", () => {
      const topo = getStandardTopology();
      const initRes = createInitialConcreteState({
        topology: topo,
        playerIds: ["c1", "c2"],
        devDeckOrder: [
          "monopoly",
          "yearOfPlenty",
          "roadBuilding",
          "victoryPoint",
          ...new Array(21).fill("knight")
        ]
      });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      let state = initRes.state;
      state.phase = "main";
      state.completedTurns = 4;
      state.dice = { thrown: true, d1: 3, d2: 5, total: 8 };

      // Place initial road for c1 so Road Building has legal extensions
      state.edgeOwner[0] = "c1";
      state.players[0].roadsLeft = 14;
      state.players[0].hand = { lumber: 0, brick: 0, wool: 3, grain: 3, ore: 3 };
      state.bank = { lumber: 19, brick: 19, wool: 16, grain: 16, ore: 16 };

      // 1. Buy Monopoly on current turn -> goes to boughtDevsThisTurn, CANNOT be played this turn
      let res = applyAction(state, "c1", { type: "buyDevCard" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.players[0].boughtDevsThisTurn).toEqual(["monopoly"]);
      expect(state.players[0].readyDevs).toEqual([]);
      expectRejectedUnchanged(state, "c1", { type: "playMonopoly", resource: "lumber" }, "dev_card_bought_this_turn");

      // Also buy Year of Plenty and Road Building this turn
      res = applyAction(state, "c1", { type: "buyDevCard" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      res = applyAction(state, "c1", { type: "buyDevCard" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.players[0].boughtDevsThisTurn).toEqual(["monopoly", "yearOfPlenty", "roadBuilding"]);
      expectRejectedUnchanged(
        state,
        "c1",
        { type: "playYearOfPlenty", resources: ["lumber", "brick"] },
        "dev_card_bought_this_turn"
      );
      expectRejectedUnchanged(state, "c1", { type: "playRoadBuilding" }, "dev_card_bought_this_turn");

      // End turn for c1 -> boughtDevsThisTurn moves to readyDevs!
      res = applyAction(state, "c1", { type: "endTurn" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.players[0].readyDevs).toEqual(["monopoly", "yearOfPlenty", "roadBuilding"]);
      expect(state.players[0].boughtDevsThisTurn).toEqual([]);

      // Complete c2's turn to return to c1
      res = applyAction(state, "c2", { type: "rollDice", d1: 2, d2: 4 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      res = applyAction(state, "c2", { type: "endTurn" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;

      // 2. Test Year of Plenty bank supply limits:
      // Set bank.ore = 1 (with 18 ore in c2's hand) -> requesting ["ore", "ore"] must fail closed, while ["ore", "grain"] succeeds!
      state.players[1].hand.ore = 18;
      state.bank.ore = 1;
      expectRejectedUnchanged(
        state,
        "c1",
        { type: "playYearOfPlenty", resources: ["ore", "ore"] },
        "insufficient_bank_resources"
      );
      res = applyAction(state, "c1", { type: "playYearOfPlenty", resources: ["ore", "grain"] });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.players[0].hand.ore).toBe(1);
      expect(state.players[0].hand.grain).toBe(1);
      expect(state.bank.ore).toBe(0);
      expect(state.players[0].hasUsedDevThisTurn).toBe(true);
      expect(validateConcreteSimState(state).valid).toBe(true);

      // Cannot play Monopoly on the same turn after playing Year of Plenty
      expectRejectedUnchanged(state, "c1", { type: "playMonopoly", resource: "ore" }, "dev_card_already_played_this_turn");

      // 3. Test Monopoly on next turn: steals all 18 ore from c2 without changing bank or violating conservation
      state.players[0].hasUsedDevThisTurn = false;
      res = applyAction(state, "c1", { type: "playMonopoly", resource: "ore" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.players[0].hand.ore).toBe(19);
      expect(state.players[1].hand.ore).toBe(0);
      expect(state.bank.ore).toBe(0);
      expect(validateConcreteSimState(state).valid).toBe(true);

      // 4. Test Road Building: places 2 free roads step-by-step ("road_building_1" -> "road_building_2" -> "pre_roll")
      state.players[0].hasUsedDevThisTurn = false;
      res = applyAction(state, "c1", { type: "playRoadBuilding" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.phase).toBe("road_building_1");
      assertAllLegalActionsSucceed(state);

      const firstFreeEdge = getLegalRoadEdges(state, "c1")[0];
      res = applyAction(state, "c1", { type: "placeFreeRoad", edgeIndex: firstFreeEdge });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.phase).toBe("road_building_2");
      assertAllLegalActionsSucceed(state);

      const secondFreeEdge = getLegalRoadEdges(state, "c1")[0];
      res = applyAction(state, "c1", { type: "placeFreeRoad", edgeIndex: secondFreeEdge });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.phase).toBe("pre_roll");
      expect(state.players[0].roadsLeft).toBe(12);

      // 5. Test buying a Victory Point dev card at 14 VP immediately ends the game (sheep8929 rule)
      res = applyAction(state, "c1", { type: "rollDice", d1: 3, d2: 3 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      state.players[0].vpDevs = 14;
      state.devDeckOrder.splice(1, 14); // keep "victoryPoint" at index 0 while conserving 25 cards
      state.players[0].hand.wool = 1;
      state.players[0].hand.grain = 1;
      state.bank.wool -= 1;
      state.bank.grain -= 1;
      recomputeVpAndCheck: {
        updateLongestRoadAward(state);
        expect(state.players[0].actualSimulatedVp).toBe(14);
        res = applyAction(state, "c1", { type: "buyDevCard" });
        expect(res.ok).toBe(true);
        if (!res.ok) break recomputeVpAndCheck;
        state = res.state;
        expect(state.players[0].vpDevs).toBe(15);
        expect(state.players[0].actualSimulatedVp).toBe(15);
        expect(state.players[0].visibleVp).toBe(0); // VP dev card remains distinct from visibleVp!
        expect(state.phase).toBe("game_over");
        expect(state.winnerId).toBe("c1");
      }
    });

    it("6. Enforces robber blocking on single hex only, Friendly Robber public-VP rule (ship2170 rule), discards, and bank-shortage production rules", () => {
      const topo = getStandardTopology();
      const initRes = createInitialConcreteState({ topology: topo, playerIds: ["c1", "c2"] });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      let state = initRes.state;
      state.phase = "pre_roll";
      state.completedTurns = 4;

      // Find two hexes that share the SAME dice number (e.g. number 8)
      const hexesWith8 = topo.hexIndicesByDiceNumber.get(8)!;
      expect(hexesWith8.length).toBe(2);
      const [h8a, h8b] = hexesWith8;
      const resA = topo.hexes[h8a].resource!;
      const resB = topo.hexes[h8b].resource!;

      // Place a c1 settlement on h8a (and not touching h8b) and a c2 settlement on h8b (and not touching h8a)
      const cOnA = topo.hexes[h8a].cornerIndices.find((ci) => !topo.hexes[h8b].cornerIndices.includes(ci))!;
      const cOnB = topo.hexes[h8b].cornerIndices.find(
        (ci) => !topo.hexes[h8a].cornerIndices.includes(ci) && !topo.corners[cOnA].adjacentCornerIndices.includes(ci)
      )!;
      state.cornerOwner[cOnA] = "c1";
      state.cornerPiece[cOnA] = 1;
      state.players[0].settlementsLeft = 4;
      state.cornerOwner[cOnB] = "c2";
      state.cornerPiece[cOnB] = 1;
      state.players[1].settlementsLeft = 4;
      updateLongestRoadAward(state);

      // Put robber on h8a: rolling 8 must block h8a (c1 gets 0 from h8a) while h8b STILL produces for c2!
      state.robberHexIndex = h8a;
      let res = applyAction(state, "c1", { type: "rollDice", d1: 4, d2: 4 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.players[0].hand[resA]).toBe(0);
      expect(state.players[1].hand[resB]).toBe(1);

      // Test bank shortage rules on dice production:
      // Case A: Single claimant owed 2 (from a city on h8b), bank only has 1 of resB -> single claimant receives the 1 remaining card!
      state.phase = "pre_roll";
      state.dice = { thrown: false };
      state.cornerPiece[cOnB] = 2; // upgrade c2 on h8b to city (owed 2 of resB)
      state.players[0].hand[resB] = 17;
      state.players[1].hand[resB] = 1;
      state.bank[resB] = 1; // Only 1 left in bank!
      res = applyAction(state, "c1", { type: "rollDice", d1: 4, d2: 4 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.players[1].hand[resB]).toBe(2); // Received the 1 available card
      expect(state.bank[resB]).toBe(0);

      // Case B: Multiple claimants owed resB when totalOwed > bank[resB] -> NO claimant receives resB!
      const secondCornerOnB = topo.hexes[h8b].cornerIndices.find(
        (ci) =>
          ci !== cOnB &&
          !topo.corners[cOnB].adjacentCornerIndices.includes(ci) &&
          !topo.corners[cOnA].adjacentCornerIndices.includes(ci)
      )!;
      state.cornerOwner[secondCornerOnB] = "c1";
      state.cornerPiece[secondCornerOnB] = 1; // Now c1 is owed 1 and c2 is owed 2 on h8b (totalOwed = 3)
      state.players[0].hand[resB] = 16;
      state.players[1].hand[resB] = 1;
      state.bank[resB] = 2; // 2 left in bank < 3 totalOwed across 2 players!
      state.phase = "pre_roll";
      state.dice = { thrown: false };
      res = applyAction(state, "c1", { type: "rollDice", d1: 4, d2: 4 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      state = res.state;
      expect(state.players[0].hand[resB]).toBe(16); // Unchanged!
      expect(state.players[1].hand[resB]).toBe(1); // Unchanged!
      expect(state.bank[resB]).toBe(2); // Unchanged!

      // Test Friendly Robber rule using observable visibleVp (ship2170 rule):
      // Give c2 only 2 visible VP (the city at cOnB) + 1 hidden VP dev card (actualSimulatedVp = 3, visibleVp = 2).
      // Because Friendly Robber checks visibleVp (< 3), c1 CANNOT move the robber to a hex owned only by c2!
      state.cornerOwner[secondCornerOnB] = null;
      state.cornerPiece[secondCornerOnB] = 0;
      state.players[1].vpDevs = 1;
      state.devDeckOrder.pop();
      updateLongestRoadAward(state);
      expect(state.players[1].visibleVp).toBe(2);
      expect(state.players[1].actualSimulatedVp).toBe(3);

      state.phase = "robber_move";
      expectRejectedUnchanged(
        state,
        "c1",
        { type: "moveRobber", hexIndex: h8b, victimId: "c2" },
        "friendly_robber_restriction",
        { stolenResource: resB }
      );
      expect(getLegalRobberMoves(state, "c1").map((m) => m.hexIndex)).not.toContain(h8b);

      // Once c2 gains a 3rd visible VP (e.g. a settlement), h8b becomes legal to rob!
      const extraCornerForC2 = topo.corners.find(
        (c) =>
          state.cornerPiece[c.index] === 0 &&
          c.adjacentCornerIndices.every((adj) => state.cornerPiece[adj] === 0)
      )!.index;
      state.cornerOwner[extraCornerForC2] = "c2";
      state.cornerPiece[extraCornerForC2] = 1;
      updateLongestRoadAward(state);
      expect(state.players[1].visibleVp).toBe(3);
      expect(getLegalRobberMoves(state, "c1").map((m) => m.hexIndex)).toContain(h8b);
    });

    it("7. Executes deterministic 4-player scenario covering 4p snake setup, multi-player discards, multi-victim robber choice, 4p Monopoly, and non-self playerTrade", () => {
      const topo = getStandardTopology();
      // Use the 4-player seat order from recording path4053: ["c3", "c2", "c1", "c5"]
      const initRes = createInitialConcreteState({
        topology: topo,
        playerIds: ["c3", "c2", "c1", "c5"]
      });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      let state = initRes.state;
      expect(state.rules.victoryPointsToWin).toBe(10);
      expect(state.rules.cardDiscardLimit).toBe(7);

      // Execute full 8-turn 4-player snake draft: [c3, c2, c1, c5, c5, c1, c2, c3]
      const expectedOrder = ["c3", "c2", "c1", "c5", "c5", "c1", "c2", "c3"];
      for (let stepIdx = 0; stepIdx < 8; stepIdx++) {
        const expectedPid = expectedOrder[stepIdx];
        expect(state.players[state.turnPlayerIndex].id).toBe(expectedPid);
        expect(state.phase).toBe("setup_settlement");

        const legalCorners = getLegalSetupSettlementCorners(state, expectedPid);
        expect(legalCorners.length).toBeGreaterThan(0);
        const cornerIndex = legalCorners[0];
        let r1 = applyAction(state, expectedPid, { type: "placeSetupSettlement", cornerIndex });
        expect(r1.ok).toBe(true);
        if (!r1.ok) return;
        state = r1.state;
        expect(state.phase).toBe("setup_road");

        const legalEdges = getLegalSetupRoadEdges(state, expectedPid);
        expect(legalEdges.length).toBeGreaterThan(0);
        let r2 = applyAction(state, expectedPid, { type: "placeSetupRoad", edgeIndex: legalEdges[0] });
        expect(r2.ok).toBe(true);
        if (!r2.ok) return;
        state = r2.state;
      }

      // After 8 setup turns, normal play begins at completedTurns = 8 with c3 (index 0) in "pre_roll"
      expect(state.completedTurns).toBe(8);
      expect(state.turnPlayerIndex).toBe(0);
      expect(state.players[state.turnPlayerIndex].id).toBe("c3");
      expect(state.phase).toBe("pre_roll");
      expect(validateConcreteSimState(state).valid).toBe(true);

      // Give c2 (8 cards) and c5 (9 cards) > 7 discard limit, then roll a 7 with c3
      state.players = state.players.map((p) => ({ ...p, hand: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 } }));
      state.players[1].hand = { lumber: 4, brick: 4, wool: 0, grain: 0, ore: 0 }; // c2 has 8 -> must discard 4
      state.players[3].hand = { lumber: 0, brick: 0, wool: 5, grain: 4, ore: 0 }; // c5 has 9 -> must discard 4
      state.bank = { lumber: 15, brick: 15, wool: 14, grain: 15, ore: 19 };

      let roll7 = applyAction(state, "c3", { type: "rollDice", d1: 3, d2: 4 });
      expect(roll7.ok).toBe(true);
      if (!roll7.ok) return;
      state = roll7.state;
      expect(state.phase).toBe("discard");
      expect(state.players[0].pendingDiscardCount).toBe(0);
      expect(state.players[1].pendingDiscardCount).toBe(4);
      expect(state.players[2].pendingDiscardCount).toBe(0);
      expect(state.players[3].pendingDiscardCount).toBe(4);
      assertAllLegalActionsSucceed(state);

      // c3 cannot discard because pendingDiscardCount is 0
      expectRejectedUnchanged(state, "c3", { type: "discard", cards: { lumber: 1 } }, "no_discard_required");
      // c2 discards 4 cards -> phase stays "discard" because c5 still must discard 4
      let d1 = applyAction(state, "c2", { type: "discard", cards: { lumber: 2, brick: 2 } });
      expect(d1.ok).toBe(true);
      if (!d1.ok) return;
      state = d1.state;
      expect(state.phase).toBe("discard");
      expect(state.players[1].pendingDiscardCount).toBe(0);

      // c5 discards 4 cards -> all discards complete -> phase transitions to "robber_move" for c3!
      let d2 = applyAction(state, "c5", { type: "discard", cards: { wool: 2, grain: 2 } });
      expect(d2.ok).toBe(true);
      if (!d2.ok) return;
      state = d2.state;
      expect(state.phase).toBe("robber_move");
      expect(state.players[state.turnPlayerIndex].id).toBe("c3");

      // Place c2 and c5 settlements on opposite corners of a hex so BOTH c2 and c5 are eligible victims on that hex
      const sharedHex = topo.hexes.find(
        (h) =>
          h.index !== state.robberHexIndex &&
          h.cornerIndices.every((ci) => state.cornerPiece[ci] === 0 && topo.corners[ci].adjacentCornerIndices.every((a) => state.cornerPiece[a] === 0))
      );
      if (sharedHex) {
        const sc1 = sharedHex.cornerIndices[0];
        const sc2 = sharedHex.cornerIndices[3];
        state.cornerOwner[sc1] = "c2";
        state.cornerPiece[sc1] = 1;
        state.cornerOwner[sc2] = "c5";
        state.cornerPiece[sc2] = 1;
        expect(getEligibleRobberVictims(state, "c3", sharedHex.index)).toEqual(["c2", "c5"]);
        // Omitting victimId when 2 victims are eligible must fail closed
        expectRejectedUnchanged(state, "c3", { type: "moveRobber", hexIndex: sharedHex.index }, "invalid_robber_victim");
      }

      // Move robber and enter "main" phase for c3, then end c3's turn so c2 becomes active
      const legalRobberAction = getLegalActions(state, "c3")[0] as Extract<SimulatedAction, { type: "moveRobber" }>;
      const robOutcome: ActionOutcome | undefined =
        typeof legalRobberAction.victimId === "string"
          ? {
              stolenResource: (["lumber", "brick", "wool", "grain", "ore"] as const).find(
                (r) => state.players.find((p) => p.id === legalRobberAction.victimId)!.hand[r] > 0
              )!
            }
          : undefined;
      let rm = applyAction(state, "c3", legalRobberAction, robOutcome);
      expect(rm.ok).toBe(true);
      if (!rm.ok) return;
      state = rm.state;
      expect(state.phase).toBe("main");

      // Advance to c2's main phase and execute a domestic trade between c2 and c5 (neither is c1!)
      let et = applyAction(state, "c3", { type: "endTurn" });
      expect(et.ok).toBe(true);
      if (!et.ok) return;
      state = et.state;
      expect(state.players[state.turnPlayerIndex].id).toBe("c2");

      let rollC2 = applyAction(state, "c2", { type: "rollDice", d1: 2, d2: 3 });
      expect(rollC2.ok).toBe(true);
      if (!rollC2.ok) return;
      state = rollC2.state;
      expect(state.phase).toBe("main");
      assertAllLegalActionsSucceed(state, "c2", true);

      // Reject same-resource swap (e.g. 1 lumber for 1 lumber)
      expectRejectedUnchanged(
        state,
        "c2",
        { type: "playerTrade", partnerId: "c5", give: { lumber: 1 }, receive: { lumber: 1 } },
        "invalid_trade"
      );

      // Valid domestic trade between c2 (gives 1 brick) and c5 (gives 1 wool)
      const c2BrickBefore = state.players[1].hand.brick;
      const c5WoolBefore = state.players[3].hand.wool;
      let tradeRes = applyAction(state, "c2", {
        type: "playerTrade",
        partnerId: "c5",
        give: { brick: 1 },
        receive: { wool: 1 }
      });
      expect(tradeRes.ok).toBe(true);
      if (!tradeRes.ok) return;
      state = tradeRes.state;
      expect(state.players[1].hand.brick).toBe(c2BrickBefore - 1);
      expect(state.players[1].hand.wool).toBeGreaterThanOrEqual(1);
      expect(state.players[3].hand.brick).toBeGreaterThanOrEqual(1);
      expect(state.players[3].hand.wool).toBe(c5WoolBefore - 1);
      expect(validateConcreteSimState(state).valid).toBe(true);
    });

    it.skipIf(!recordingsAvailable)("8. Enforces strict 3-way information boundary on materializeConcreteState and fails closed on unsupported variants/rulesets (recording fixture required)", () => {
      const farmRec = recordings.find((r) => r.id === "farm9373")!;
      const farmParsed = stateDiffAdapter.parse(decodeFrames(farmRec.frames).decoded);
      const farmPlacements = placementsFrom(farmParsed.events);
      const farmParser = new LogParser(farmRec.meta.me);
      const farmTracker = new HandTracker();
      for (const row of farmRec.log) {
        if (!row.text) continue;
        const r = farmParser.push(row);
        if (r.kind === "event") farmTracker.apply(r.event);
      }
      const oppView = farmTracker.views().find((v) => v.name !== farmRec.meta.me);

      const observed = buildObservedGameState({
        board: farmParsed.board!,
        placements: farmPlacements,
        snapshot: farmParsed.snapshot,
        events: farmParsed.events,
        selfId: farmParsed.selfId,
        oppHandView: oppView,
        warnings: farmParsed.warnings
      });

      const observedBefore = JSON.stringify({
        ...observed,
        topology: undefined,
        cornerPiece: Array.from(observed.cornerPiece)
      });

      // 1. Calling materializeConcreteState without explicit determinization MUST fail closed because opponent c1's hand
      // is an INFERENCE (inferenceSource === "hand_tracker", exact === null) and c1 has 2 unknown face-down dev cards!
      const withoutDet = materializeConcreteState(observed);
      expect(withoutDet.ok).toBe(false);
      if (!withoutDet.ok) {
        expect(withoutDet.error.code).toBe("missing_outcome");
      }

      // 2. Supplying explicit determinization materializes a valid ConcreteSimulatedGameState without mutating `observed`
      // and keeps `observedConfirmedVp` (14) strictly separate from `actualSimulatedVp` (14 + 2 = 16)!
      const remainingPool = { ...observed.devDeck.unseenPool };
      remainingPool.victoryPoint -= 2; // assign 2 VP cards to c1's unknown devs
      const explicitDeck: Array<"knight" | "victoryPoint" | "roadBuilding" | "yearOfPlenty" | "monopoly"> = [];
      for (const [k, count] of Object.entries(remainingPool)) {
        for (let i = 0; i < count; i++) {
          explicitDeck.push(k as "knight" | "victoryPoint" | "roadBuilding" | "yearOfPlenty" | "monopoly");
        }
      }

      const withDet = materializeConcreteState(observed, {
        handsByPlayerId: {
          c1: { ...observed.playerById["c1"].hand.likely }
        },
        unknownDevsByPlayerId: {
          c1: { vp: 2 }
        },
        devDeckOrder: explicitDeck
      });
      expect(withDet.ok).toBe(true);
      if (withDet.ok) {
        const simC1 = withDet.state.players.find((p) => p.id === "c1")!;
        expect(simC1.visibleVp).toBe(14);
        expect(simC1.observedConfirmedVp).toBe(14);
        expect(simC1.actualSimulatedVp).toBe(16);
      }
      expect(
        JSON.stringify({
          ...observed,
          topology: undefined,
          cornerPiece: Array.from(observed.cornerPiece)
        })
      ).toBe(observedBefore);

      // 3. Fail-closed checks for unsupported board variants, 5–6 players, Special Building Phase, and expansions
      const topo = observed.topology;
      expect(
        createInitialConcreteState({
          topology: topo,
          playerIds: ["c1", "c2", "c3", "c4", "c5"]
        }).ok
      ).toBe(false);
      expect(
        createInitialConcreteState({
          topology: topo,
          playerIds: ["c1", "c2"],
          rules: { specialBuildingPhase: true }
        }).ok
      ).toBe(false);
      expect(
        createInitialConcreteState({
          topology: topo,
          playerIds: ["c1", "c2"],
          rules: { extensionSetting: 1 }
        }).ok
      ).toBe(false);

      const nonStandardTopo = buildBoardTopology({
        ...farmParsed.board!,
        hexes: farmParsed.board!.hexes.slice(0, 18)
      });
      expect(nonStandardTopo.variant.isStandard19Hex).toBe(false);
      const nonStdRes = createInitialConcreteState({
        topology: nonStandardTopo,
        playerIds: ["c1", "c2"]
      });
      expect(nonStdRes.ok).toBe(false);
      if (!nonStdRes.ok) {
        expect(nonStdRes.error.code).toBe("unsupported_variant");
      }
    });

    it("9. Measures getLegalActions and applyAction latency across representative game phases", () => {
      const topo = getStandardTopology();
      const initRes = createInitialConcreteState({ topology: topo, playerIds: ["c1", "c2"] });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      let state = initRes.state;

      // Run setup + 20 turns of legal actions and measure latency
      let getLegalCalls = 0;
      let getLegalMs = 0;
      let applyCalls = 0;
      let applyMs = 0;

      for (let step = 0; step < 60 && state.phase !== "game_over"; step++) {
        const actorId =
          state.phase === "discard"
            ? state.players.find((p) => p.pendingDiscardCount > 0)!.id
            : state.players[state.turnPlayerIndex].id;

        const t0 = performance.now();
        const actions = getLegalActions(state, actorId);
        const t1 = performance.now();
        getLegalMs += t1 - t0;
        getLegalCalls++;

        expect(actions.length).toBeGreaterThan(0);
        const chosen = actions[step % actions.length];
        let outcome: ActionOutcome | undefined;
        if (chosen.type === "rollDice") {
          const totals = [6, 8, 5, 9, 7, 4, 10];
          const tot = totals[step % totals.length];
          outcome = { dice: { total: tot } };
        } else if (chosen.type === "moveRobber" && typeof chosen.victimId === "string") {
          const v = state.players.find((p) => p.id === chosen.victimId)!;
          const r = (["lumber", "brick", "wool", "grain", "ore"] as const).find((k) => v.hand[k] > 0)!;
          outcome = { stolenResource: r };
        }

        const t2 = performance.now();
        const res = applyAction(state, actorId, chosen, outcome);
        const t3 = performance.now();
        applyMs += t3 - t2;
        applyCalls++;

        expect(res.ok).toBe(true);
        if (!res.ok) break;
        state = res.state;
        expect(validateConcreteSimState(state).valid).toBe(true);
      }

      const avgGetLegalUs = (getLegalMs * 1000) / getLegalCalls;
      const avgApplyUs = (applyMs * 1000) / applyCalls;
      console.log(
        `[Stage 3.2 Benchmarks across ${applyCalls} transitions] getLegalActions: ${avgGetLegalUs.toFixed(1)} µs/call | applyAction (incl. deep clone & Longest Road): ${avgApplyUs.toFixed(1)} µs/call`
      );
    });
  });

  // ===========================================================================
  // STAGE 3.3 — Dice Modeling, Hidden-Information Determinization & Rollout Engine
  // ===========================================================================
  describe("Stage 3.3 — Dice Modeling, Hidden-Information Determinization, and Rollout Engine", () => {
    function buildMidgameObservedFixture(recId: string, frameLimit: number) {
      const rec = recordings.find((r) => r.id === recId)!;
      const { decoded } = decodeFrames(rec.frames.slice(0, frameLimit));
      const parsed = stateDiffAdapter.parse(decoded);
      const placements = placementsFrom(parsed.events);
      return buildObservedGameState({
        board: parsed.board!,
        placements,
        snapshot: parsed.snapshot,
        events: parsed.events,
        selfId: parsed.selfId,
        warnings: parsed.warnings
      });
    }

    it("1. Reproducible SeededRng & Standard Fair Two-Dice Model (exact probabilities and sampling)", () => {
      // SeededRng reproducibility, bounds, weightedIndex, shuffle, clone, and fork
      const rngA = createSeededRng(424242);
      const rngB = createSeededRng(424242);
      const clonedA = rngA.clone();

      for (let i = 0; i < 200; i++) {
        const fA = rngA.nextFloat();
        const fB = rngB.nextFloat();
        const fClone = clonedA.nextFloat();
        expect(fA).toBe(fB);
        expect(fA).toBe(fClone);
        expect(Number.isNaN(fA)).toBe(false);
        expect(fA).toBeGreaterThanOrEqual(0);
        expect(fA).toBeLessThan(1);

        const intA = rngA.nextIntRange(2, 12);
        const intB = rngB.nextIntRange(2, 12);
        const intClone = clonedA.nextIntRange(2, 12);
        expect(intA).toBe(intB);
        expect(intA).toBe(intClone);
        expect(intA).toBeGreaterThanOrEqual(2);
        expect(intA).toBeLessThanOrEqual(12);
      }

      const arr = [10, 20, 30, 40, 50];
      const shufA = rngA.shuffle(arr);
      const shufB = rngB.shuffle(arr);
      expect(shufA).toEqual(shufB);
      expect(arr).toEqual([10, 20, 30, 40, 50]); // original never mutated

      // Independent trial seeds never depend on execution order
      expect(deriveTrialSeed("match-seed", 0)).toBe(deriveTrialSeed("match-seed", 0));
      expect(deriveTrialSeed("match-seed", 1)).not.toBe(deriveTrialSeed("match-seed", 0));
      expect(() => hashSeed(NaN)).toThrow();
      expect(() => rngA.nextInt(0)).toThrow();
      expect(() => rngA.weightedIndex([-1, 2])).toThrow();
      expect(() => rngA.weightedIndex([0, 0])).toThrow();

      // Standard Fair 2d6 Model
      const fairModel = new StandardFairDiceModel();
      expect(fairModel.id).toBe("standard_fair_2d6");
      expect(fairModel.mode).toBe("random");
      expect(fairModel.status).toBe("exact_validated");
      expect(fairModel.isExact).toBe(true);

      const distRes = fairModel.getDistribution();
      expect(distRes.ok).toBe(true);
      expect(distRes.diagnostics.isExact).toBe(true);
      expect(distRes.diagnostics.status).toBe("exact_validated");

      let probSum = 0;
      for (const s of DICE_SUMS) {
        const expected = FAIR_2D6_COMBINATION_COUNTS[s] / 36;
        expect(distRes.probabilities[s]).toBeCloseTo(expected, 12);
        probSum += distRes.probabilities[s];
      }
      expect(probSum).toBeCloseTo(1.0, 12);

      // Reproducible sampling & empirical convergence to exact 2d6 distribution
      const sampleRng1 = createSeededRng(777);
      const sampleRng2 = createSeededRng(777);
      const counts = Object.fromEntries(DICE_SUMS.map((s) => [s, 0])) as Record<number, number>;
      const N = 18000;
      for (let i = 0; i < N; i++) {
        const s1 = fairModel.sampleOutcome(sampleRng1);
        const s2 = fairModel.sampleOutcome(sampleRng2);
        expect(s1.ok).toBe(true);
        expect(s1.outcome).toEqual(s2.outcome);
        const { d1, d2, total } = s1.outcome!;
        expect(d1).toBeGreaterThanOrEqual(1);
        expect(d1).toBeLessThanOrEqual(6);
        expect(d2).toBeGreaterThanOrEqual(1);
        expect(d2).toBeLessThanOrEqual(6);
        expect(d1 + d2).toBe(total);
        counts[total] += 1;
      }
      for (const s of DICE_SUMS) {
        expect(counts[s] / N).toBeCloseTo(FAIR_2D6_PROBABILITIES[s], 2);
      }
    });

    it("2. Balanced Dice Models: metadata, explicit empirical-approximation status, normalization, and fail-closed unknown mode", () => {
      const shoeModel = new Balanced24Of36ShoeDiceModel();
      const marginalModel = new BalancedStationaryMarginalDiceModel();
      const unsupportedModel = new UnsupportedDiceModel();

      // Balanced Dice models must NEVER be labeled exact
      expect(shoeModel.status).toBe("empirical_approximation");
      expect(shoeModel.isExact).toBe(false);
      expect(marginalModel.status).toBe("empirical_approximation");
      expect(marginalModel.isExact).toBe(false);
      expect(unsupportedModel.status).toBe("unsupported_mode");
      expect(unsupportedModel.isExact).toBe(false);

      // Verify probability normalization across empty, mid-cycle, reshuffle-boundary (24 rolls), and misaligned histories
      const histories: Array<{ hist: number[]; aligned: "aligned" | "misaligned_midgame" | "unknown" }> = [
        { hist: [], aligned: "aligned" },
        { hist: [7, 7, 6, 8, 5, 9, 7, 4, 10, 2, 12], aligned: "aligned" },
        { hist: new Array(24).fill(0).map((_, i) => DICE_SUMS[i % DICE_SUMS.length]), aligned: "aligned" },
        { hist: [6, 6, 6, 6, 6, 7], aligned: "misaligned_midgame" },
        { hist: [8, 9, 10], aligned: "unknown" }
      ];

      for (const { hist, aligned } of histories) {
        for (const model of [shoeModel, marginalModel]) {
          const d = model.getDistribution({ rollHistory: hist, alignmentStatus: aligned });
          expect(d.ok).toBe(true);
          expect(d.diagnostics.isExact).toBe(false);
          expect(d.diagnostics.status).toBe("empirical_approximation");
          expect(d.diagnostics.confidence).toBe("provisional_empirical");
          expect(d.diagnostics.assumptions.length).toBeGreaterThan(0);
          expect(d.diagnostics.limitations.length).toBeGreaterThan(0);

          let sum = 0;
          for (const s of DICE_SUMS) {
            const p = d.probabilities[s];
            expect(Number.isFinite(p)).toBe(true);
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(1);
            sum += p;
          }
          expect(sum).toBeCloseTo(1.0, 12);
        }
      }

      // When aligned and 2 occurs once in the current 24-roll cycle, 2 has 0 copies left in the 36-combination shoe
      const afterTwo = shoeModel.getDistribution({ rollHistory: [2], alignmentStatus: "aligned" });
      expect(afterTwo.diagnostics.alignmentUsed).toBe(true);
      expect(afterTwo.diagnostics.cycleRollsUsed).toBe(1);
      expect(afterTwo.diagnostics.bagRemainingInShoe).toBe(35);
      expect(afterTwo.probabilities[2]).toBe(0);

      // At exactly 24 rolls, the shoe reshuffles back to 36 combinations
      const cycle24 = [7, 7, 7, 7, 7, 7, 6, 6, 6, 6, 6, 8, 8, 8, 8, 8, 5, 5, 5, 5, 9, 9, 9, 9];
      const atReset = shoeModel.getDistribution({ rollHistory: cycle24, alignmentStatus: "aligned" });
      expect(atReset.diagnostics.cycleRollsUsed).toBe(0);
      expect(atReset.diagnostics.bagRemainingInShoe).toBe(36);
      expect(atReset.probabilities[2]).toBeGreaterThan(0);

      // When misaligned midgame, shoeModel must NOT claim cycle alignment
      const misaligned = shoeModel.getDistribution({ rollHistory: [2], alignmentStatus: "misaligned_midgame" });
      expect(misaligned.diagnostics.alignmentUsed).toBe(false);
      expect(misaligned.probabilities[2]).toBeGreaterThan(0);

      // Unknown dice mode must fail closed unless an explicit modelId + allowApproximationForUnknownMode is supplied
      const failUnknown = resolveDiceModelForRules("unknown");
      expect(failUnknown.ok).toBe(false);
      expect(failUnknown.model.status).toBe("unsupported_mode");
      expect(failUnknown.model.sampleOutcome(createSeededRng(1)).ok).toBe(false);

      const explicitOverride = resolveDiceModelForRules("unknown", {
        modelId: "balanced_stationary_marginal_approx",
        allowApproximationForUnknownMode: true
      });
      expect(explicitOverride.ok).toBe(true);
      expect(explicitOverride.model.id).toBe("balanced_stationary_marginal_approx");
      expect(explicitOverride.model.isExact).toBe(false);
    });

    it.skipIf(!recordingsAvailable)("3. Recording-level empirical dice partitioning and holdout calibration (51 1v1 games vs 2 4P Rush games) (recording fixture required)", () => {
      // Partition all 53 recordings by gameSettings (modeSetting, maxPlayers, diceSetting)
      const oneVOneRollSeqs: number[][] = [];
      const rush4pRollSeqs: number[][] = [];

      for (const rec of recordings) {
        const parsed = stateDiffAdapter.parse(decodeFrames(rec.frames).decoded);
        const gs = parsed.snapshot?.gameSettings;
        const rolls = parsed.events
          .filter((e): e is Extract<(typeof parsed.events)[number], { type: "roll" }> => e.type === "roll")
          .map((e) => e.total);
        if (gs?.diceSetting === 1 && gs?.modeSetting === 0 && gs?.maxPlayers === 2) {
          oneVOneRollSeqs.push(rolls);
        } else if (gs?.diceSetting === 1 && gs?.modeSetting === 12 && gs?.maxPlayers === 4) {
          rush4pRollSeqs.push(rolls);
        }
      }

      // Verify dataset partitioning matches documented empirical summary
      expect(oneVOneRollSeqs.length).toBe(51);
      expect(rush4pRollSeqs.length).toBe(2);

      const stats1v1 = computeRollSequenceStats(oneVOneRollSeqs);
      const statsRush = computeRollSequenceStats(rush4pRollSeqs);
      expect(stats1v1.totalRolls).toBe(COLONIST_1V1_EMPIRICAL_DICE_SUMMARY.partitions.standard1v1Balanced.totalRolls);
      expect(statsRush.totalRolls).toBe(COLONIST_1V1_EMPIRICAL_DICE_SUMMARY.partitions.rush4pBalanced.totalRolls);

      // 1. Disjoint 36-roll windows frequently violate the 36-combination cap (91/128 in 1v1), falsifying a single 36-card deck
      expect(stats1v1.disjoint36WindowViolations.violatingWindows).toBeGreaterThan(80);
      // 2. Disjoint 24-roll windows have ZERO violations across all 51 1v1 games (0/174) and across the 2 Rush games (0/6)
      expect(stats1v1.disjoint24WindowViolations.violatingWindows).toBe(0);
      expect(statsRush.disjoint24WindowViolations.violatingWindows).toBe(0);
      // 3. Consecutive sum repeat rate (lag 1) is significantly suppressed relative to fair 2d6 (7.42% vs 11.27%)
      expect(stats1v1.lag1RepeatRate).toBeLessThan(0.085);

      // Recording-level holdout evaluation: 35 training games vs 16 held-out test games
      const holdoutGames = oneVOneRollSeqs.slice(35);
      expect(holdoutGames.length).toBe(16);

      const fairModel = createDiceModel("standard_fair_2d6");
      const marginalModel = createDiceModel("balanced_stationary_marginal_approx");
      const shoeModel = createDiceModel("balanced_24_of_36_shoe_approx");

      const calibration = evaluateDiceModelsOnHoldoutGames([fairModel, marginalModel, shoeModel], holdoutGames, "aligned");
      const [calFair, calMarginal, calShoe] = calibration;

      expect(calFair.rollsEvaluated).toBe(1144);
      expect(calFair.isExact).toBe(true);
      expect(calMarginal.isExact).toBe(false);
      expect(calShoe.isExact).toBe(false);

      // On the 16 held-out games, the 24-of-36 shoe empirical approximation improves both NLL and Brier over fair 2d6 and stationary marginal
      expect(calShoe.nllPerRoll).toBeLessThan(calFair.nllPerRoll - 0.08);
      expect(calShoe.nllPerRoll).toBeLessThan(calMarginal.nllPerRoll - 0.08);
      expect(calShoe.brierPerRoll).toBeLessThan(calFair.brierPerRoll - 0.01);
    });

    it.skipIf(!recordingsAvailable)("4–8. Hidden-Information Determinization: exact self hands, bounded opponent hands, resource conservation, and dev-card sampling without replacement (recording fixture required)", () => {
      // Mid-game state from farm9373 (frame 1000: turnState=2, actionState=0 -> phase 'main')
      const farmRec = recordings.find((r) => r.id === "farm9373")!;
      const { decoded } = decodeFrames(farmRec.frames.slice(0, 1000));
      const parsed = stateDiffAdapter.parse(decoded);
      const placements = placementsFrom(parsed.events);

      // Build observed state with HandTracker bounds on opponent c1
      const baseObs = buildObservedGameState({
        board: parsed.board!,
        placements,
        snapshot: parsed.snapshot,
        events: parsed.events,
        selfId: parsed.selfId,
        warnings: parsed.warnings
      });

      // Construct an observed state with nontrivial lower/upper resource bounds and face-down dev cards (including 1 bought this turn)
      const oppOrig = baseObs.playerById["c1"];
      const selfOrig = baseObs.playerById["c5"];
      expect(selfOrig.hand.exact).not.toBeNull();
      expect(selfOrig.hand.inferenceSource).toBe("authoritative");

      const customObs = cloneObservedGameState(baseObs);
      const mutOpp = customObs.players.find((p) => p.id === "c1")!;
      // Set opponent handSize = 6, with knownMin: { lumber: 2, brick: 1, wool: 0, grain: 0, ore: 0 }, maxPossible: { lumber: 4, brick: 3, wool: 2, grain: 1, ore: 0 }
      (mutOpp as { hand: typeof mutOpp.hand }).hand = {
        exact: null,
        knownMin: { lumber: 2, brick: 1, wool: 0, grain: 0, ore: 0 },
        maxPossible: { lumber: 4, brick: 3, wool: 2, grain: 1, ore: 0 },
        likely: { lumber: 3, brick: 2, wool: 1, grain: 0, ore: 0 },
        handSize: 6,
        unknownCount: 3,
        confidence: "bounded",
        inferenceSource: "hand_tracker"
      };
      // Also give opponent 3 face-down dev cards: 1 bought this turn, 2 playable now, and cap maxUnrevealedVpDevs at 1
      const bankDevsBefore = customObs.devDeck.unseenTotal;
      const otherUnknownDevs = selfOrig.devs.unknownInHand;
      (mutOpp as { devs: typeof mutOpp.devs }).devs = {
        ...mutOpp.devs,
        totalInHand: 3,
        readyActionDevs: [],
        boughtActionDevsThisTurn: [],
        confirmedVpDevs: 0,
        unknownInHand: 3,
        unknownBoughtThisTurn: 1,
        unknownPlayableNow: 2
      };
      (mutOpp as { vp: typeof mutOpp.vp }).vp = {
        ...mutOpp.vp,
        maxUnrevealedVpDevs: 1,
        maxPossibleVp: mutOpp.vp.totalConfirmedVp + 1
      };
      (customObs as { bank: typeof customObs.bank }).bank = {
        resources: null,
        totalResourcesLeft: 95 - (selfOrig.hand.handSize + 6),
        confidence: "hidden_by_settings"
      };
      (customObs as { devDeck: typeof customObs.devDeck }).devDeck = {
        ...customObs.devDeck,
        bankRemaining: bankDevsBefore - 3 - otherUnknownDevs,
        bankRemainingConfidence: "authoritative"
      };
      (customObs.playerById as Record<string, typeof mutOpp>)["c1"] = mutOpp;

      const snapshotBefore = JSON.stringify({
        ...customObs,
        topology: undefined,
        cornerPiece: Array.from(customObs.cornerPiece)
      });

      // Sample 40 determinizations under both 'likely_prior' and 'uniform_within_bounds'
      let totalLumberLikely = 0;
      let totalLumberUniform = 0;
      let sawVpDev = false;
      let sawZeroVpDev = false;

      for (let i = 0; i < 40; i++) {
        const resLikely = sampleDeterminization(customObs, createSeededRng(1000 + i), {
          resourceSamplingPolicy: "likely_prior"
        });
        expect(resLikely.ok, !resLikely.ok ? resLikely.error.message : "").toBe(true);
        if (!resLikely.ok) return;

        const resUniform = sampleDeterminization(customObs, createSeededRng(1000 + i), {
          resourceSamplingPolicy: "uniform_within_bounds"
        });
        expect(resUniform.ok, !resUniform.ok ? resUniform.error.message : "").toBe(true);
        if (!resUniform.ok) return;

        for (const res of [resLikely, resUniform]) {
          // 1. Concrete state invariant validation (including 19-per-resource and 25-dev-card conservation)
          const val = validateConcreteSimState(res.state);
          expect(val.valid, val.errors.join("; ")).toBe(true);

          // 2. Self hand (c5) is preserved identically
          const simSelf = res.state.players.find((p) => p.id === "c5")!;
          expect(simSelf.hand).toEqual(selfOrig.hand.exact);

          // 3. Opponent hand (c1) preserves handSize = 6 and respects all knownMin and maxPossible bounds
          const simOpp = res.state.players.find((p) => p.id === "c1")!;
          const oppSum = Object.values(simOpp.hand).reduce((a, b) => a + b, 0);
          expect(oppSum).toBe(6);
          expect(simOpp.hand.lumber).toBeGreaterThanOrEqual(2);
          expect(simOpp.hand.lumber).toBeLessThanOrEqual(4);
          expect(simOpp.hand.brick).toBeGreaterThanOrEqual(1);
          expect(simOpp.hand.brick).toBeLessThanOrEqual(3);
          expect(simOpp.hand.wool).toBeGreaterThanOrEqual(0);
          expect(simOpp.hand.wool).toBeLessThanOrEqual(2);
          expect(simOpp.hand.grain).toBeGreaterThanOrEqual(0);
          expect(simOpp.hand.grain).toBeLessThanOrEqual(1);
          expect(simOpp.hand.ore).toBe(0); // maxPossible.ore === 0 enforced strictly!

          // 4. Dev card allocation: 3 unknown cards partitioned into readyDevs, boughtDevsThisTurn, and vpDevs (<= 1 VP dev)
          expect(simOpp.readyDevs.length + simOpp.boughtDevsThisTurn.length + simOpp.vpDevs).toBe(3);
          expect(simOpp.vpDevs).toBeLessThanOrEqual(1); // respects maxUnrevealedVpDevs = 1
          expect(simOpp.boughtDevsThisTurn.length).toBeLessThanOrEqual(1); // at most 1 card was bought this turn
          expect(simOpp.readyDevs.length).toBeLessThanOrEqual(2); // at most 2 cards were bought on prior turns
          expect(res.state.devDeckOrder.length).toBe(bankDevsBefore - 3 - otherUnknownDevs);

          // 5. Epistemic VP separation: observedConfirmedVp never includes sampled opponent VP dev cards
          expect(simOpp.observedConfirmedVp).toBe(mutOpp.vp.totalConfirmedVp);
          expect(simOpp.actualSimulatedVp).toBe(simOpp.visibleVp + simOpp.vpDevs);
          if (simOpp.vpDevs === 1) sawVpDev = true;
          if (simOpp.vpDevs === 0) sawZeroVpDev = true;
        }

        totalLumberLikely += resLikely.state.players.find((p) => p.id === "c1")!.hand.lumber;
        totalLumberUniform += resUniform.state.players.find((p) => p.id === "c1")!.hand.lumber;
      }

      expect(sawVpDev).toBe(true);
      expect(sawZeroVpDev).toBe(true);
      expect(totalLumberLikely).toBeGreaterThanOrEqual(totalLumberUniform);

      // Verify observed state was never mutated across 80 determinization calls
      expect(
        JSON.stringify({
          ...customObs,
          topology: undefined,
          cornerPiece: Array.from(customObs.cornerPiece)
        })
      ).toBe(snapshotBefore);
    });

    it.skipIf(!recordingsAvailable)("9–10. Determinization diagnostic failures for inconsistent or impossible observed constraints without mutating input (recording fixture required)", () => {
      const baseObs = buildMidgameObservedFixture("farm9373", 1000);

      // Case A: sum(knownMin) > handSize
      const badMinObs = cloneObservedGameState(baseObs);
      const p1A = badMinObs.players.find((p) => p.id === "c1")!;
      (p1A as { hand: typeof p1A.hand }).hand = {
        ...p1A.hand,
        exact: null,
        handSize: 3,
        knownMin: { lumber: 2, brick: 2, wool: 0, grain: 0, ore: 0 },
        maxPossible: { lumber: 3, brick: 3, wool: 3, grain: 3, ore: 3 }
      };
      const resA = sampleDeterminization(badMinObs, createSeededRng(1));
      expect(resA.ok).toBe(false);
      if (!resA.ok) {
        expect(resA.error.code).toBe("inconsistent_resource_constraints");
      }

      // Case B: sum(maxPossible) < handSize
      const badMaxObs = cloneObservedGameState(baseObs);
      const p1B = badMaxObs.players.find((p) => p.id === "c1")!;
      (p1B as { hand: typeof p1B.hand }).hand = {
        ...p1B.hand,
        exact: null,
        handSize: 5,
        knownMin: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
        maxPossible: { lumber: 1, brick: 1, wool: 1, grain: 1, ore: 0 }
      };
      const resB = sampleDeterminization(badMaxObs, createSeededRng(1));
      expect(resB.ok).toBe(false);
      if (!resB.ok) {
        expect(resB.error.code).toBe("inconsistent_resource_constraints");
      }

      // Case C: Global 19-card supply conservation impossible across players + exact bank
      const badBankObs = cloneObservedGameState(baseObs);
      (badBankObs as { bank: typeof badBankObs.bank }).bank = {
        resources: { lumber: 19, brick: 19, wool: 19, grain: 19, ore: 19 },
        totalResourcesLeft: 95,
        confidence: "exact"
      };
      const resC = sampleDeterminization(badBankObs, createSeededRng(1));
      expect(resC.ok).toBe(false);
      if (!resC.ok) {
        expect(resC.error.code).toBe("resource_conservation_impossible");
      }

      // Case D: Impossible dev-card counts (unknownInHand exceeds unseenTotal)
      const badDevObs = cloneObservedGameState(baseObs);
      const p1D = badDevObs.players.find((p) => p.id === "c1")!;
      (p1D as { devs: typeof p1D.devs }).devs = {
        ...p1D.devs,
        totalInHand: 30,
        unknownInHand: 30,
        unknownPlayableNow: 30,
        unknownBoughtThisTurn: 0
      };
      const resD = sampleDeterminization(badDevObs, createSeededRng(1));
      expect(resD.ok).toBe(false);
      if (!resD.ok) {
        expect(resD.error.code).toBe("dev_conservation_impossible");
      }

      // Case E: Unknown diceMode without explicit diceModeOverride fails closed
      const unknownDiceObs = cloneObservedGameState(baseObs);
      (unknownDiceObs as { rules: typeof unknownDiceObs.rules }).rules = {
        ...unknownDiceObs.rules,
        diceMode: { setting: undefined, mode: "unknown", source: "unknown" }
      };
      const resE = sampleDeterminization(unknownDiceObs, createSeededRng(1));
      expect(resE.ok).toBe(false);
      if (!resE.ok) {
        expect(resE.error.code).toBe("unsupported_dice_mode");
      }
      const resEOverride = sampleDeterminization(unknownDiceObs, createSeededRng(1), {
        diceModeOverride: "balanced"
      });
      expect(resEOverride.ok).toBe(true);

      // Case F: Simultaneous Rush setup ('setup_waiting') or 'unknown' phase fails closed
      const rushWaitObs = cloneObservedGameState(baseObs);
      (rushWaitObs as { phase: typeof rushWaitObs.phase }).phase = "setup_waiting";
      const resF = sampleDeterminization(rushWaitObs, createSeededRng(1));
      expect(resF.ok).toBe(false);
      if (!resF.ok) {
        expect(resF.error.code).toBe("unsupported_phase");
      }
    });

    it.skipIf(!recordingsAvailable)("11–14. Baseline Rollout Engine: reproducibility, legal-action-only execution, immediate win handling, and cutoff/error statuses (recording fixture required)", () => {
      const topo = buildMidgameObservedFixture("farm9373", 1000).topology;
      const initRes = createInitialConcreteState({
        topology: topo,
        playerIds: ["c1", "c2"],
        rules: { victoryPointsToWin: 15, cardDiscardLimit: 9, friendlyRobber: true, diceMode: "balanced" }
      });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      const initialState = initRes.state;
      const initialSnapshot = JSON.stringify({
        ...initialState,
        topology: undefined,
        cornerPiece: Array.from(initialState.cornerPiece)
      });

      // 11 & 12. Identical seeds produce identical complete rollouts, every step is legal and passes validateConcreteSimState,
      // and initialState is never mutated
      const r1 = runRollout(initialState, createSeededRng(20261010), {
        validateEveryStep: true,
        recordTrace: true
      });
      const r2 = runRollout(initialState, createSeededRng(20261010), {
        validateEveryStep: true,
        recordTrace: true
      });

      expect(r1.status).toBe("completed");
      expect(r1.completed).toBe(true);
      expect(r1.winnerId).toBeDefined();
      expect(r1.diceModelId).toBe("balanced_24_of_36_shoe_approx");
      expect(r1.diceModelStatus).toBe("empirical_approximation");
      expect(r1.diceModelIsExact).toBe(false);

      expect(r2.status).toBe(r1.status);
      expect(r2.winnerId).toBe(r1.winnerId);
      expect(r2.actionsSimulated).toBe(r1.actionsSimulated);
      expect(r2.turnsSimulated).toBe(r1.turnsSimulated);
      expect(r2.sampledDiceRolls).toEqual(r1.sampledDiceRolls);
      expect(r2.trace).toEqual(r1.trace);
      expect(
        JSON.stringify({
          ...initialState,
          topology: undefined,
          cornerPiece: Array.from(initialState.cornerPiece)
        })
      ).toBe(initialSnapshot);

      // 13. Immediate winning-action handling: policy takes an immediate win via buildCity / playKnight without peeking at devDeckOrder
      const nearWinState = cloneConcreteSimState(r1.finalState);
      nearWinState.phase = "main";
      nearWinState.winnerId = undefined;
      nearWinState.turnPlayerIndex = 0;
      nearWinState.dice = { thrown: true, d1: 3, d2: 3, total: 6 };
      const p0 = nearWinState.players[0];
      const p1 = nearWinState.players[1];
      // Reset board to a clean 14-VP configuration for c1 with 1 upgradable settlement and city resources in hand
      nearWinState.cornerOwner.fill(null);
      nearWinState.cornerPiece.fill(0);
      nearWinState.edgeOwner.fill(null);
      nearWinState.cornerOwner[0] = "c1";
      nearWinState.cornerPiece[0] = 1; // settlement to upgrade
      nearWinState.cornerOwner[10] = "c2";
      nearWinState.cornerPiece[10] = 1;
      p0.settlementsLeft = 4;
      p0.citiesLeft = 4;
      p0.roadsLeft = 15;
      p0.hasLargestArmy = false;
      p0.hasLongestRoad = false;
      p0.knightsPlayed = 0;
      p0.readyDevs = [];
      p0.boughtDevsThisTurn = [];
      p0.playedDevs = [];
      p0.vpDevs = 13; // 1 visible + 13 vpDevs = 14 actualSimulatedVp (needs +1 VP to reach 15)
      p0.visibleVp = 1;
      p0.observedConfirmedVp = 14;
      p0.actualSimulatedVp = 14;
      p0.hand = { lumber: 2, brick: 2, wool: 1, grain: 2, ore: 3 };
      p1.settlementsLeft = 4;
      p1.citiesLeft = 4;
      p1.roadsLeft = 15;
      p1.hasLargestArmy = false;
      p1.hasLongestRoad = false;
      p1.knightsPlayed = 0;
      p1.readyDevs = [];
      p1.boughtDevsThisTurn = [];
      p1.playedDevs = [];
      p1.vpDevs = 0;
      p1.visibleVp = 1;
      p1.observedConfirmedVp = 1;
      p1.actualSimulatedVp = 1;
      p1.hand = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
      nearWinState.bank = { lumber: 17, brick: 17, wool: 18, grain: 17, ore: 16 };
      nearWinState.devDeckOrder = [
        ...new Array(14).fill("knight"),
        ...new Array(2).fill("roadBuilding"),
        ...new Array(2).fill("yearOfPlenty"),
        ...new Array(2).fill("monopoly")
      ].slice(0, 12) as typeof nearWinState.devDeckOrder;
      nearWinState.rules.devDeckComposition = {
        knight: 14,
        victoryPoint: 13,
        roadBuilding: 2,
        yearOfPlenty: 2,
        monopoly: 2
      };
      // Pad devDeckOrder to match devDeckComposition (33 - 13 = 20)
      while (nearWinState.devDeckOrder.length < 20) nearWinState.devDeckOrder.push("knight");

      expect(validateConcreteSimState(nearWinState).valid).toBe(true);
      const winActions = getLegalActions(nearWinState, "c1");
      expect(findImmediateWinningAction(nearWinState, "c1", winActions)).toEqual({
        type: "buildCity",
        cornerIndex: 0
      });

      const winRollout = runRollout(nearWinState, createSeededRng(99));
      expect(winRollout.status).toBe("completed");
      expect(winRollout.completed).toBe(true);
      expect(winRollout.winnerId).toBe("c1");
      expect(winRollout.actionsSimulated).toBe(1);

      // Verify findImmediateWinningAction does NOT peek at devDeckOrder[0] === 'victoryPoint' for buyDevCard
      const hiddenDeckWinState = cloneConcreteSimState(nearWinState);
      hiddenDeckWinState.players[0].hand = { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 };
      hiddenDeckWinState.bank = { lumber: 19, brick: 19, wool: 18, grain: 18, ore: 18 };
      hiddenDeckWinState.devDeckOrder[0] = "victoryPoint";
      hiddenDeckWinState.rules.devDeckComposition = {
        knight: 13,
        victoryPoint: 14,
        roadBuilding: 2,
        yearOfPlenty: 2,
        monopoly: 2
      };
      const hiddenActions = getLegalActions(hiddenDeckWinState, "c1");
      expect(hiddenActions.some((a) => a.type === "buyDevCard")).toBe(true);
      expect(findImmediateWinningAction(hiddenDeckWinState, "c1", hiddenActions)).toBeUndefined();

      // 14. Correct handling of terminal states, cutoffs, unsupported phases, and illegal policy actions
      const alreadyDone = runRollout(winRollout.finalState, createSeededRng(1));
      expect(alreadyDone.status).toBe("completed");
      expect(alreadyDone.completed).toBe(true);
      expect(alreadyDone.actionsSimulated).toBe(0);

      const maxActionsRes = runRollout(initialState, createSeededRng(1), { maxActions: 5 });
      expect(maxActionsRes.status).toBe("max_actions_reached");
      expect(maxActionsRes.completed).toBe(false);
      expect(maxActionsRes.winnerId).toBeUndefined();
      expect(maxActionsRes.actionsSimulated).toBe(5);

      const maxTurnsRes = runRollout(initialState, createSeededRng(1), { maxTurns: 2 });
      expect(maxTurnsRes.status).toBe("max_turns_reached");
      expect(maxTurnsRes.completed).toBe(false);
      expect(maxTurnsRes.winnerId).toBeUndefined();
      expect(maxTurnsRes.turnsSimulated).toBe(2);

      const badPhaseState = cloneConcreteSimState(initialState);
      (badPhaseState as { phase: string }).phase = "setup_waiting";
      const badPhaseRes = runRollout(badPhaseState, createSeededRng(1));
      expect(badPhaseRes.status).toBe("unsupported_phase");
      expect(badPhaseRes.completed).toBe(false);

      const illegalPolicy: RolloutPolicy = {
        id: "illegal_test_policy",
        selectAction: () => ({ type: "endTurn" }) // illegal during setup_settlement
      };
      const illegalPolicyRes = runRollout(initialState, createSeededRng(1), { policy: illegalPolicy });
      expect(illegalPolicyRes.status).toBe("unsupported_action");
      expect(illegalPolicyRes.completed).toBe(false);
    });

    it.skipIf(!recordingsAvailable)("15–16. Batch determinized rollouts, incomplete-trial accounting, model comparison, and Stage 3.3 performance benchmarks (recording fixture required)", () => {
      const midgameObs = buildMidgameObservedFixture("farm9373", 1000);
      expect(validateObservedState(midgameObs).valid).toBe(true);

      // Run batch under both Balanced Dice empirical approximations and verify reproducibility
      const batchA1 = runDeterminizedRollouts(midgameObs, {
        numTrials: 12,
        baseSeed: "stage-3.3-batch-seed",
        rolloutOptions: { diceModelId: "balanced_24_of_36_shoe_approx" }
      });
      const batchA2 = runDeterminizedRollouts(midgameObs, {
        numTrials: 12,
        baseSeed: "stage-3.3-batch-seed",
        rolloutOptions: { diceModelId: "balanced_24_of_36_shoe_approx" }
      });
      expect(batchA1).toEqual(batchA2);
      expect(batchA1.determinizationSuccessCount).toBe(12);
      expect(batchA1.determinizationFailureCount).toBe(0);
      expect(batchA1.failedRolloutCount).toBe(0);
      expect(batchA1.completedCount + batchA1.cutoffCount).toBe(12);
      expect(batchA1.completedCount).toBeGreaterThan(0);
      expect(batchA1.diceModelIsExact).toBe(false);
      expect(batchA1.diceModelStatus).toBe("empirical_approximation");

      const sumWins = Object.values(batchA1.winsByPlayerId).reduce((a, b) => a + b, 0);
      expect(sumWins).toBe(batchA1.completedCount);

      const batchStationary = runDeterminizedRollouts(midgameObs, {
        numTrials: 12,
        baseSeed: "stage-3.3-batch-seed",
        rolloutOptions: { diceModelId: "balanced_stationary_marginal_approx" }
      });
      expect(batchStationary.diceModelId).toBe("balanced_stationary_marginal_approx");
      expect(batchStationary.determinizationSuccessCount).toBe(12);

      // Verify cutoff trials are NEVER folded into wins or losses
      const cutoffBatch = runDeterminizedRollouts(midgameObs, {
        numTrials: 6,
        baseSeed: 555,
        rolloutOptions: { maxTurns: 1 }
      });
      expect(cutoffBatch.determinizationSuccessCount).toBe(6);
      expect(cutoffBatch.completedCount).toBe(0);
      expect(cutoffBatch.cutoffCount).toBe(6);
      expect(cutoffBatch.maxTurnsCutoffCount).toBe(6);
      expect(cutoffBatch.winsByPlayerId["c1"]).toBe(0);
      expect(cutoffBatch.winsByPlayerId["c5"]).toBe(0);
      expect(cutoffBatch.winRateAmongCompletedByPlayerId["c1"]).toBeNull();
      expect(cutoffBatch.winRateAmongCompletedByPlayerId["c5"]).toBeNull();
      expect(cutoffBatch.completionRate).toBe(0);

      // Measure Stage 3.3 determinization time, completed rollout throughput, and rollout length distribution
      const numBenchTrials = 20;
      let detTotalMs = 0;
      let completedRolloutMs = 0;
      let cutoffRolloutMs = 0;
      const completedTurnsList: number[] = [];
      const completedActionsList: number[] = [];

      for (let i = 0; i < numBenchTrials; i++) {
        const rng = createSeededRng(deriveTrialSeed("bench-stage-3.3", i));
        const tDet0 = performance.now();
        const det = sampleDeterminization(midgameObs, rng.fork("det"));
        const tDet1 = performance.now();
        detTotalMs += tDet1 - tDet0;
        expect(det.ok).toBe(true);
        if (!det.ok) continue;

        const tRoll0 = performance.now();
        const roll = runRollout(det.state, rng.fork("roll"), {
          validateEveryStep: false,
          initialRollHistory: midgameObs.dice.observedRolls,
          diceAlignmentStatus: midgameObs.dice.alignmentStatus
        });
        const tRoll1 = performance.now();

        if (roll.completed) {
          completedRolloutMs += tRoll1 - tRoll0;
          completedTurnsList.push(roll.turnsSimulated);
          completedActionsList.push(roll.actionsSimulated);
        } else {
          cutoffRolloutMs += tRoll1 - tRoll0;
        }
      }

      const sortedTurns = [...completedTurnsList].sort((a, b) => a - b);
      const sortedActions = [...completedActionsList].sort((a, b) => a - b);
      const median = (arr: number[]) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);
      const avgDetUs = (detTotalMs * 1000) / numBenchTrials;
      const avgRolloutMs = completedTurnsList.length > 0 ? completedRolloutMs / completedTurnsList.length : 0;
      const rolloutsPerSec = avgRolloutMs > 0 ? 1000 / avgRolloutMs : 0;

      console.log(
        `[Stage 3.3 Benchmarks (${numBenchTrials} trials from farm9373 midgame)] ` +
          `determinization: ${avgDetUs.toFixed(1)} µs/sample | ` +
          `completed: ${completedTurnsList.length}/${numBenchTrials} (${avgRolloutMs.toFixed(2)} ms/rollout, ${rolloutsPerSec.toFixed(1)} rollouts/sec) | ` +
          `turns simulated [min=${sortedTurns[0]}, median=${median(sortedTurns)}, max=${sortedTurns[sortedTurns.length - 1]}] | ` +
          `actions simulated [min=${sortedActions[0]}, median=${median(sortedActions)}, max=${sortedActions[sortedActions.length - 1]}] | ` +
          `cutoffMs=${cutoffRolloutMs.toFixed(2)} ms`
      );
    });
  });

  // ===========================================================================
  // STAGE 3.4 — Integrate the New Simulation Engine with the Existing Coach
  // ===========================================================================
  describe("Stage 3.4 — Coach Shadow-Mode Integration, Paired Candidate Evaluation, and Safety Boundaries", () => {
    function parseFixtureSlice(recId: string, frameLimit?: number) {
      const rec = recordings.find((r) => r.id === recId)!;
      const frames = frameLimit ? rec.frames.slice(0, frameLimit) : rec.frames;
      const { decoded } = decodeFrames(frames);
      const parsed = stateDiffAdapter.parse(decoded);
      const placements = placementsFrom(parsed.events);
      const me = parsed.selfId ?? parsed.players[0].id;
      const opp = parsed.players.find((p) => p.id !== me)!.id;
      return { rec, frames, decoded, parsed, placements, me, opp };
    }

    it.skipIf(!recordingsAvailable)("1. Preserves default coach behavior across planTurn, coachedOpening, robberTargets, and createHelper (recording fixture required)", () => {
      for (const recId of ["farm9373", "edge9896", "deck7708"]) {
        const { parsed, placements, me, rec } = parseFixtureSlice(recId, 850);
        const board = parsed.board!;

        // 1a. coachedOpening default vs shadow disabled vs shadow enabled
        const emptyPlacements = placementsFrom([]);
        const openDefault = coachedOpening(board, emptyPlacements, me, 3, true);
        const openDisabled = coachedOpening(board, emptyPlacements, me, 3, true, { enabled: false });
        const openShadow = coachedOpening(board, emptyPlacements, me, 3, true, {
          enabled: true,
          baseSeed: "stage-3.4-default-preserve",
          budget: { maxTrialsPerCandidate: 3, maxTurnsPerRollout: 60 }
        });

        expect(openDefault.shadowEvaluation).toBeUndefined();
        expect(openDisabled.shadowEvaluation).toBeUndefined();
        expect(openDefault).toEqual(openDisabled);
        expect(openShadow.shadowEvaluation).toBeDefined();
        expect(openShadow.shadowEvaluation?.fallbackToLegacyRecommendation).toBe(true);
        const { shadowEvaluation: _os, ...openShadowRest } = openShadow;
        expect(openShadowRest).toEqual(openDefault);

        // 1b. planTurn default vs shadow disabled vs shadow enabled
        const hand = { lumber: 1, brick: 1, wool: 1, grain: 2, ore: 3 };
        const turnDefault = planTurn({
          board,
          placements,
          me,
          hand,
          handKnown: true,
          snapshot: parsed.snapshot,
          events: parsed.events
        });
        const turnDisabled = planTurn({
          board,
          placements,
          me,
          hand,
          handKnown: true,
          snapshot: parsed.snapshot,
          events: parsed.events,
          shadowRollout: { enabled: false }
        });
        const turnShadow = planTurn({
          board,
          placements,
          me,
          hand,
          handKnown: true,
          snapshot: parsed.snapshot,
          events: parsed.events,
          shadowRollout: {
            enabled: true,
            baseSeed: "stage-3.4-turn-preserve",
            budget: { maxTrialsPerCandidate: 4, maxTurnsPerRollout: 60 }
          }
        });

        expect(turnDefault.shadowEvaluation).toBeUndefined();
        expect(turnDisabled.shadowEvaluation).toBeUndefined();
        expect(turnDefault).toEqual(turnDisabled);
        expect(turnShadow.shadowEvaluation).toBeDefined();
        expect(turnShadow.shadowEvaluation?.fallbackToLegacyRecommendation).toBe(true);
        const { shadowEvaluation: _ts, ...turnShadowRest } = turnShadow;
        expect(turnShadowRest).toEqual(turnDefault);

        // 1c. robberTargets unchanged
        const robTargets = robberTargets(board, placements, me, parsed.snapshot?.robberHex);
        const robShadow = evaluateRobberTargetsShadow(
          {
            board,
            placements,
            me,
            snapshot: parsed.snapshot,
            events: parsed.events
          },
          robTargets,
          { enabled: true, baseSeed: "stage-3.4-robber-preserve", budget: { maxTrialsPerCandidate: 3, maxTurnsPerRollout: 60 } }
        );
        expect(robShadow.fallbackToLegacyRecommendation).toBe(true);
        expect(robTargets).toEqual(robberTargets(board, placements, me, parsed.snapshot?.robberHex));

        // 1d. createHelper default vs shadow enabled
        const helperDefault = createHelper();
        const helperShadow = createHelper(3, {
          shadowRollout: {
            enabled: true,
            baseSeed: "stage-3.4-helper-preserve",
            budget: { maxTrialsPerCandidate: 3, maxTurnsPerRollout: 60 }
          }
        });
        for (const f of rec.frames.slice(0, 850)) {
          helperDefault.feed(f);
          helperShadow.feed(f);
        }
        const ctx = {
          meName: rec.meta.me,
          logNames: parsed.players.map((p) => p.name),
          rolls: 30,
          firstPlacedAt: () => undefined,
          loggedSettlements: () => 2,
          hook: { sockets: 1, frames: 850 }
        };
        const viewDefault = helperDefault.view([], ctx, Date.now() + 5000);
        const viewShadow = helperShadow.view([], ctx, Date.now() + 5000);
        expect(viewDefault.shadowEvaluation).toBeUndefined();
        expect(viewShadow.shadowEvaluation).toBeDefined();
        const { shadowEvaluation: _vs, ...viewShadowRest } = viewShadow;
        expect(viewShadowRest).toEqual(viewDefault);
      }
    });

    it.skipIf(!recordingsAvailable)("2. Reconstructs canonical ObservedGameState from live coach inputs while separating authoritative facts, inferred bounds, and sampled states (recording fixture required)", () => {
      const { parsed, placements, me, opp } = parseFixtureSlice("farm9373", 900);
      const board = parsed.board!;

      // Case A: Exact self hand + opponent log-tracked hand bounds
      const oppSnap = parsed.snapshot?.players.find((p) => p.id === opp);
      const oppTotal = oppSnap?.handSize ?? 3;
      const oppUnknown = Math.max(0, oppTotal - 1);
      const reconExact = reconstructObservedStateForShadow({
        board,
        placements,
        me,
        hand: { lumber: 2, brick: 1, wool: 0, grain: 2, ore: 3 },
        handKnown: true,
        snapshot: parsed.snapshot,
        events: parsed.events,
        oppHand: { lumber: 1, brick: 0, wool: 0, grain: 0, ore: 0 },
        oppUnknown
      });
      expect(reconExact.ok).toBe(true);
      if (!reconExact.ok) return;
      expect(reconExact.observed).toBeDefined();
      expect(reconExact.epistemicLayers.authoritativeFacts.selfHandExact).toBe(true);
      expect(reconExact.epistemicLayers.sampledLayerPolicy.exposesSampledCardsAsFacts).toBe(false);

      const obsExact = reconExact.observed;
      const selfPlayer = obsExact.players.find((p) => p.id === me)!;
      const oppPlayer = obsExact.players.find((p) => p.id === opp)!;
      expect(selfPlayer.hand.confidence).toBe("exact");
      expect(selfPlayer.hand.knownMin).toEqual({ lumber: 2, brick: 1, wool: 0, grain: 2, ore: 3 });
      expect(selfPlayer.hand.unknownCount).toBe(0);
      if (oppTotal >= 1) {
        expect(oppPlayer.hand.knownMin.lumber).toBeGreaterThanOrEqual(1);
      }

      // Case B: Unknown self hand does NOT fabricate an exact hand from input.hand
      const snapWithoutSelfCards = parsed.snapshot
        ? {
            ...parsed.snapshot,
            players: parsed.snapshot.players.map((p) => (p.id === me ? { ...p, hand: undefined } : p))
          }
        : undefined;
      const reconUnknown = reconstructObservedStateForShadow({
        board,
        placements,
        me,
        hand: { lumber: 9, brick: 9, wool: 9, grain: 9, ore: 9 },
        handKnown: false,
        snapshot: snapWithoutSelfCards,
        events: parsed.events
      });
      expect(reconUnknown.ok).toBe(true);
      if (!reconUnknown.ok) return;
      expect(reconUnknown.epistemicLayers.authoritativeFacts.selfHandExact).toBe(false);
    });

    it.skipIf(!recordingsAvailable)("3. Enforces supported vs unsupported state, topology, ruleset, phase, perspective, and dice mode gating (recording fixture required)", () => {
      const { parsed, placements, me, opp } = parseFixtureSlice("farm9373", 900);
      const board = parsed.board!;

      // Supported active self turn
      const activeSnap = {
        ...parsed.snapshot!,
        turnPlayer: me,
        turnState: 2,
        actionState: 0,
        dice: { d1: 3, d2: 5, sum: 8, thrown: true }
      };
      const reconSupported = reconstructObservedStateForShadow({
        board,
        placements,
        me,
        hand: { lumber: 1, brick: 1, wool: 1, grain: 1, ore: 1 },
        handKnown: true,
        snapshot: activeSnap,
        events: parsed.events
      });
      expect(reconSupported.ok).toBe(true);
      if (!reconSupported.ok) return;
      const gateOk = checkShadowEngineSupport(reconSupported.observed, me);
      expect(gateOk.supported).toBe(true);

      // Not self turn -> fails closed with not_self_turn
      const oppTurnSnap = { ...activeSnap, turnPlayer: opp };
      const reconOppTurn = reconstructObservedStateForShadow({
        board,
        placements,
        me,
        snapshot: oppTurnSnap,
        events: parsed.events
      });
      expect(reconOppTurn.ok).toBe(true);
      if (!reconOppTurn.ok) return;
      const gateNotSelf = checkShadowEngineSupport(reconOppTurn.observed, me);
      expect(gateNotSelf.supported).toBe(false);
      if (!gateNotSelf.supported) expect(gateNotSelf.failureCode).toBe("not_self_turn");

      // Stale state -> fails closed with stale_or_unavailable_state
      const reconStale = reconstructObservedStateForShadow(
        {
          board,
          placements,
          me,
          snapshot: activeSnap,
          events: parsed.events
        },
        { staleStateCheck: { isStale: true } }
      );
      expect(reconStale.ok).toBe(false);
      if (!reconStale.ok) expect(reconStale.errorCode).toBe("stale_or_unavailable_state");

      // Missing board -> fails closed with missing_board
      const reconNoBoard = reconstructObservedStateForShadow({
        board: undefined,
        placements,
        me
      });
      expect(reconNoBoard.ok).toBe(false);
      if (!reconNoBoard.ok) expect(reconNoBoard.errorCode).toBe("missing_board");

      // Missing self player -> fails closed with missing_self_player
      const reconNoSelf = reconstructObservedStateForShadow({
        board,
        placements,
        me: "",
        snapshot: activeSnap,
        events: parsed.events
      });
      expect(reconNoSelf.ok).toBe(false);
      if (!reconNoSelf.ok) expect(reconNoSelf.errorCode).toBe("missing_self_player");
      const gateUnseatedSelf = checkShadowEngineSupport(reconSupported.observed, "nonexistent_player");
      expect(gateUnseatedSelf.supported).toBe(false);
      if (!gateUnseatedSelf.supported) expect(gateUnseatedSelf.failureCode).toBe("missing_self_player");

      // Unsupported board topology (18 hexes) -> fails closed with unsupported_variant
      const badBoard = { ...board, hexes: board.hexes.slice(0, 18) };
      const reconBadTopo = reconstructObservedStateForShadow({
        board: badBoard,
        placements,
        me,
        snapshot: activeSnap,
        events: parsed.events
      });
      expect(reconBadTopo.ok).toBe(true);
      if (!reconBadTopo.ok) return;
      const gateBadTopo = checkShadowEngineSupport(reconBadTopo.observed, me);
      expect(gateBadTopo.supported).toBe(false);
      if (!gateBadTopo.supported) expect(gateBadTopo.failureCode).toBe("unsupported_variant");

      // Unsupported ruleset (extensionSetting: 1) -> fails closed with unsupported_ruleset
      const obsBadRules = {
        ...cloneObservedGameState(reconSupported.observed),
        rules: {
          ...reconSupported.observed.rules,
          extensionSetting: 1
        }
      };
      const gateBadRules = checkShadowEngineSupport(obsBadRules, me);
      expect(gateBadRules.supported).toBe(false);
      if (!gateBadRules.supported) expect(gateBadRules.failureCode).toBe("unsupported_ruleset");

      // Unsupported phase (unknown / setup_waiting / game_over) -> fails closed with unsupported_phase
      for (const badPhase of ["unknown", "setup_waiting", "game_over"] as const) {
        const obsBadPhase = {
          ...cloneObservedGameState(reconSupported.observed),
          phase: badPhase
        };
        const gateBadPhase = checkShadowEngineSupport(obsBadPhase, me);
        expect(gateBadPhase.supported).toBe(false);
        if (!gateBadPhase.supported) expect(gateBadPhase.failureCode).toBe("unsupported_phase");
      }

      // Unknown dice mode without explicit override -> fails closed with unsupported_dice_mode
      const obsUnknownDice = {
        ...cloneObservedGameState(reconSupported.observed),
        rules: {
          ...reconSupported.observed.rules,
          diceMode: {
            mode: "unknown" as const,
            source: "unknown" as const,
            confidence: "unknown" as const
          }
        }
      };
      const gateUnknownDice = checkShadowEngineSupport(obsUnknownDice, me);
      expect(gateUnknownDice.supported).toBe(false);
      if (!gateUnknownDice.supported) expect(gateUnknownDice.failureCode).toBe("unsupported_dice_mode");

      // Explicit diceModelId + allowApproximationForUnknownDiceMode allows evaluation when diceMode is unknown
      const gateOverriddenDice = checkShadowEngineSupport(obsUnknownDice, me, {
        diceModelId: "standard_fair_2d6",
        allowApproximationForUnknownDiceMode: true
      });
      expect(gateOverriddenDice.supported).toBe(true);
    });

    it.skipIf(!recordingsAvailable)("4. Maps supported coach candidates to exact SimulatedAction objects and explicitly marks compound/unsupported candidates (recording fixture required)", () => {
      const { parsed, placements, me, opp } = parseFixtureSlice("farm9373", 900);
      const board = parsed.board!;
      const recon = reconstructObservedStateForShadow({
        board,
        placements,
        me,
        hand: { lumber: 2, brick: 2, wool: 1, grain: 2, ore: 3 },
        handKnown: true,
        snapshot: {
          ...parsed.snapshot!,
          turnPlayer: me,
          turnState: 2,
          actionState: 0,
          dice: { d1: 3, d2: 5, thrown: true }
        },
        events: parsed.events
      });
      expect(recon.ok).toBe(true);
      if (!recon.ok) return;
      const obs = recon.observed;
      const sampleCornerAt = obs.topology.corners[0].at;
      const sampleEdgeAt = obs.topology.edges[0].at;
      const sampleHexId = obs.topology.hexes[0].colonistId;

      // Supported single-step candidates
      const cityMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "turn_action",
          candidateId: "c_city",
          actionId: "city",
          label: "City",
          isLegacyRecommended: true,
          legacyRank: 0,
          at: sampleCornerAt
        },
        obs,
        me,
        "main"
      );
      expect(cityMap.supported).toBe(true);
      expect(cityMap.simulatedAction).toEqual({ type: "buildCity", cornerIndex: 0 });

      const settleMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "turn_action",
          candidateId: "c_settle",
          actionId: "settle",
          label: "Settle",
          isLegacyRecommended: false,
          legacyRank: 1,
          at: sampleCornerAt
        },
        obs,
        me,
        "main"
      );
      expect(settleMap.supported).toBe(true);
      expect(settleMap.simulatedAction).toEqual({ type: "buildSettlement", cornerIndex: 0 });

      const roadMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "turn_action",
          candidateId: "c_road",
          actionId: "road",
          label: "Road",
          isLegacyRecommended: false,
          legacyRank: 2,
          edge: sampleEdgeAt,
          requiresTrade: false
        },
        obs,
        me,
        "main"
      );
      expect(roadMap.supported).toBe(true);
      expect(roadMap.simulatedAction).toEqual({ type: "buildRoad", edgeIndex: 0 });

      const devMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "turn_action",
          candidateId: "c_dev",
          actionId: "dev",
          label: "Buy dev",
          isLegacyRecommended: false,
          legacyRank: 3
        },
        obs,
        me,
        "main"
      );
      expect(devMap.supported).toBe(true);
      expect(devMap.simulatedAction).toEqual({ type: "buyDevCard" });

      const knightMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "turn_action",
          candidateId: "c_knight",
          actionId: "knight",
          label: "Play knight",
          isLegacyRecommended: false,
          legacyRank: 4
        },
        obs,
        me,
        "main"
      );
      expect(knightMap.supported).toBe(true);
      expect(knightMap.simulatedAction).toEqual({ type: "playKnight" });

      const rbMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "turn_action",
          candidateId: "c_rb",
          actionId: "roadBuild",
          label: "Play RB",
          isLegacyRecommended: false,
          legacyRank: 5
        },
        obs,
        me,
        "main"
      );
      expect(rbMap.supported).toBe(true);
      expect(rbMap.simulatedAction).toEqual({ type: "playRoadBuilding" });

      const yopMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "turn_action",
          candidateId: "c_yop",
          actionId: "yop",
          label: "Play YoP",
          isLegacyRecommended: false,
          legacyRank: 6,
          yopResources: ["ore", "grain"],
          compoundWithCity: false
        },
        obs,
        me,
        "main"
      );
      expect(yopMap.supported).toBe(true);
      expect(yopMap.simulatedAction).toEqual({ type: "playYearOfPlenty", resources: ["ore", "grain"] });

      const monoMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "turn_action",
          candidateId: "c_mono",
          actionId: "monopoly",
          label: "Play Monopoly",
          isLegacyRecommended: false,
          legacyRank: 7,
          monopolyResource: "ore"
        },
        obs,
        me,
        "main"
      );
      expect(monoMap.supported).toBe(true);
      expect(monoMap.simulatedAction).toEqual({ type: "playMonopoly", resource: "ore" });

      const passMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "turn_action",
          candidateId: "c_pass",
          actionId: "hold",
          label: "End turn",
          isLegacyRecommended: false,
          legacyRank: 8
        },
        obs,
        me,
        "main"
      );
      expect(passMap.supported).toBe(true);
      expect(passMap.simulatedAction).toEqual({ type: "endTurn" });

      const setupSettleMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "opening_settlement",
          candidateId: "c_ss",
          label: "Setup settle",
          isLegacyRecommended: true,
          legacyRank: 0,
          legacyScore: 90,
          at: sampleCornerAt
        },
        obs,
        me,
        "setup_settlement"
      );
      expect(setupSettleMap.supported).toBe(true);
      expect(setupSettleMap.simulatedAction).toEqual({ type: "placeSetupSettlement", cornerIndex: 0 });

      const setupRoadMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "setup_road",
          candidateId: "c_sr",
          label: "Setup road",
          isLegacyRecommended: true,
          legacyRank: 0,
          legacyScore: 80,
          edge: sampleEdgeAt
        },
        obs,
        me,
        "setup_road"
      );
      expect(setupRoadMap.supported).toBe(true);
      expect(setupRoadMap.simulatedAction).toEqual({ type: "placeSetupRoad", edgeIndex: 0 });

      const robberSingleVictimMap = mapLegacyCandidateToSimulatedAction(
        {
          kind: "robber_target",
          candidateId: "c_rob1",
          label: "Robber 1 victim",
          isLegacyRecommended: true,
          legacyRank: 0,
          legacyScore: 60,
          hexId: sampleHexId,
          targets: [opp]
        },
        obs,
        me,
        "robber_move"
      );
      expect(robberSingleVictimMap.supported).toBe(true);
      expect(robberSingleVictimMap.simulatedAction).toEqual({ type: "moveRobber", hexIndex: 0, victimId: opp });

      // Unsupported / compound / ambiguous candidates fail closed without silently approximating
      const unsupportedDescriptors: LegacyRecommendationCandidate[] = [
        { kind: "turn_action", candidateId: "u_burst", actionId: "burst", label: "Burst", isLegacyRecommended: false, legacyRank: 1 },
        { kind: "turn_action", candidateId: "u_cityTrade", actionId: "cityTrade", label: "City trade", isLegacyRecommended: false, legacyRank: 2, at: sampleCornerAt },
        { kind: "turn_action", candidateId: "u_settleTrade", actionId: "settleTrade", label: "Settle trade", isLegacyRecommended: false, legacyRank: 3, at: sampleCornerAt },
        { kind: "turn_action", candidateId: "u_trophy2", actionId: "trophy2", label: "Trophy 2", isLegacyRecommended: false, legacyRank: 4 },
        { kind: "turn_action", candidateId: "u_drop", actionId: "preRollDropWarning", label: "Pre-roll drop", isLegacyRecommended: false, legacyRank: 5 },
        { kind: "turn_action", candidateId: "u_spend", actionId: "spendDown", label: "Spend down", isLegacyRecommended: false, legacyRank: 6 },
        { kind: "turn_action", candidateId: "u_road_trade", actionId: "road", label: "Road w/ trade", isLegacyRecommended: false, legacyRank: 7, edge: sampleEdgeAt, requiresTrade: true },
        { kind: "turn_action", candidateId: "u_yop_city", actionId: "yop", label: "YoP + City", isLegacyRecommended: false, legacyRank: 8, yopResources: ["ore", "grain"], compoundWithCity: true },
        { kind: "turn_action", candidateId: "u_yop_1", actionId: "yop", label: "YoP 1 card", isLegacyRecommended: false, legacyRank: 9, yopResources: ["ore"] },
        { kind: "turn_action", candidateId: "u_mono_comp", actionId: "monopoly", label: "Mono + Build", isLegacyRecommended: false, legacyRank: 10, monopolyResource: "ore", compoundWithAction: "city" }
      ];
      for (const desc of unsupportedDescriptors) {
        const mapped = mapLegacyCandidateToSimulatedAction(desc, obs, me, "main");
        expect(mapped.supported, `Expected ${desc.candidateId} to be unsupported`).toBe(false);
        expect(mapped.simulatedAction).toBeUndefined();
        expect(mapped.unsupportedReason).toBeDefined();
      }

      // RobberTarget with multiple potential victims fails closed
      const multiVictimRobberCands = buildRobberCandidatesFromTargets([
        {
          hexId: sampleHexId,
          number: 8,
          resource: "ore",
          targets: ["opp1", "opp2"],
          blocksOpponent: 2,
          blocksSelf: 0,
          score: 42,
          note: "blocks 8 ore"
        }
      ]);
      expect(multiVictimRobberCands.length).toBe(1);
      const multiRobMap = mapLegacyCandidateToSimulatedAction(multiVictimRobberCands[0], obs, me, "robber_move");
      expect(multiRobMap.supported).toBe(false);
      if (!multiRobMap.supported) {
        expect(multiRobMap.unsupportedCode).toBe("ambiguous_robber_victim");
      }
    });

    it.skipIf(!recordingsAvailable)("5. Rejects illegal candidate actions via isActionLegal and applyAction on the cloned determinized state (recording fixture required)", () => {
      const { parsed, placements, me } = parseFixtureSlice("farm9373", 900);
      const board = parsed.board!;
      const activeSnap = {
        ...parsed.snapshot!,
        turnPlayer: me,
        turnState: 2,
        actionState: 0,
        dice: { d1: 3, d2: 5, sum: 8, thrown: true }
      };

      // Candidate 1: buildCity on an empty corner (illegal)
      // Candidate 2: buildSettlement with 0 resources (illegal)
      // Candidate 3: endTurn (legal)
      const emptyCornerAt = getBoardTopology(board).corners.find(
        (c) => !placements.settlements.has(c.at) && !placements.cities.has(c.at)
      )!.at;

      const report = evaluateCandidatesShadow(
        {
          board,
          placements,
          me,
          hand: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
          handKnown: true,
          snapshot: activeSnap,
          events: parsed.events
        },
        { source: "planTurn", headline: "Illegal test" },
        [
          {
            kind: "turn_action",
            candidateId: "illegal_city",
            actionId: "city",
            label: "Illegal City on empty corner",
            isLegacyRecommended: true,
            legacyRank: 0,
            at: emptyCornerAt
          },
          {
            kind: "turn_action",
            candidateId: "illegal_settle",
            actionId: "settle",
            label: "Illegal Settle with empty hand",
            isLegacyRecommended: false,
            legacyRank: 1,
            at: emptyCornerAt
          },
          {
            kind: "turn_action",
            candidateId: "legal_pass",
            actionId: "hold",
            label: "End turn",
            isLegacyRecommended: false,
            legacyRank: 2
          }
        ],
        {
          enabled: true,
          baseSeed: "stage-3.4-legality-rejection",
          budget: { maxTrialsPerCandidate: 4, maxTurnsPerRollout: 60 }
        }
      );

      const cityCand = report.candidateEvaluations.find((c) => c.candidate.candidateId === "illegal_city")!;
      const settleCand = report.candidateEvaluations.find((c) => c.candidate.candidateId === "illegal_settle")!;
      const passCand = report.candidateEvaluations.find((c) => c.candidate.candidateId === "legal_pass")!;

      expect(cityCand.evaluationStatus).toBe("rejected_illegal_candidate");
      expect(cityCand.isSufficientlySupported).toBe(false);
      expect(cityCand.failures.illegalAction).toBe(4);
      expect(cityCand.completedGames).toBe(0);

      expect(settleCand.evaluationStatus).toBe("rejected_illegal_candidate");
      expect(settleCand.isSufficientlySupported).toBe(false);
      expect(settleCand.failures.illegalAction).toBe(4);
      expect(settleCand.completedGames).toBe(0);

      expect(passCand.failures.illegalAction).toBe(0);
      expect(passCand.completedGames).toBeGreaterThan(0);
    });

    it.skipIf(!recordingsAvailable)("6 & 7. Evaluates candidates on paired determinized samples with order-independent seeds and deterministic repeatability (recording fixture required)", () => {
      const { parsed, placements, me } = parseFixtureSlice("farm9373", 900);
      const board = parsed.board!;
      const activeSnap = {
        ...parsed.snapshot!,
        turnPlayer: me,
        turnState: 2,
        actionState: 0,
        dice: { d1: 3, d2: 5, sum: 8, thrown: true }
      };
      const mySettlementAt = [...placements.settlements.entries()].find(([, owner]) => owner === me)![0];

      const candCity: LegacyRecommendationCandidate = {
        kind: "turn_action",
        candidateId: "cand_city",
        actionId: "city",
        label: "Upgrade city",
        isLegacyRecommended: true,
        legacyRank: 0,
        legacyScore: 100,
        at: mySettlementAt
      };
      const candDev: LegacyRecommendationCandidate = {
        kind: "turn_action",
        candidateId: "cand_dev",
        actionId: "dev",
        label: "Buy development card",
        isLegacyRecommended: false,
        legacyRank: 1,
        legacyScore: 55
      };
      const candPass: LegacyRecommendationCandidate = {
        kind: "turn_action",
        candidateId: "cand_pass",
        actionId: "hold",
        label: "Hold / End turn",
        isLegacyRecommended: false,
        legacyRank: 2,
        legacyScore: 0
      };

      const input = {
        board,
        placements,
        me,
        hand: { lumber: 0, brick: 0, wool: 1, grain: 2, ore: 3 },
        handKnown: true,
        snapshot: activeSnap,
        events: parsed.events
      };
      const summary = { source: "planTurn" as const, headline: "Upgrade city", primaryCandidateId: "cand_city" };
      const config = {
        enabled: true,
        baseSeed: "stage-3.4-paired-order-test",
        budget: {
          maxTrialsPerCandidate: 10,
          maxTurnsPerRollout: 80,
          minCompletedTrialsForSupport: 5,
          maxElapsedMs: 5000
        }
      };

      // Run 1: [candCity, candDev, candPass]
      const rep1 = evaluateCandidatesShadow(input, summary, [candCity, candDev, candPass], config);
      // Run 2: exact repeat
      const rep2 = evaluateCandidatesShadow(input, summary, [candCity, candDev, candPass], config);
      // Run 3: permuted candidate order [candPass, candCity, candDev]
      const repPermuted = evaluateCandidatesShadow(input, summary, [candPass, candCity, candDev], config);

      // Deterministic repeatability (excluding wall-clock elapsedMs)
      expect(rep1.experimentalTopCandidateId).toBe(rep2.experimentalTopCandidateId);
      expect(rep1.experimentalAgreesWithLegacy).toBe(rep2.experimentalAgreesWithLegacy);
      expect(rep1.candidateEvaluations.map((c) => ({ ...c, elapsedMs: 0 }))).toEqual(
        rep2.candidateEvaluations.map((c) => ({ ...c, elapsedMs: 0 }))
      );

      // Order independence: every candidate's rollout outcomes are 100% identical regardless of candidate ordering!
      for (const id of ["cand_city", "cand_dev", "cand_pass"]) {
        const c1 = rep1.candidateEvaluations.find((c) => c.candidate.candidateId === id)!;
        const cPerm = repPermuted.candidateEvaluations.find((c) => c.candidate.candidateId === id)!;
        expect(cPerm.completedGames).toBe(c1.completedGames);
        expect(cPerm.wins).toBe(c1.wins);
        expect(cPerm.losses).toBe(c1.losses);
        expect(cPerm.draws).toBe(c1.draws);
        expect(cPerm.cutoffs).toEqual(c1.cutoffs);
        expect(cPerm.empiricalWinRateAmongCompleted).toBe(c1.empiricalWinRateAmongCompleted);
        expect(cPerm.wilson95Interval).toEqual(c1.wilson95Interval);
        expect(cPerm.medianTurnsAmongCompleted).toBe(c1.medianTurnsAmongCompleted);
        expect(cPerm.medianActionsAmongCompleted).toBe(c1.medianActionsAmongCompleted);
      }

      // Paired comparison against legacy top candidate ("cand_city") is populated
      const devEval = rep1.candidateEvaluations.find((c) => c.candidate.candidateId === "cand_dev")!;
      expect(devEval.comparisonVsLegacyTop).toBeDefined();
      const pc = devEval.comparisonVsLegacyTop!;
      expect(pc.pairedCompletedTrials).toBe(
        pc.bothWon + pc.bothLost + pc.bothDrew + pc.candidateWonBaselineLost + pc.baselineWonCandidateLost
      );
    });

    it.skipIf(!recordingsAvailable)("8. Separates completed games from cutoffs and failures and computes honest Wilson intervals (recording fixture required)", () => {
      const { parsed, placements, me } = parseFixtureSlice("farm9373", 900);
      const board = parsed.board!;
      const activeSnap = {
        ...parsed.snapshot!,
        turnPlayer: me,
        turnState: 2,
        actionState: 0,
        dice: { d1: 3, d2: 5, sum: 8, thrown: true }
      };

      // Force maxTurnsPerRollout = 1 so every trial hits a cutoff
      const cutoffReport = evaluateCandidatesShadow(
        {
          board,
          placements,
          me,
          hand: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
          handKnown: true,
          snapshot: activeSnap,
          events: parsed.events
        },
        { source: "planTurn", headline: "Cutoff test" },
        [
          {
            kind: "turn_action",
            candidateId: "pass",
            actionId: "hold",
            label: "End turn",
            isLegacyRecommended: true,
            legacyRank: 0
          }
        ],
        {
          enabled: true,
          baseSeed: "stage-3.4-cutoff-accounting",
          budget: {
            maxTrialsPerCandidate: 6,
            maxTurnsPerRollout: 1,
            minCompletedTrialsForSupport: 1
          }
        }
      );

      expect(cutoffReport.status).toBe("inconclusive");
      const cand = cutoffReport.candidateEvaluations[0];
      expect(cand.determinizationAttempts).toBe(6);
      expect(cand.completedGames).toBe(0);
      expect(cand.wins).toBe(0);
      expect(cand.losses).toBe(0);
      expect(cand.draws).toBe(0);
      expect(cand.cutoffs.total).toBe(6);
      expect(cand.cutoffs.maxTurns).toBe(6);
      expect(cand.empiricalWinRateAmongCompleted).toBeNull();
      expect(cand.wilson95Interval).toBeNull();
      expect(cand.isSufficientlySupported).toBe(false);

      // Verify Wilson 95% interval bounds on known inputs
      expect(computeWilson95Interval(0, 0)).toBeNull();
      const wHalf = computeWilson95Interval(50, 100)!;
      expect(wHalf.lower).toBeGreaterThan(0.39);
      expect(wHalf.upper).toBeLessThan(0.61);
      const wAll = computeWilson95Interval(20, 20)!;
      expect(wAll.lower).toBeGreaterThan(0.8);
      expect(wAll.upper).toBe(1);
    });

    it.skipIf(!recordingsAvailable)("9 & 10. Enforces runtime budgets (candidates, trials, total rollouts, elapsed ms, simulated actions) and stale-work cancellation (recording fixture required)", () => {
      const { parsed, placements, me } = parseFixtureSlice("farm9373", 900);
      const board = parsed.board!;
      const activeSnap = {
        ...parsed.snapshot!,
        turnPlayer: me,
        turnState: 2,
        actionState: 0,
        dice: { d1: 3, d2: 5, sum: 8, thrown: true }
      };

      // 9a. Stale-work callback cancels mid-evaluation and marks stoppedByStaleCallback
      let checkCount = 0;
      const staleMidReport = evaluateCandidatesShadow(
        {
          board,
          placements,
          me,
          hand: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 },
          handKnown: true,
          snapshot: activeSnap,
          events: parsed.events
        },
        { source: "planTurn", headline: "Stale callback test" },
        [
          {
            kind: "turn_action",
            candidateId: "dev",
            actionId: "dev",
            label: "Buy dev",
            isLegacyRecommended: true,
            legacyRank: 0
          },
          {
            kind: "turn_action",
            candidateId: "pass",
            actionId: "hold",
            label: "End turn",
            isLegacyRecommended: false,
            legacyRank: 1
          }
        ],
        {
          enabled: true,
          baseSeed: "stage-3.4-stale-callback",
          budget: {
            maxTrialsPerCandidate: 10,
            isStaleCallback: () => {
              checkCount++;
              return checkCount >= 3;
            }
          }
        }
      );
      expect(staleMidReport.budgetDiagnostics.stoppedByStaleCallback).toBe(true);
      expect(staleMidReport.fallbackToLegacyRecommendation).toBe(true);

      // 9b. Helper stale state (logged settlements > network settlements for > STALE_AFTER_MS) falls back cleanly
      const helperStale = createHelper(3, {
        shadowRollout: { enabled: true, baseSeed: "stage-3.4-helper-stale" }
      });
      const rec = recordings.find((r) => r.id === "farm9373")!;
      for (const f of rec.frames.slice(0, 850)) helperStale.feed(f);
      const t0 = Date.now() + 5000;
      helperStale.view(
        [],
        {
          meName: rec.meta.me,
          logNames: parsed.players.map((p) => p.name),
          rolls: 30,
          firstPlacedAt: () => undefined,
          loggedSettlements: () => 99, // triggers behindSince
          hook: { sockets: 1, frames: 850 }
        },
        t0
      );
      const staleView = helperStale.view(
        [],
        {
          meName: rec.meta.me,
          logNames: parsed.players.map((p) => p.name),
          rolls: 30,
          firstPlacedAt: () => undefined,
          loggedSettlements: () => 99,
          hook: { sockets: 1, frames: 850 }
        },
        t0 + 4000
      );
      expect(staleView.lines[0]).toContain("The board data is behind the game");
      expect(staleView.shadowEvaluation?.status).toBe("stale_or_unavailable_state");
      expect(staleView.shadowEvaluation?.fallbackToLegacyRecommendation).toBe(true);

      // 10a. Budget enforcement: maxCandidates = 1 and maxTotalRollouts = 3
      const budgetReport = evaluateCandidatesShadow(
        {
          board,
          placements,
          me,
          hand: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 },
          handKnown: true,
          snapshot: activeSnap,
          events: parsed.events
        },
        { source: "planTurn", headline: "Budget cap test" },
        [
          {
            kind: "turn_action",
            candidateId: "dev",
            actionId: "dev",
            label: "Buy dev",
            isLegacyRecommended: true,
            legacyRank: 0
          },
          {
            kind: "turn_action",
            candidateId: "pass",
            actionId: "hold",
            label: "End turn",
            isLegacyRecommended: false,
            legacyRank: 1
          }
        ],
        {
          enabled: true,
          baseSeed: "stage-3.4-budget-test",
          budget: {
            maxCandidates: 1,
            maxTrialsPerCandidate: 10,
            maxTotalRollouts: 3,
            maxTurnsPerRollout: 60
          }
        }
      );
      expect(budgetReport.budgetDiagnostics.totalRolloutsExecuted).toBeLessThanOrEqual(3);
      expect(budgetReport.budgetDiagnostics.stoppedByRolloutCap).toBe(true);
      expect(budgetReport.budgetDiagnostics.candidatesSkippedByCap).toBe(1);
      expect(budgetReport.candidateEvaluations[1].evaluationStatus).toBe("skipped_budget_candidate_cap");

      // 10b. Budget enforcement: maxTotalSimulatedActions = 25
      const actionBudgetReport = evaluateCandidatesShadow(
        {
          board,
          placements,
          me,
          hand: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 },
          handKnown: true,
          snapshot: activeSnap,
          events: parsed.events
        },
        { source: "planTurn", headline: "Action cap test" },
        [
          {
            kind: "turn_action",
            candidateId: "pass",
            actionId: "hold",
            label: "End turn",
            isLegacyRecommended: true,
            legacyRank: 0
          }
        ],
        {
          enabled: true,
          baseSeed: "stage-3.4-action-budget",
          budget: {
            maxTrialsPerCandidate: 10,
            maxTotalSimulatedActions: 25
          }
        }
      );
      expect(actionBudgetReport.budgetDiagnostics.stoppedByActionCap).toBe(true);
    });

    it.skipIf(!recordingsAvailable)("11 & 12. Evaluates dice-model selection/fallback and compares legacy ranking vs shadow rollout evaluation on representative positions (recording fixture required)", () => {
      const { parsed, placements, me } = parseFixtureSlice("farm9373", 900);
      const board = parsed.board!;
      const activeSnap = {
        ...parsed.snapshot!,
        turnPlayer: me,
        turnState: 2,
        actionState: 0,
        dice: { d1: 3, d2: 5, sum: 8, thrown: true }
      };

      // 12a. Aligned Balanced Dice -> uses balanced_24_of_36_shoe_approx with modelsPlayerSevenStreakBalancing: false
      const alignedEvents = parsed.events.filter((e) => e.type !== "roll");
      const alignedReport = evaluateCandidatesShadow(
        {
          board,
          placements,
          me,
          hand: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 },
          handKnown: true,
          snapshot: { ...activeSnap, completedTurns: 0 },
          events: alignedEvents
        },
        { source: "planTurn", headline: "Aligned dice test" },
        [
          {
            kind: "turn_action",
            candidateId: "pass",
            actionId: "hold",
            label: "End turn",
            isLegacyRecommended: true,
            legacyRank: 0
          }
        ],
        {
          enabled: true,
          baseSeed: "stage-3.4-dice-aligned",
          budget: { maxTrialsPerCandidate: 3, maxTurnsPerRollout: 60 }
        }
      );
      expect(alignedReport.diceDiagnostics?.effectiveModelId).toBe("balanced_24_of_36_shoe_approx");
      expect(alignedReport.diceDiagnostics?.isExact).toBe(false);
      expect(alignedReport.diceDiagnostics?.status).toBe("empirical_approximation");
      expect(alignedReport.diceDiagnostics?.modelsPlayerSevenStreakBalancing).toBe(false);

      // 12b. Misaligned Balanced Dice -> automatically falls back to balanced_stationary_marginal_approx
      const misalignedReport = evaluateCandidatesShadow(
        {
          board,
          placements,
          me,
          hand: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 },
          handKnown: true,
          snapshot: { ...activeSnap, completedTurns: 99 }, // intentionally misaligned with roll events
          events: parsed.events
        },
        { source: "planTurn", headline: "Misaligned dice test" },
        [
          {
            kind: "turn_action",
            candidateId: "pass",
            actionId: "hold",
            label: "End turn",
            isLegacyRecommended: true,
            legacyRank: 0
          }
        ],
        {
          enabled: true,
          baseSeed: "stage-3.4-dice-misaligned",
          budget: { maxTrialsPerCandidate: 3, maxTurnsPerRollout: 60 }
        }
      );
      expect(misalignedReport.diceDiagnostics?.alignmentStatus).toBe("misaligned_midgame");
      expect(misalignedReport.diceDiagnostics?.effectiveModelId).toBe("balanced_stationary_marginal_approx");
      expect(misalignedReport.diceDiagnostics?.fallbackModelId).toBe("balanced_stationary_marginal_approx");
      expect(misalignedReport.diceDiagnostics?.isExact).toBe(false);
      expect(misalignedReport.diceDiagnostics?.modelsPlayerSevenStreakBalancing).toBe(false);

      // 12c. Standard Fair 2d6 override -> exact = true
      const fairReport = evaluateCandidatesShadow(
        {
          board,
          placements,
          me,
          hand: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 },
          handKnown: true,
          snapshot: activeSnap,
          events: parsed.events
        },
        { source: "planTurn", headline: "Fair dice test" },
        [
          {
            kind: "turn_action",
            candidateId: "pass",
            actionId: "hold",
            label: "End turn",
            isLegacyRecommended: true,
            legacyRank: 0
          }
        ],
        {
          enabled: true,
          baseSeed: "stage-3.4-dice-fair",
          diceModelId: "standard_fair_2d6",
          budget: { maxTrialsPerCandidate: 3, maxTurnsPerRollout: 60 }
        }
      );
      expect(fairReport.diceDiagnostics?.effectiveModelId).toBe("standard_fair_2d6");
      expect(fairReport.diceDiagnostics?.isExact).toBe(true);
      expect(fairReport.diceDiagnostics?.status).toBe("exact_validated");

      // 11. Side-by-side comparison across representative positions in farm9373, edge9896, and deck7708
      const benchmarkRows: string[] = [];
      for (const recId of ["farm9373", "edge9896", "deck7708"]) {
        const { parsed: p, placements: pl, me: selfId } = parseFixtureSlice(recId, 800);
        const b = p.board!;
        const snap = {
          ...p.snapshot!,
          turnPlayer: selfId,
          turnState: 2,
          actionState: 0,
          dice: { d1: 4, d2: 4, sum: 8, thrown: true }
        };
        const turnRes = planTurn({
          board: b,
          placements: pl,
          me: selfId,
          hand: { lumber: 1, brick: 1, wool: 1, grain: 2, ore: 3 },
          handKnown: true,
          snapshot: snap,
          events: p.events,
          shadowRollout: {
            enabled: true,
            baseSeed: `stage-3.4-bench-${recId}`,
            budget: {
              maxCandidates: 4,
              maxTrialsPerCandidate: 12,
              maxTotalRollouts: 48,
              maxElapsedMs: 2000,
              maxTurnsPerRollout: 120,
              minCompletedTrialsForSupport: 6
            }
          }
        });

        const se = turnRes.shadowEvaluation!;
        expect(se).toBeDefined();
        expect(se.status).toBe("evaluated");
        expect(se.fallbackToLegacyRecommendation).toBe(true);
        expect(se.candidateEvaluations.length).toBeGreaterThanOrEqual(2);

        const topShadow = se.candidateEvaluations.find(
          (c) => c.candidate.candidateId === se.experimentalTopCandidateId
        );
        benchmarkRows.push(
          `${recId}: status=${se.status} | legacyTop=${se.legacyRecommendation.primaryCandidateId} | shadowTop=${se.experimentalTopCandidateId} ` +
            `(winRate=${topShadow?.empiricalWinRateAmongCompleted !== null && topShadow?.empiricalWinRateAmongCompleted !== undefined ? (topShadow.empiricalWinRateAmongCompleted * 100).toFixed(1) + "%" : "n/a"}, ` +
            `CI=[${topShadow?.wilson95Interval ? `${(topShadow.wilson95Interval.lower * 100).toFixed(1)}%, ${(topShadow.wilson95Interval.upper * 100).toFixed(1)}%` : "n/a"}]) | ` +
            `agrees=${se.experimentalAgreesWithLegacy} (${topShadow?.comparisonVsLegacyTop?.classification ?? "n/a"}) | ` +
            `rollouts=${se.budgetDiagnostics.totalRolloutsExecuted} | ` +
            `timing(total=${se.timing.totalElapsedMs.toFixed(1)}ms, recon=${se.timing.stateReconstructionMs.toFixed(2)}ms, ` +
            `map=${se.timing.candidateMappingMs.toFixed(2)}ms, det=${se.timing.determinizationMs.toFixed(2)}ms, ` +
            `roll=${se.timing.rolloutExecutionMs.toFixed(1)}ms, agg=${se.timing.aggregationMs.toFixed(2)}ms)`
        );
      }

      console.log("[Stage 3.4 Shadow Evaluation Benchmarks]\n  " + benchmarkRows.join("\n  "));
    });
  });
});
