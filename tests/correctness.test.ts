import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFrames } from "../src/analyzer/decode";
import {
  breakdownVp,
  DEV_CARD,
  FACE_DOWN_DEV_CARD_ID,
  findStatePatch,
  readGameSettings,
  readSnapshot,
  stateDiffAdapter,
  sumVp,
  VP_CATEGORY_WEIGHT
} from "../src/analyzer/adapters/stateDiff";
import { LogParser, normalizeRow, parseRow } from "../src/analyzer/adapters/logText";
import { placementsFrom, publicVp, robberTargets } from "../src/analyzer/advisor";
import { contextFor, isLegal } from "../src/analyzer/strategy";
import { buildNet, listOpenEdges, longestExtensions, longestRoad, networkLength, adviseRoad } from "../src/analyzer/engine/roads";
import { bagState } from "../src/analyzer/engine/value";
import { planTurn, playableCardsOf, roadBattle } from "../src/analyzer/engine/decide";
import { act, buyDev, endTurn, newPlayer, playDev, race, updateLargestArmy } from "../src/analyzer/engine/sim";
import type { Board, Placements } from "../src/analyzer/types";
import { loadRecordingCorpus, requireRecording } from "../src/analyzer/recordings/load";

const recordings = loadRecordingCorpus(resolve(__dirname, "..")).recordings;
const recordingsAvailable = recordings.length > 0;

function loadRecordings() {
  return recordings;
}

