import { readFileSync } from "node:fs";
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
  cloneObservedGameState,
  validateConcreteSimState,
  validateObservedState,
  type ConcreteSimulatedGameState
} from "../src/analyzer/engine/state";
import type { Recording } from "../src/shared/schema";

const RECORDINGS_PATH = "C:/Users/ashma/Downloads/colonist-recordings-2026-10-08.json";

function loadRecordings(): Recording[] {
  const raw = JSON.parse(readFileSync(RECORDINGS_PATH, "utf8")) as { recordings: Recording[] };
  return raw.recordings;
}

describe("Stage 3.1 — Board Topology & Canonical Observed State Reconstruction", () => {
  const recordings = loadRecordings();

  describe("1. BoardTopology Construction, Reciprocal Adjacency & Colonist ID Mapping", () => {
    it("constructs complete 19-hex, 54-corner, 72-edge, 9-port topology with reciprocal adjacency and cached lookup", () => {
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

    it("preserves original Colonist corner, edge, and hex IDs distinctly from internal array indices", () => {
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
    it("reconstructs placements, road lengths, public/hidden VP, and uncertain opponent state on edge9896, farm9373, and deck7708", () => {
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

    it("preserves authoritative gameSettings, distinguishes defaults and unknown values, and refuses to map unrecognized phases to main", () => {
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

    it("handles mid-game or incomplete observations without fabricating exact state and separates observed vs concrete simulation validation", () => {
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

    it("supports 2–6 player seat order structurally and preserves boundaries for adaptive behavior telemetry, imperfect priors, and observed trades", () => {
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

    it("reconstructs valid ObservedGameState across all 53 captured recordings and measures reconstruction & clone latency", () => {
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
});
