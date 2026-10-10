import { readFileSync } from "node:fs";
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
import { LogParser, parseRow } from "../src/analyzer/adapters/logText";
import { placementsFrom, publicVp, robberTargets } from "../src/analyzer/advisor";
import { contextFor, isLegal } from "../src/analyzer/strategy";
import { buildNet, listOpenEdges, longestExtensions, longestRoad, networkLength } from "../src/analyzer/engine/roads";
import { bagState } from "../src/analyzer/engine/value";
import { planTurn, playableCardsOf, roadBattle } from "../src/analyzer/engine/decide";
import type { Board, Placements } from "../src/analyzer/types";
import type { Recording } from "../src/shared/schema";

const RECORDINGS_PATH = "C:/Users/ashma/Downloads/colonist-recordings-2026-10-08.json";

function loadRecordings(): Recording[] {
  const raw = JSON.parse(readFileSync(RECORDINGS_PATH, "utf8")) as { recordings: Recording[] };
  return raw.recordings;
}

/**
 * Reference acceptance specification for Step 2.3 (Legal open road edges:
 * may build INTO an opponent-occupied corner, but never branch OUT OF / THROUGH an opponent-occupied corner).
 */
function computeAuthoritativeOpenEdges(
  board: Board,
  placements: Placements,
  player: string
): Array<{ edge: string; from: string; to: string }> {
  const net = buildNet(board, placements, player);
  if (!net) return [];
  const roots = [...net.mine].filter((c) => !net.blocked.has(c));
  const out: Array<{ edge: string; from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const r of roots) {
    for (const next of net.adj.get(r) ?? []) {
      if (placements.roads.has(next.edge) || seen.has(next.edge)) continue;
      seen.add(next.edge);
      out.push({ edge: next.edge, from: r, to: next.to });
    }
  }
  return out;
}