describe("Stage 2 — Acceptance Tests (Steps 2.1–2.5 Implemented)", () => {
  const recordings = loadRecordings();

  describe("1. [ACCEPTANCE — Step 2.1] Victory-Point Accounting & Visible vs. Confirmed Hidden VP", () => {
    it("weights Colonist victoryPointsState categories accurately (0: Settlement=1, 1: City=2, 2: VP Dev=1 hidden, 3: Largest Army=2, 4: Longest Road=2)", () => {
      expect(VP_CATEGORY_WEIGHT).toEqual({
        "0": { weight: 1 },
        "1": { weight: 2 },
        "2": { weight: 1, hidden: true },
        "3": { weight: 2 },
        "4": { weight: 2 }
      });

      // edge9896 P1 (Naples7546, opponent): live {"0":4,"1":3,"3":1,"4":1} -> 4(1) + 3(2) + 1(2) + 1(2) = 14 visible, 0 hidden
      expect(breakdownVp({ "0": 4, "1": 3, "3": 1, "4": 1 })).toEqual({
        visibleVp: 14,
        hiddenVp: 0,
        totalVp: 14
      });
      // edge9896 P1 endGameState: {"0":4,"1":3,"2":1,"3":1,"4":1} -> 14 visible + 1 hidden = 15 total
      expect(breakdownVp({ "0": 4, "1": 3, "2": 1, "3": 1, "4": 1 })).toEqual({
        visibleVp: 14,
        hiddenVp: 1,
        totalVp: 15
      });

      // farm9373 P5 (Megalovania, self): {"0":1,"1":4,"2":1,"3":1} -> 1(1) + 4(2) + 1(2) = 11 visible, 1(1) = 1 hidden, 12 total
      expect(breakdownVp({ "0": 1, "1": 4, "2": 1, "3": 1 })).toEqual({
        visibleVp: 11,
        hiddenVp: 1,
        totalVp: 12
      });

      // deck7708 P5 (Megalovania, self): {"0":2,"1":4,"2":3,"3":1,"4":0} -> 2(1) + 4(2) + 1(2) = 12 visible, 3(1) = 3 hidden, 15 total
      expect(breakdownVp({ "0": 2, "1": 4, "2": 3, "3": 1, "4": 0 })).toEqual({
        visibleVp: 12,
        hiddenVp: 3,
        totalVp: 15
      });
    });

    it.skipIf(!recordingsAvailable)("reconciles live PlayerSnapshot visibleVp, hiddenVp, and vp across edge9896, farm9373, and deck7708 (recording fixture required)", () => {
      // 1. edge9896
      const edge = requireRecording(recordings, "edge9896");
      const edgeParsed = stateDiffAdapter.parse(decodeFrames(edge.frames).decoded);
      const edgeP1 = edgeParsed.snapshot!.players.find((p) => p.id === "c1")!;
      const edgeP5 = edgeParsed.snapshot!.players.find((p) => p.id === "c5")!;
      expect(edgeP1).toMatchObject({
        visibleVp: 14,
        hiddenVp: 0,
        vp: 14,
        devsInHand: 2,
        unknownDevsInHand: 2,
        hasLargestArmy: true,
        hasLongestRoad: true
      });
      expect(edgeP5).toMatchObject({
        visibleVp: 8,
        hiddenVp: 0,
        vp: 8,
        devsInHand: 2,
        unknownDevsInHand: 0,
        hasLargestArmy: false,
        hasLongestRoad: false
      });

      // 2. farm9373
      const farm = requireRecording(recordings, "farm9373");
      const farmParsed = stateDiffAdapter.parse(decodeFrames(farm.frames).decoded);
      const farmP1 = farmParsed.snapshot!.players.find((p) => p.id === "c1")!;
      const farmP5 = farmParsed.snapshot!.players.find((p) => p.id === "c5")!;
      expect(farmP1).toMatchObject({
        visibleVp: 14,
        hiddenVp: 0,
        vp: 14,
        devsInHand: 2,
        unknownDevsInHand: 2,
        hasLargestArmy: false,
        hasLongestRoad: true
      });
      expect(farmP5).toMatchObject({
        visibleVp: 11,
        hiddenVp: 1,
        vp: 12,
        devsInHand: 3,
        unknownDevsInHand: 0,
        hasLargestArmy: true,
        hasLongestRoad: false
      });

      // 3. deck7708
      const deck = requireRecording(recordings, "deck7708");
      const deckParsed = stateDiffAdapter.parse(decodeFrames(deck.frames).decoded);
      const deckP1 = deckParsed.snapshot!.players.find((p) => p.id === "c1")!;
      const deckP5 = deckParsed.snapshot!.players.find((p) => p.id === "c5")!;
      expect(deckP1).toMatchObject({
        visibleVp: 10,
        hiddenVp: 0,
        vp: 10,
        devsInHand: 1,
        unknownDevsInHand: 1,
        hasLargestArmy: false,
        hasLongestRoad: true
      });
      expect(deckP5).toMatchObject({
        visibleVp: 12,
        hiddenVp: 3,
        vp: 15,
        devsInHand: 3,
        unknownDevsInHand: 0,
        hasLargestArmy: true,
        hasLongestRoad: false
      });
    });

    it.skipIf(!recordingsAvailable)("emits weighted vp events during stateDiffAdapter.parse rather than raw unweighted counts (recording fixture required)", () => {
      const deck = requireRecording(recordings, "deck7708");
      const deckParsed = stateDiffAdapter.parse(decodeFrames(deck.frames).decoded);
      const p5VpEvents = deckParsed.events.filter((e) => e.type === "vp" && e.player === "c5");
      expect(p5VpEvents.at(-1)).toMatchObject({ type: "vp", player: "c5", vp: 15 });
    });
  });

  describe("2. [ACCEPTANCE — Step 2.1] Development Cards — Face-Down ID 10 vs. Identified Cards", () => {
    it("never treats face-down card ID 10 as a Victory Point card and accurately tracks unknownDevsInHand", () => {
      expect(FACE_DOWN_DEV_CARD_ID).toBe(10);
      expect(DEV_CARD[10]).toBeUndefined();
      expect(DEV_CARD[11]).toBe("knight");
      expect(DEV_CARD[12]).toBe("victoryPoint");
      expect(DEV_CARD[13]).toBe("monopoly");
      expect(DEV_CARD[14]).toBe("roadBuilding");
      expect(DEV_CARD[15]).toBe("yearOfPlenty");

      const snap = readSnapshot({
        playerStates: {
          "1": { color: 1, victoryPointsState: { "0": 2, "1": 1 } },
          "2": { color: 2, victoryPointsState: { "0": 2, "1": 1, "2": 1 } },
          "3": { color: 3, victoryPointsState: { "0": 2 } }
        },
        mechanicDevelopmentCardsState: {
          players: {
            // Opponent with 2 face-down cards (ID 10)
            "1": { developmentCards: { cards: [10, 10] }, developmentCardsUsed: [11] },
            // Self with 1 VP (12), 1 Knight (11), 1 Road Building (14)
            "2": { developmentCards: { cards: [12, 11, 14] }, developmentCardsUsed: [] },
            // Partially revealed hand: 1 identified VP (12) + 2 face-down (10)
            "3": { developmentCards: { cards: [12, 10, 10] }, developmentCardsUsed: [] }
          }
        }
      });

      const p1 = snap.players.find((p) => p.id === "c1")!;
      expect(p1.devsInHand).toBe(2);
      expect(p1.unknownDevsInHand).toBe(2);
      expect(p1.devCards).toBeUndefined();
      expect(p1.hiddenVp).toBe(0);
      expect(p1.visibleVp).toBe(4);
      expect(p1.vp).toBe(4);

      const p2 = snap.players.find((p) => p.id === "c2")!;
      expect(p2.devsInHand).toBe(3);
      expect(p2.unknownDevsInHand).toBe(0);
      expect(p2.devCards).toEqual(["victoryPoint", "knight", "roadBuilding"]);
      expect(p2.hiddenVp).toBe(1);
      expect(p2.visibleVp).toBe(4);
      expect(p2.vp).toBe(5);

      const p3 = snap.players.find((p) => p.id === "c3")!;
      expect(p3.devsInHand).toBe(3);
      expect(p3.unknownDevsInHand).toBe(2);
      expect(p3.devCards).toEqual(["victoryPoint"]);
      expect(p3.hiddenVp).toBe(1);
      expect(p3.visibleVp).toBe(2);
      expect(p3.vp).toBe(3);
    });
  });

  describe("3. [ACCEPTANCE — Step 2.1] Authoritative Game Settings & Unknown Preservation", () => {
    it.skipIf(!recordingsAvailable)("extracts authoritative gameSettings from initial state frames and preserves unknown settings as undefined (recording fixture required)", () => {
      const farm = requireRecording(recordings, "farm9373");
      const { decoded } = decodeFrames(farm.frames);
      const parsed = stateDiffAdapter.parse(decoded);

      expect(parsed.snapshot?.gameSettings).toEqual({
        id: "farm9373",
        gameType: 6,
        modeSetting: 0,
        extensionSetting: 0,
        scenarioSetting: 0,
        mapSetting: 0,
        diceSetting: 1,
        victoryPointsToWin: 15,
        cardDiscardLimit: 9,
        maxPlayers: 2,
        hideBankCards: true,
        friendlyRobber: true
      });
      for (const p of parsed.snapshot!.players) {
        expect(p.discardLimit).toBe(9);
      }

      // When gameSettings is absent altogether, snapshot.gameSettings and player discardLimit remain undefined
      const snapNoSettings = readSnapshot({
        playerStates: { "1": { color: 1, victoryPointsState: { "0": 2 } } }
      });
      expect(snapNoSettings.gameSettings).toBeUndefined();
      expect(snapNoSettings.players[0].discardLimit).toBeUndefined();

      // When gameSettings is only partially populated, unknown fields remain undefined
      const partial = readGameSettings({ victoryPointsToWin: 10 });
      expect(partial).toBeDefined();
      expect(partial?.victoryPointsToWin).toBe(10);
      expect(partial?.cardDiscardLimit).toBeUndefined();
      expect(partial?.friendlyRobber).toBeUndefined();
      expect(partial?.diceSetting).toBeUndefined();
    });
  });

  describe("4. [ACCEPTANCE — Step 2.1] Development-Card Turn Restrictions (Same-Turn Buy & One-Per-Turn)", () => {
    it("excludes dev cards bought on the current turn and blocks playing a second dev card when hasUsedDevThisTurn is true", () => {
      const snap = readSnapshot({
        playerStates: {
          "1": { color: 1, victoryPointsState: { "0": 2 } },
          "5": { color: 5, victoryPointsState: { "0": 2, "2": 1 } }
        },
        mechanicDevelopmentCardsState: {
          players: {
            // Player 5 holds [VP(12), Knight(11), Monopoly(13)], having just bought Monopoly(13) this turn
            "5": {
              developmentCards: { cards: [12, 11, 13] },
              developmentCardsBoughtThisTurn: [13],
              developmentCardsUsed: [14, 11]
            }
          }
        }
      });

      const p5 = snap.players.find((p) => p.id === "c5")!;
      expect(p5.devCards).toEqual(["victoryPoint", "knight", "monopoly"]);
      expect(p5.devsBoughtThisTurn).toEqual(["monopoly"]);
      expect(p5.playableDevCards).toEqual(["victoryPoint", "knight"]);
      expect(playableCardsOf(p5)).toEqual(["victoryPoint", "knight"]);

      // Once a dev card has been played this turn (hasUsedDevelopmentCardThisTurn = true), no action dev cards are playable
      const snapAfterPlay = readSnapshot({
        playerStates: { "5": { color: 5, victoryPointsState: { "0": 2, "2": 1 } } },
        mechanicDevelopmentCardsState: {
          players: {
            "5": {
              developmentCards: { cards: [12, 11] },
              hasUsedDevelopmentCardThisTurn: true,
              developmentCardsUsed: [14, 11, 13]
            }
          }
        }
      });
      const p5After = snapAfterPlay.players[0];
      expect(p5After.hasUsedDevThisTurn).toBe(true);
      expect(playableCardsOf(p5After)).toEqual(["victoryPoint"]);
    });

    it.skipIf(!recordingsAvailable)("prevents planTurn from recommending playing Road Building on the same turn it was bought (recording fixture required)", () => {
      const farm = requireRecording(recordings, "farm9373");
      // The final snapshot still has road pieces and a playable Road Building card,
      // but no settlement worth two roads. Frame 200 of the same game is a main-phase
      // prefix where the existing coach does recommend the card. Same-turn purchase
      // stays illegal on that prefix.
      const parsed = stateDiffAdapter.parse(decodeFrames(farm.frames.slice(0, 200)).decoded);
      const placements = placementsFrom(parsed.events);
      const me = parsed.selfId ?? parsed.players[0].id;
      const snap = parsed.snapshot!;

      // Case A: Road Building was bought THIS turn -> must NOT recommend playing Road Building
      const boughtThisTurnSnap = {
        ...snap,
        dice: { thrown: true, d1: 3, d2: 4 },
        players: snap.players.map((p) =>
          p.id === me
            ? {
                ...p,
                devsInHand: 1,
                unknownDevsInHand: 0,
                devCards: ["roadBuilding" as const],
                devsBoughtThisTurn: ["roadBuilding" as const],
                playableDevCards: undefined,
                hasUsedDevThisTurn: true
              }
            : p
        )
      };
      const adviceSameTurn = planTurn({
        board: parsed.board!,
        placements,
        me,
        hand: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
        snapshot: boughtThisTurnSnap,
        events: parsed.events
      });
      expect(adviceSameTurn.headline.toLowerCase()).not.toContain("road building");

      // Case B: Road Building was bought on a PRIOR turn -> playable now
      const priorTurnSnap = {
        ...snap,
        dice: { thrown: true, d1: 3, d2: 4 },
        players: snap.players.map((p) =>
          p.id === me
            ? {
                ...p,
                devsInHand: 1,
                unknownDevsInHand: 0,
                devCards: ["roadBuilding" as const],
                devsBoughtThisTurn: undefined,
                playableDevCards: ["roadBuilding" as const],
                hasUsedDevThisTurn: undefined
              }
            : p
        )
      };
      const adviceNextTurn = planTurn({
        board: parsed.board!,
        placements,
        me,
        hand: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
        snapshot: priorTurnSnap,
        events: parsed.events
      });
      expect(adviceNextTurn.headline.toLowerCase()).toContain("road building");
    });
  });

  describe("5. [ACCEPTANCE — Step 2.2] Longest Road — Disconnected Components, Cycles, and Opponent Splits", () => {
    it("computes longest edge-simple trail across disconnected components and cycles without merging disconnected networks", () => {
      // Component 1: 2-edge path (A - B - C)
      // Component 2: 5-edge cycle + 1 tail (D - E - F - G - H - D, plus D - I) -> longest edge-simple trail = 6
      const graph = new Map<string, Set<string>>([
        ["A", new Set(["B"])],
        ["B", new Set(["A", "C"])],
        ["C", new Set(["B"])],
        ["D", new Set(["E", "H", "I"])],
        ["E", new Set(["D", "F"])],
        ["F", new Set(["E", "G"])],
        ["G", new Set(["F", "H"])],
        ["H", new Set(["G", "D"])],
        ["I", new Set(["D"])]
      ]);

      const res = longestRoad(graph);
      expect(res.len).toBe(6);
      expect(new Set(res.ends)).toEqual(new Set(["I", "D"]));

      // Single component with 5-cycle + tail
      const singleComp = new Map<string, Set<string>>([
        ["I", new Set(["D"])],
        ["D", new Set(["E", "H", "I"])],
        ["E", new Set(["D", "F"])],
        ["F", new Set(["E", "G"])],
        ["G", new Set(["F", "H"])],
        ["H", new Set(["G", "D"])]
      ]);
      expect(longestRoad(singleComp).len).toBe(6);
    });

    it.skipIf(!recordingsAvailable)("splits a road trail when an opponent settlement occupies an intermediate corner and excludes blocked corners from extendable ends (recording fixture required)", () => {
      const graph = new Map<string, Set<string>>([
        ["c0", new Set(["c1"])],
        ["c1", new Set(["c0", "c2"])],
        ["c2", new Set(["c1", "c3"])],
        ["c3", new Set(["c2", "c4"])],
        ["c4", new Set(["c3"])]
      ]);

      // Unblocked: 4-road line from c0 to c4
      expect(longestRoad(graph)).toEqual({ len: 4, ends: ["c0", "c4"] });

      // Opponent settles on intermediate corner c2, splitting the 4-road line into two 2-road segments (c0-c1-c2 and c2-c3-c4)
      const splitRes = longestRoad(graph, new Set(["c2"]));
      expect(splitRes.len).toBe(2);
      expect(new Set(splitRes.ends)).toEqual(new Set(["c0", "c4"]));
      expect(splitRes.ends).not.toContain("c2");

      // On a real board, verify networkLength and longestExtensions respect opponent settlement road splits
      const farm = requireRecording(recordings, "farm9373");
      const parsed = stateDiffAdapter.parse(decodeFrames(farm.frames).decoded);
      const board = parsed.board!;
      const ctx = contextFor(board);

      // Build a 4-road simple path c0 - c1 - c2 - c3 - c4 on the board
      const c0 = ctx.corners[0].at;
      const c1 = ctx.nbrs.get(c0)![0];
      const c2 = ctx.nbrs.get(c1)!.find((x) => x !== c0)!;
      const c3 = ctx.nbrs.get(c2)!.find((x) => x !== c1 && x !== c0)!;
      const c4 = ctx.nbrs.get(c3)!.find((x) => x !== c2 && x !== c1 && x !== c0)!;
      const baseNet = buildNet(board, { settlements: new Map([[c0, "c1"]]), cities: new Map(), roads: new Map() }, "c1")!;
      const e01 = baseNet.adj.get(c0)!.find((x) => x.to === c1)!.edge;
      const e12 = baseNet.adj.get(c1)!.find((x) => x.to === c2)!.edge;
      const e23 = baseNet.adj.get(c2)!.find((x) => x.to === c3)!.edge;
      const e34 = baseNet.adj.get(c3)!.find((x) => x.to === c4)!.edge;

      const roads = new Map<string, string>([
        [e01, "c1"],
        [e12, "c1"],
        [e23, "c1"],
        [e34, "c1"]
      ]);
      const beforeSplit: Placements = {
        settlements: new Map([[c0, "c1"]]),
        cities: new Map(),
        roads
      };
      expect(networkLength(board, beforeSplit, "c1")).toBe(4);

      const afterSplit: Placements = {
        settlements: new Map([
          [c0, "c1"],
          [c2, "c5"]
        ]),
        cities: new Map(),
        roads
      };
      expect(networkLength(board, afterSplit, "c1")).toBe(2);
      const ext = longestExtensions(board, afterSplit, "c1");
      const c2Edges = new Set((baseNet.adj.get(c2) ?? []).map((x) => x.edge));
      for (const item of ext) {
        expect(c2Edges.has(item.edge)).toBe(false);
      }
    });

    it.skipIf(!recordingsAvailable)("matches Colonist authoritative mechanicLongestRoadState road lengths on captured recordings (edge9896, farm9373, deck7708) (recording fixture required)", () => {
      for (const [id, expected] of [
        ["edge9896", { c1: 10 }],
        ["farm9373", { c1: 13, c5: 4 }],
        ["deck7708", { c1: 8 }]
      ] as const) {
        const rec = requireRecording(recordings, id);
        const parsed = stateDiffAdapter.parse(decodeFrames(rec.frames).decoded);
        const placements = placementsFrom(parsed.events);
        for (const [pid, len] of Object.entries(expected)) {
          const snapPlayer = parsed.snapshot!.players.find((p) => p.id === pid)!;
          expect(snapPlayer.roadLength).toBe(len);
          expect(networkLength(parsed.board!, placements, pid)).toBe(len);
        }
      }
    });
  });

  describe.skipIf(!recordingsAvailable)("6. [ACCEPTANCE — Step 2.3] Settlement Distance & Legal Road Placement (recording fixture required)", () => {
    if (!recordingsAvailable) return;
    const farm = requireRecording(recordings, "farm9373");
    const parsed = stateDiffAdapter.parse(decodeFrames(farm.frames).decoded);
    const board: Board = parsed.board!;
    const ctx = contextFor(board);

    it("enforces the 2-edge settlement distance rule and never offers an already-occupied road edge", () => {
      const c0 = ctx.corners[0];
      const nbrs = ctx.nbrs.get(c0.at)!;
      const occupied = new Set<string>([c0.at]);
      expect(isLegal(ctx, c0.at, occupied)).toBe(false);
      for (const n of nbrs) {
        expect(isLegal(ctx, n, occupied)).toBe(false);
      }

      const net = buildNet(board, { settlements: new Map([[c0.at, "c1"]]), cities: new Map(), roads: new Map() }, "c1")!;
      const firstEdge = net.adj.get(c0.at)![0];
      const placementsWithRoad: Placements = {
        settlements: new Map([[c0.at, "c1"]]),
        cities: new Map(),
        roads: new Map([[firstEdge.edge, "c1"]])
      };
      const open = listOpenEdges(board, placementsWithRoad, "c1");
      expect(open.some((e) => e.edge === firstEdge.edge)).toBe(false);
    });

    it("allows building a road INTO an opponent-occupied corner, but prevents continuing THROUGH that corner", () => {
      const c0 = ctx.corners[0];
      const c1 = ctx.nbrs.get(c0.at)![0];
      const c2 = ctx.nbrs.get(c1)!.find((x) => x !== c0.at)!;

      // Case 1: c1 has a settlement at c0; opponent c2 has a settlement at adjacent corner c1.
      const placementsIn: Placements = {
        settlements: new Map([
          [c0.at, "c1"],
          [c1, "c2"]
        ]),
        cities: new Map(),
        roads: new Map()
      };
      // c1 CAN build the road e1 (c0 -> c1) terminating at opponent corner c1
      expect(listOpenEdges(board, placementsIn, "c1").some((e) => e.from === c0.at && e.to === c1)).toBe(true);

      // Case 2: c1 already owns road e1 (c0 -> c1) and opponent c2 settles at c1.
      const netInitial = buildNet(board, { settlements: new Map([[c0.at, "c1"]]), cities: new Map(), roads: new Map() }, "c1")!;
      const e1 = netInitial.adj.get(c0.at)!.find((x) => x.to === c1)!.edge;
      const placementsThrough: Placements = {
        settlements: new Map([
          [c0.at, "c1"],
          [c1, "c2"]
        ]),
        cities: new Map(),
        roads: new Map([[e1, "c1"]])
      };
      // c1 CANNOT branch out of opponent-occupied c1 to c2
      expect(listOpenEdges(board, placementsThrough, "c1").some((e) => e.from === c1)).toBe(false);
      expect(listOpenEdges(board, placementsThrough, "c1").some((e) => e.from === c1 && e.to === c2)).toBe(false);

      // If c0 has no other open edges (or when advising from c1), adviseRoad never recommends an edge starting only from blocked c1
      const adviceFromBlocked = adviseRoad(board, placementsThrough, "c1", { from: c1, onlyFrom: true });
      expect(adviceFromBlocked).toBeUndefined();
    });
  });

  describe("7. [ACCEPTANCE — Step 2.4] Dice Roll Extraction, Balanced Deck Cycle, and Game-Log Parser Corrections", () => {
    it.skipIf(!recordingsAvailable)("verifies 100% roll sequence agreement between WebSocket diceState and LogParser (75 rolls in farm9373) and 36-card Balanced Dice cycle (recording fixture required)", () => {
      const farm = requireRecording(recordings, "farm9373");
      const { decoded } = decodeFrames(farm.frames);
      const stateParsed = stateDiffAdapter.parse(decoded);
      const wsRolls = stateParsed.events.filter((e) => e.type === "roll");

      const logParser = new LogParser(farm.meta.me);
      for (const entry of farm.log) {
        if (entry.text) logParser.push(entry);
      }
      const logRolls = logParser.events.filter((e) => e.type === "roll");

      expect(stateParsed.snapshot?.completedTurns).toBe(78);
      expect(wsRolls.length).toBe(75);
      expect(logRolls.length).toBe(75);
      expect(logRolls.map((r) => (r.type === "roll" ? r.total : 0))).toEqual(
        wsRolls.map((r) => (r.type === "roll" ? r.total : 0))
      );

      // Published 36-card deck with 12-card reshuffle threshold (24 rolls/cycle) and 30% repeat damping
      const bag = bagState(
        [
          { total: 7, d1: 3, d2: 4 },
          { total: 6, d1: 2, d2: 4 },
          { total: 8, d1: 4, d2: 4 }
        ],
        true
      );
      expect(bag.bagLeft).toBe(33);
      expect(bag.sevensLeft).toBe(5);
      expect(bag.left[8]).toBe(4);
      expect(bag.weight[8]).toBeCloseTo(4 * 0.7, 5);

      const restarted = bagState(
        Array.from({ length: 24 }, () => ({ total: 7 })),
        true
      );
      expect(restarted.restarted).toBe(true);
      expect(restarted.bagLeft).toBe(36);
      expect(restarted.sevensLeft).toBe(6);
    });

    it.skipIf(!recordingsAvailable)("parses bot-prefixed action rows, trophy win rows, Longest Road / Largest Army transfers, and Rush-mode Dice rolls without creating phantom players (recording fixture required)", () => {
      // 1. bot <Player> ... action rows (representative real rows from play277, steal1277, road5055)
      expect(normalizeRow("bot PlayfulGrid5655 built a road")).toBe("PlayfulGrid5655 built a road");
      expect(parseRow("bot PlayfulGrid5655 built a road", 1, "Ashmaki")).toEqual({
        kind: "event",
        draft: { type: "build", player: "PlayfulGrid5655", piece: "road", setup: false },
        subject: "PlayfulGrid5655"
      });
      expect(parseRow("bot zoyazor rolled dice_2 dice_1", 1, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "roll", player: "zoyazor", d1: 2, d2: 1, total: 3 },
        subject: "zoyazor"
      });
      expect(parseRow("bot zoyazor got Wool", 1, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "gain", player: "zoyazor", cards: { wool: 1 }, source: "other" },
        subject: "zoyazor"
      });
      expect(parseRow("bot zoyazor gave bank Wool Wool Wool and took Grain", 1, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "bankTrade", player: "zoyazor", gave: { wool: 3 }, got: { grain: 1 } },
        subject: "zoyazor"
      });
      expect(parseRow("bot zoyazor built a City city ( +1 VP )", 1, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "build", player: "zoyazor", piece: "city", setup: false },
        subject: "zoyazor"
      });
      expect(parseRow("bot cecegran used Knight Knight", 1, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "devPlay", player: "cecegran", card: "knight" },
        subject: "cecegran"
      });
      expect(parseRow("bot cecegran moved Robber robber to prob_6 grain tile", 1, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "robberMove", player: "cecegran" },
        subject: "cecegran"
      });
      expect(parseRow("bot cecegran stole Lumber from you", 1, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "steal", player: "cecegran", victim: "Megalovania", card: "lumber" },
        subject: "cecegran"
      });
      expect(parseRow("bot BiBou8 bought Development Card", 1, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "devBuy", player: "BiBou8" },
        subject: "BiBou8"
      });

      // 2. trophy <Player> won the game! trophy
      expect(normalizeRow("Player avatar trophy Megalovania won the game! trophy")).toBe("Megalovania won the game!");
      expect(parseRow("Player avatar trophy Megalovania won the game! trophy", 20, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "gameEnd", winner: "Megalovania" },
        subject: "Megalovania"
      });
      expect(parseRow("trophy AHeck won the game! trophy", 20, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "gameEnd", winner: "AHeck" },
        subject: "AHeck"
      });

      // 3. Longest Road and Largest Army transfer messages
      expect(
        parseRow("Player avatar Longest Road longest road passed from Megalovania to Meyer1234 ( +2 VPs )", 15, "Megalovania")
      ).toEqual({
        kind: "event",
        draft: { type: "longestRoad", player: "Meyer1234" },
        subject: "Meyer1234"
      });
      expect(
        parseRow("Player avatar Longest Road longest road passed from BiBou8 to you ( +2 VPs )", 15, "Megalovania")
      ).toEqual({
        kind: "event",
        draft: { type: "longestRoad", player: "Megalovania" },
        subject: "Megalovania"
      });
      expect(
        parseRow("Player avatar Largest Army largest army passed from Megalovania to DaSheep420 ( +2 VPs )", 15, "Megalovania")
      ).toEqual({
        kind: "event",
        draft: { type: "largestArmy", player: "DaSheep420" },
        subject: "DaSheep420"
      });

      // 4. Rush-mode Dice rolled messages & Bot-thinking notices must not create phantom players
      expect(parseRow("Player avatar Dice rolled dice_2 dice_3", 1, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "roll", d1: 2, d2: 3, total: 5 },
        subject: undefined
      });
      expect(parseRow("Dice rolled 7", 1, "Megalovania")).toEqual({
        kind: "event",
        draft: { type: "roll", total: 7 },
        subject: undefined
      });
      expect(parseRow("Player avatar Bot is placing a road for Bailar9797", 0, "Megalovania")).toEqual({
        kind: "ignored"
      });
      expect(parseRow("Player avatar Bot is selecting where to place Robber robber for Bailar9797", 5, "Megalovania")).toEqual({
        kind: "ignored"
      });

      // Verify full Rush-mode recordings (path4053, hand179) and bot-takeover recordings (play277, steal1277, road5055)
      for (const id of ["path4053", "hand179", "play277", "steal1277", "road5055"]) {
        const rec = requireRecording(recordings, id);
        const parser = new LogParser(rec.meta.me);
        for (const entry of rec.log) {
          if (entry.text) parser.push(entry);
        }
        expect(parser.players.has("Dice")).toBe(false);
        expect(parser.players.has("Bot")).toBe(false);
        expect(parser.players.has("bot")).toBe(false);
        expect(parser.players.has("trophy")).toBe(false);
        expect(parser.players.has("Longest")).toBe(false);
        expect(parser.players.has("Largest")).toBe(false);
      }

      // Specifically check road5055 and deck7708 end-to-end log parsing for bot actions, road transfer, and gameEnd
      const deck = requireRecording(recordings, "deck7708");
      const deckParser = new LogParser(deck.meta.me);
      for (const entry of deck.log) {
        if (entry.text) deckParser.push(entry);
      }
      expect(deckParser.events.filter((e) => e.type === "longestRoad")).toEqual([
        expect.objectContaining({ type: "longestRoad", player: "Megalovania" }),
        expect.objectContaining({ type: "longestRoad", player: "Meyer1234" })
      ]);
      expect(deckParser.events.at(-1)).toMatchObject({ type: "gameEnd", winner: "Megalovania" });
    });

    it("[REGRESSION — Step 2.4] preserves existing log-row parsing semantics across standard human actions, chat, and noise rows", () => {
      const parser = new LogParser("Megalovania");

      // Setup builds (rolls === 0 -> setup: true)
      expect(parser.push({ t: 1, text: "Player avatar You placed a Settlement settlement" })).toEqual({
        kind: "event",
        event: { type: "build", player: "Megalovania", piece: "settlement", setup: true, t: 1, turn: 0 }
      });
      expect(parser.push({ t: 2, text: "Player avatar You placed a Road road" })).toEqual({
        kind: "event",
        event: { type: "build", player: "Megalovania", piece: "road", setup: true, t: 2, turn: 0 }
      });

      // Roll + roll-attributed resource gain
      expect(parser.push({ t: 3, text: "Player avatar AHeck rolled dice_3 dice_5" })).toEqual({
        kind: "event",
        event: { type: "roll", player: "AHeck", d1: 3, d2: 5, total: 8, t: 3, turn: 1 }
      });
      expect(parser.push({ t: 4, text: "Player avatar You got Ore Grain" })).toEqual({
        kind: "event",
        event: { type: "gain", player: "Megalovania", cards: { ore: 1, grain: 1 }, source: "roll", t: 4, turn: 1 }
      });

      // Road Building + 2 free roads
      expect(parser.push({ t: 5, text: "Player avatar AHeck used Road Building" })).toEqual({
        kind: "event",
        event: { type: "devPlay", player: "AHeck", card: "roadBuilding", t: 5, turn: 1 }
      });
      expect(parser.push({ t: 6, text: "Player avatar AHeck built a Road road" })).toEqual({
        kind: "event",
        event: { type: "build", player: "AHeck", piece: "road", setup: false, free: true, t: 6, turn: 1 }
      });
      expect(parser.push({ t: 7, text: "Player avatar AHeck built a Road road" })).toEqual({
        kind: "event",
        event: { type: "build", player: "AHeck", piece: "road", setup: false, free: true, t: 7, turn: 1 }
      });
      expect(parser.push({ t: 8, text: "Player avatar AHeck built a Road road" })).toEqual({
        kind: "event",
        event: { type: "build", player: "AHeck", piece: "road", setup: false, t: 8, turn: 1 }
      });

      // Monopoly, Year of Plenty (non-roll gain), player trade, discard, initial award claims
      expect(parser.push({ t: 9, text: "Player avatar You used Monopoly and stole 3 Ore" })).toEqual({
        kind: "event",
        event: { type: "devPlay", player: "Megalovania", card: "monopoly", t: 9, turn: 1 }
      });
      expect(parser.push({ t: 10, text: "Player avatar You stole 3 Ore" })).toEqual({
        kind: "event",
        event: { type: "monopoly", player: "Megalovania", cards: { ore: 3 }, t: 10, turn: 1 }
      });
      expect(parser.push({ t: 11, text: "Player avatar You took from bank Lumber Brick" })).toEqual({
        kind: "event",
        event: { type: "gain", player: "Megalovania", cards: { lumber: 1, brick: 1 }, source: "other", t: 11, turn: 1 }
      });
      expect(parser.push({ t: 12, text: "Player avatar You traded Wool for Grain with AHeck" })).toEqual({
        kind: "event",
        event: { type: "trade", player: "Megalovania", partner: "AHeck", gave: { wool: 1 }, got: { grain: 1 }, t: 12, turn: 1 }
      });
      expect(parser.push({ t: 13, text: "Player avatar AHeck discarded Wool Wool Lumber" })).toEqual({
        kind: "event",
        event: { type: "discard", player: "AHeck", cards: { wool: 2, lumber: 1 }, t: 13, turn: 1 }
      });
      expect(parser.push({ t: 14, text: "Player avatar AHeck received Longest Road longest road ( +2 VPs )" })).toEqual({
        kind: "event",
        event: { type: "longestRoad", player: "AHeck", t: 14, turn: 1 }
      });
      expect(parser.push({ t: 15, text: "Player avatar You received Largest Army largest army ( +2 VPs )" })).toEqual({
        kind: "event",
        event: { type: "largestArmy", player: "Megalovania", t: 15, turn: 1 }
      });

      // Chat and noise rows remain ignored
      expect(parser.push({ t: 16, text: "AHeck: gg wp" })).toEqual({ kind: "ignored" });
      expect(parser.push({ t: 17, text: "bot AHeck has left the game" })).toEqual({ kind: "ignored" });
      expect([...parser.players.keys()]).toEqual(["Megalovania", "AHeck"]);
    });
  });
  describe.skipIf(!recordingsAvailable)("8. [ACCEPTANCE — Step 2.5] Robber Rules, Simulator Largest Army Transfers & Dev-Card Timing (recording fixture required)", () => {
    if (!recordingsAvailable) return;
    const farm = requireRecording(recordings, "farm9373");
    const parsed = stateDiffAdapter.parse(decodeFrames(farm.frames).decoded);
    const board: Board = parsed.board!;
    const ctx = contextFor(board);

    it.skipIf(!recordingsAvailable)("enforces Friendly Robber against opponents below 3 visible VP and never targets the current robber hex (recording fixture required)", () => {
      const hexesWithNum = board.hexes.filter((h) => h.number !== null);
      const currentRobber = hexesWithNum[0].id;
      const targetHex = hexesWithNum[1];
      const cornerOnTarget = ctx.corners.find((c) => c.hexIds.includes(targetHex.id))!;

      const placementsProtected: Placements = {
        settlements: new Map([[cornerOnTarget.at, "c2"]]),
        cities: new Map(),
        roads: new Map()
      };
      expect(publicVp(placementsProtected, "c2")).toBe(1);
      expect(robberTargets(board, placementsProtected, "c1", currentRobber, 3)).toEqual([]);

      const otherCorner = ctx.corners.find((c) => !c.hexIds.includes(targetHex.id) && !ctx.nbrs.get(cornerOnTarget.at)?.includes(c.at))!;
      const placementsLegal: Placements = {
        settlements: new Map([[otherCorner.at, "c2"]]),
        cities: new Map([[cornerOnTarget.at, "c2"]]),
        roads: new Map()
      };
      expect(publicVp(placementsLegal, "c2")).toBe(3);
      const targets = robberTargets(board, placementsLegal, "c1", currentRobber, 3, 10);
      expect(targets.some((t) => t.hexId === targetHex.id)).toBe(true);
      expect(targets.some((t) => t.hexId === currentRobber)).toBe(false);
    });

    it("enforces strict > overtake threshold for Longest Road (>= 5) in live roadBattle", () => {
      const claim4 = roadBattle(4, 3, false, false);
      expect(claim4.worth).toBe(true);
      expect(claim4.roadsNeeded).toBe(1);

      const overtake5 = roadBattle(4, 5, false, true);
      expect(overtake5.roadsNeeded).toBe(2);
    });

    it("[ACCEPTANCE — Step 2.5] enforces Largest Army first claim at 3 Knights, preserves incumbent on ties, transfers +-2 VP on strict overtake, and prevents simultaneous holders in sim.ts", () => {
      const a = newPlayer({ vp: 2, readyDevs: ["knight", "knight", "knight", "knight"] });
      const b = newPlayer({ vp: 2, readyDevs: ["knight", "knight", "knight", "knight", "knight"] });
      const rng = () => 0.1;

      // Turn 1-2 for A: 1st and 2nd played Knights do not claim Largest Army
      expect(playDev(a, b, rng)).toBe(true);
      endTurn(a);
      expect(a.knights).toBe(1);
      expect(a.hasArmy).toBe(false);
      expect(a.vp).toBe(2);

      expect(playDev(a, b, rng)).toBe(true);
      endTurn(a);
      expect(a.knights).toBe(2);
      expect(a.hasArmy).toBe(false);
      expect(a.vp).toBe(2);

      // Turn 3 for A: 3rd Knight claims unclaimed Largest Army (+2 VP)
      expect(playDev(a, b, rng)).toBe(true);
      endTurn(a);
      expect(a.knights).toBe(3);
      expect(a.hasArmy).toBe(true);
      expect(a.vp).toBe(4);
      expect(b.hasArmy).toBe(false);
      expect(b.vp).toBe(2);

      // B plays 3 Knights across 3 turns (reaches tie 3 vs 3): incumbent A is preserved, B does not get Largest Army
      for (let i = 1; i <= 3; i++) {
        act(b, a, rng);
        endTurn(b);
        expect(b.knights).toBe(i);
        expect(a.hasArmy && b.hasArmy).toBe(false);
      }
      expect(b.knights).toBe(3);
      expect(a.hasArmy).toBe(true);
      expect(a.vp).toBe(4);
      expect(b.hasArmy).toBe(false);
      expect(b.vp).toBe(2);

      // B plays 4th Knight via act(): strictly exceeds incumbent A (4 > 3) -> removes 2 VP from A, awards 2 VP to B
      act(b, a, rng);
      endTurn(b);
      expect(b.knights).toBe(4);
      expect(a.hasArmy).toBe(false);
      expect(a.vp).toBe(2);
      expect(b.hasArmy).toBe(true);
      expect(b.vp).toBe(4);
      expect(a.hasArmy && b.hasArmy).toBe(false);

      // A plays 4th Knight (tie 4 vs 4): incumbent B is preserved
      act(a, b, rng);
      endTurn(a);
      expect(a.knights).toBe(4);
      expect(b.hasArmy).toBe(true);
      expect(b.vp).toBe(4);
      expect(a.hasArmy).toBe(false);
      expect(a.vp).toBe(2);
    });

    it("[ACCEPTANCE — Step 2.5] separates dev-card purchase from play, enforces 1 action dev card per turn, allows playing an older card when buying a new one, and promotes bought cards on endTurn", () => {
      // 1. Buying an action dev card during act() never plays it on the same turn, even with enough resources to buy multiple cards
      const buyer = newPlayer({
        vp: 2,
        hand: { lumber: 0, brick: 0, wool: 3, grain: 3, ore: 3 },
        expansions: [{ prods: [], pip: 8, roads: 2 }]
      });
      const opp = newPlayer({ vp: 2 });
      // rng returning 0.1 draws Knights (< 14/25)
      act(buyer, opp, () => 0.1);
      expect(buyer.devs).toBeGreaterThanOrEqual(1);
      expect(buyer.boughtDevs.length).toBe(buyer.devs);
      expect(buyer.readyDevs).toEqual([]);
      expect(buyer.knights).toBe(0);
      expect(buyer.playedDevThisTurn).toBe(false);
      // Attempting playDev before endTurn fails because newly bought cards are not in readyDevs
      expect(playDev(buyer, opp, () => 0.1)).toBe(false);

      // After endTurn, boughtDevs move into readyDevs
      endTurn(buyer);
      expect(buyer.boughtDevs).toEqual([]);
      expect(buyer.readyDevs.length).toBe(buyer.devs);

      // 2. Multiple ready action cards: at most 1 non-VP dev card can be played in a single turn, even across recursive act() calls
      const multi = newPlayer({
        vp: 2,
        readyDevs: ["knight", "roadBuilding", "yearOfPlenty"],
        hand: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 }
      });
      act(multi, opp, () => 0.1);
      expect(multi.playedDevThisTurn).toBe(true);
      expect(multi.knights).toBe(1);
      expect(multi.progress).toBe(0); // roadBuilding was NOT played on the same turn
      expect(multi.readyDevs).toEqual(["roadBuilding", "yearOfPlenty"]);
      expect(multi.boughtDevs).toEqual(["knight"]); // also bought a new knight on the same turn!
      expect(playDev(multi, opp, () => 0.1)).toBe(false);

      // Next turn after endTurn: roadBuilding is played (1 per turn), newly bought knight is now in readyDevs
      endTurn(multi);
      expect(multi.playedDevThisTurn).toBe(false);
      expect(multi.readyDevs).toEqual(["roadBuilding", "yearOfPlenty", "knight"]);
      act(multi, opp, () => 0.1);
      expect(multi.playedDevThisTurn).toBe(true);
      expect(multi.progress).toBe(2);
      expect(multi.readyDevs).toEqual(["yearOfPlenty", "knight"]);

      // 3. Buying a new card first on a turn still allows playing a card already held from a previous turn
      const buyThenPlay = newPlayer({
        vp: 2,
        readyDevs: ["knight"]
      });
      expect(buyDev(buyThenPlay, () => 20 / 25)).toBe("roadBuilding");
      expect(buyThenPlay.boughtDevs).toEqual(["roadBuilding"]);
      expect(buyThenPlay.readyDevs).toEqual(["knight"]);
      expect(playDev(buyThenPlay, opp, () => 0.1)).toBe(true);
      expect(buyThenPlay.knights).toBe(1);
      expect(buyThenPlay.readyDevs).toEqual([]);
      expect(buyThenPlay.boughtDevs).toEqual(["roadBuilding"]);
      // Cannot play the newly bought roadBuilding on the same turn even if playedDevThisTurn were false
      expect(playDev(buyThenPlay, opp, () => 0.1)).toBe(false);

      // 4. Purchased Victory Point card adds +1 VP immediately
      const vpBuyer = newPlayer({ vp: 2 });
      expect(buyDev(vpBuyer, () => 15 / 25)).toBe("victoryPoint");
      expect(vpBuyer.vp).toBe(3);
      expect(vpBuyer.boughtDevs).toEqual([]);
      expect(vpBuyer.readyDevs).toEqual([]);
    });

    it("[ACCEPTANCE — Step 2.5] classifies standard 25-card deck categories accurately and preserves Monopoly without resolving it as Year of Plenty", () => {
      const p = newPlayer({ vp: 2 });
      const opp = newPlayer({ vp: 2 });

      // 0..13/25 -> Knight (14 cards)
      expect(buyDev(p, () => 0 / 25)).toBe("knight");
      expect(buyDev(p, () => 13.9 / 25)).toBe("knight");
      // 14..18/25 -> Victory Point (5 cards)
      expect(buyDev(p, () => 14 / 25)).toBe("victoryPoint");
      expect(buyDev(p, () => 18.9 / 25)).toBe("victoryPoint");
      // 19..20/25 -> Road Building (2 cards)
      expect(buyDev(p, () => 19 / 25)).toBe("roadBuilding");
      expect(buyDev(p, () => 20.9 / 25)).toBe("roadBuilding");
      // 21..22/25 -> Year of Plenty (2 cards)
      expect(buyDev(p, () => 21 / 25)).toBe("yearOfPlenty");
      expect(buyDev(p, () => 22.9 / 25)).toBe("yearOfPlenty");
      // 23..24/25 -> Monopoly (2 cards)
      expect(buyDev(p, () => 23 / 25)).toBe("monopoly");
      expect(buyDev(p, () => 24.9 / 25)).toBe("monopoly");

      // 1. Purchased Monopoly via act() remains in boughtDevs (unavailable in readyDevs) until endTurn
      const monoBuyer = newPlayer({
        vp: 2,
        hand: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 }
      });
      // rng = 24/25 draws Monopoly (>= 23/25)
      act(monoBuyer, opp, () => 24 / 25);
      expect(monoBuyer.devs).toBe(1);
      expect(monoBuyer.boughtDevs).toEqual(["monopoly"]);
      expect(monoBuyer.readyDevs).toEqual([]);
      expect(monoBuyer.playedDevThisTurn).toBe(false);
      expect(Object.values(monoBuyer.hand).reduce((a, b) => a + b, 0)).toBe(0);

      // 2 & 3 & 4. On the next turn after endTurn, Monopoly moves to readyDevs, is NOT silently removed or marked as played by playDev() or recursive act(), and never fabricates 2 resources as Year of Plenty
      endTurn(monoBuyer);
      expect(monoBuyer.boughtDevs).toEqual([]);
      expect(monoBuyer.readyDevs).toEqual(["monopoly"]);
      expect(playDev(monoBuyer, opp, () => 0)).toBe(false);
      expect(monoBuyer.playedDevThisTurn).toBe(false);
      expect(monoBuyer.readyDevs).toEqual(["monopoly"]);
      expect(Object.values(monoBuyer.hand).reduce((a, b) => a + b, 0)).toBe(0);

      // Even when monoBuyer builds a road during act() on Turn 2 (triggering recursive act()), Monopoly stays untouched in readyDevs and playedDevThisTurn stays false
      monoBuyer.hand = { lumber: 1, brick: 1, wool: 0, grain: 0, ore: 0 };
      monoBuyer.expansions = [{ prods: [], pip: 8, roads: 2 }];
      act(monoBuyer, opp, () => 0);
      expect(monoBuyer.progress).toBe(1);
      expect(monoBuyer.playedDevThisTurn).toBe(false);
      expect(monoBuyer.readyDevs).toEqual(["monopoly"]);
      expect(Object.values(monoBuyer.hand).reduce((a, b) => a + b, 0)).toBe(0);

      // 5. Supported action cards (Knight, Road Building, Year of Plenty) retain same-turn purchase lock and 1-card-per-turn play limit alongside preserved Monopoly
      const allCards = newPlayer({
        vp: 2,
        readyDevs: ["monopoly"]
      });
      // Buy Knight, Road Building, and Year of Plenty on the same turn -> all 3 sit in boughtDevs and cannot be played this turn
      expect(buyDev(allCards, () => 0 / 25)).toBe("knight");
      expect(buyDev(allCards, () => 20 / 25)).toBe("roadBuilding");
      expect(buyDev(allCards, () => 22 / 25)).toBe("yearOfPlenty");
      expect(allCards.boughtDevs).toEqual(["knight", "roadBuilding", "yearOfPlenty"]);
      expect(allCards.readyDevs).toEqual(["monopoly"]);
      expect(playDev(allCards, opp, () => 0)).toBe(false);
      expect(allCards.playedDevThisTurn).toBe(false);

      // End turn -> all 3 supported cards join readyDevs behind Monopoly
      endTurn(allCards);
      expect(allCards.readyDevs).toEqual(["monopoly", "knight", "roadBuilding", "yearOfPlenty"]);

      // Turn A: skips Monopoly (preserving it), plays Knight (1 per turn), blocks Road Building & Year of Plenty this turn
      act(allCards, opp, () => 0);
      expect(allCards.playedDevThisTurn).toBe(true);
      expect(allCards.knights).toBe(1);
      expect(allCards.progress).toBe(0);
      expect(Object.values(allCards.hand).reduce((a, b) => a + b, 0)).toBe(0);
      expect(allCards.readyDevs).toEqual(["monopoly", "roadBuilding", "yearOfPlenty"]);
      endTurn(allCards);

      // Turn B: skips Monopoly (preserving it), plays Road Building (1 per turn), blocks Year of Plenty this turn
      act(allCards, opp, () => 0);
      expect(allCards.playedDevThisTurn).toBe(true);
      expect(allCards.progress).toBe(2);
      expect(Object.values(allCards.hand).reduce((a, b) => a + b, 0)).toBe(0);
      expect(allCards.readyDevs).toEqual(["monopoly", "yearOfPlenty"]);
      endTurn(allCards);

      // Turn C: skips Monopoly (preserving it), plays Year of Plenty (+2 resources), leaves Monopoly intact
      act(allCards, opp, () => 0);
      expect(allCards.playedDevThisTurn).toBe(true);
      expect(Object.values(allCards.hand).reduce((a, b) => a + b, 0)).toBe(2);
      expect(allCards.readyDevs).toEqual(["monopoly"]);
    });
  });
});