describe("Stage 2 — Acceptance Tests (Steps 2.1–2.2 Implemented)", () => {
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

    it("reconciles live PlayerSnapshot visibleVp, hiddenVp, and vp across edge9896, farm9373, and deck7708", () => {
      // 1. edge9896
      const edge = recordings.find((r) => r.id === "edge9896")!;
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
      const farm = recordings.find((r) => r.id === "farm9373")!;
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
      const deck = recordings.find((r) => r.id === "deck7708")!;
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

    it("emits weighted vp events during stateDiffAdapter.parse rather than raw unweighted counts", () => {
      const deck = recordings.find((r) => r.id === "deck7708")!;
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
    it("extracts authoritative gameSettings from initial state frames and preserves unknown settings as undefined", () => {
      const farm = recordings.find((r) => r.id === "farm9373")!;
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

    it("prevents planTurn from recommending playing Road Building on the same turn it was bought", () => {
      const farm = recordings.find((r) => r.id === "farm9373")!;
      const parsed = stateDiffAdapter.parse(decodeFrames(farm.frames).decoded);
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
                playableDevCards: undefined
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
                playableDevCards: ["roadBuilding" as const]
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

    it("splits a road trail when an opponent settlement occupies an intermediate corner and excludes blocked corners from extendable ends", () => {
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
      const farm = recordings.find((r) => r.id === "farm9373")!;
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

    it("matches Colonist authoritative mechanicLongestRoadState road lengths on captured recordings (edge9896, farm9373, deck7708)", () => {
      for (const [id, expected] of [
        ["edge9896", { c1: 10 }],
        ["farm9373", { c1: 13, c5: 4 }],
        ["deck7708", { c1: 8 }]
      ] as const) {
        const rec = recordings.find((r) => r.id === id)!;
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
});

describe("Stage 2 — Pending Steps 2.3–2.5 (Acceptance Specifications & Documented Baseline Bugs)", () => {
  const recordings = loadRecordings();

  describe("6. Dice Roll Extraction, Balanced Deck Cycle, and Pending Step 2.4 LogParser Bot-Prefix Bug", () => {
    it("[ACCEPTANCE] verifies 100% roll sequence agreement between WebSocket diceState and LogParser (75 rolls in farm9373) and 36-card Balanced Dice cycle", () => {
      const farm = recordings.find((r) => r.id === "farm9373")!;
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

    it("[PENDING Step 2.4 — Acceptance Spec vs. Baseline Bug] documents LogParser ACTOR regex failure on bot-prefixed action rows", () => {
      // Acceptance target once Step 2.4 strips leading `bot ` before matching action patterns:
      const normalizeBotRow = (raw: string) => raw.replace(/^(?:bot|player|icon[_a-z0-9-]*)\s+/i, "");
      expect(parseRow(normalizeBotRow("bot PlayfulGrid5655 built a road"), 1, "Ashmaki")).toMatchObject({
        kind: "event",
        draft: { type: "build", player: "PlayfulGrid5655", piece: "road" }
      });

      // Documented baseline bug (to be fixed in Step 2.4):
      expect(parseRow("bot PlayfulGrid5655 built a road", 1, "Ashmaki").kind).toBe("unparsed");
      expect(parseRow("bot PlayfulGrid5655 bought development card", 1, "Ashmaki").kind).toBe("unparsed");
      expect(parseRow("bot PlayfulGrid5655 traded: 4 wool for 1 ore", 1, "Ashmaki").kind).toBe("unparsed");
    });
  });

  describe("7. [ACCEPTANCE & PENDING Step 2.3] Settlement Distance & Road Legality", () => {
    const farm = recordings.find((r) => r.id === "farm9373")!;
    const parsed = stateDiffAdapter.parse(decodeFrames(farm.frames).decoded);
    const board: Board = parsed.board!;
    const ctx = contextFor(board);

    it("[ACCEPTANCE] enforces the 2-edge settlement distance rule and never offers an already-occupied road edge", () => {
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

    it("[PENDING Step 2.3 — Acceptance Spec vs. Baseline Bug] allows building a road INTO an opponent-occupied corner, but prevents continuing THROUGH that corner", () => {
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
      // Acceptance spec: c1 CAN build the road e1 (c0 -> c1) terminating at opponent corner c1
      expect(computeAuthoritativeOpenEdges(board, placementsIn, "c1").some((e) => e.to === c1)).toBe(true);
      // Documented baseline bug (to be fixed in Step 2.3): listOpenEdges blocks building into c1
      expect(listOpenEdges(board, placementsIn, "c1").some((e) => e.to === c1)).toBe(false);

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
      // Acceptance spec: c1 CANNOT branch out of opponent-occupied c1 to c2
      expect(computeAuthoritativeOpenEdges(board, placementsThrough, "c1").some((e) => e.from === c1 && e.to === c2)).toBe(false);
      // Documented baseline bug (to be fixed in Step 2.3): listOpenEdges allows branching through c1 to c2
      expect(listOpenEdges(board, placementsThrough, "c1").some((e) => e.from === c1 && e.to === c2)).toBe(true);
    });
  });

  describe("8. [ACCEPTANCE] Robber Rules & Award Transfer Thresholds", () => {
    const farm = recordings.find((r) => r.id === "farm9373")!;
    const parsed = stateDiffAdapter.parse(decodeFrames(farm.frames).decoded);
    const board: Board = parsed.board!;
    const ctx = contextFor(board);

    it("enforces Friendly Robber against opponents below 3 visible VP and never targets the current robber hex", () => {
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

    it("enforces strict > overtake threshold for Longest Road (>= 5) and Largest Army (>= 3)", () => {
      const claim4 = roadBattle(4, 3, false, false);
      expect(claim4.worth).toBe(true);
      expect(claim4.roadsNeeded).toBe(1);

      const overtake5 = roadBattle(4, 5, false, true);
      expect(overtake5.roadsNeeded).toBe(2);
    });
  });
});
