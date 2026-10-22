import { describe, expect, it } from "vitest";
import type { Board, Placements, ResourceHand } from "../src/analyzer/types";
import type { GameSnapshot, PlayerSnapshot } from "../src/analyzer/snapshot";
import { contextFor, planMidgame, portReportFor, profileOf, scoreSpot } from "../src/analyzer/strategy";
import { portWorth } from "../src/analyzer/engine/ports";
import { assessSettlementRace, finishTurns, RACE_EVALUATOR_ID, routeIsDeadEnd } from "../src/analyzer/engine/race";
import { rankLiveSpots } from "../src/analyzer/engine/read";
import { bestEdge, rankEdges } from "../src/analyzer/engine/value";
import { planTurn } from "../src/analyzer/engine/decide";
import { buildBoardTopology, type BoardTopology, type TopologyCorner, type TopologyEdge } from "../src/analyzer/engine/topology";
import { baselineRolloutPolicy } from "../src/analyzer/engine/rollout";
import { createSeededRng } from "../src/analyzer/engine/rng";
import { applyAction, createInitialConcreteState, getLegalActions } from "../src/analyzer/engine/transition";
import type { ConcreteSimulatedGameState } from "../src/analyzer/engine/state";

const ME = "me";
const OPP = "opp";
const empty = (): ResourceHand => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
const hand = (partial: Partial<ResourceHand>): ResourceHand => ({ ...empty(), ...partial });

describe("Settlement race", () => {
  it("rejects a road when the opponent can pay and arrive first", () => {
    const lost = assessSettlementRace({
      myRoads: 2,
      opponentRoads: 1,
      myProduction: empty(),
      opponentProduction: empty(),
      myHand: empty(),
      opponentKnown: hand({ lumber: 2, brick: 2, wool: 1, grain: 1 }),
      opponentUnknown: 0
    });
    const safe = assessSettlementRace({
      myRoads: 1,
      opponentRoads: 4,
      myProduction: empty(),
      opponentProduction: empty(),
      myHand: hand({ lumber: 2, brick: 2, wool: 1, grain: 1 }),
      opponentKnown: empty(),
      opponentUnknown: 0
    });

    expect(lost.evaluatorId).toBe(RACE_EVALUATOR_ID);
    expect(lost.lost).toBe(true);
    expect(lost.certainty).toBe("known");
    expect(lost.adjustment).toBeLessThan(safe.adjustment);
    expect(safe.lost).toBe(false);
    expect(routeIsDeadEnd([lost])).toBe(true);
    expect(routeIsDeadEnd([lost, safe])).toBe(false);
  });

  it("keeps a closer settlement when the opponent cannot pay for the block", () => {
    const broke = assessSettlementRace({
      myRoads: 2,
      opponentRoads: 1,
      myProduction: hand({ lumber: 5, brick: 5, wool: 5, grain: 5 }),
      opponentProduction: empty(),
      myHand: hand({ lumber: 1, brick: 1, wool: 1, grain: 1 }),
      opponentKnown: hand({ ore: 8 }),
      opponentUnknown: 0
    });
    const funded = assessSettlementRace({
      myRoads: 2,
      opponentRoads: 1,
      myProduction: hand({ lumber: 5, brick: 5, wool: 5, grain: 5 }),
      opponentProduction: empty(),
      myHand: hand({ lumber: 1, brick: 1, wool: 1, grain: 1 }),
      opponentKnown: hand({ lumber: 2, brick: 2, wool: 1, grain: 1 }),
      opponentUnknown: 0
    });

    expect(broke.opponentRoads).toBeLessThan(broke.myRoads);
    expect(broke.opponentCanContest).toBe(false);
    expect(broke.lost).toBe(false);
    expect(broke.possibleThreat).toBe(false);
    expect(funded.lost).toBe(true);
    expect(broke.adjustment).toBeGreaterThan(funded.adjustment);
  });

  it("treats strong wood and brick as a race clock", () => {
    const ours = hand({ lumber: 10, brick: 10, wool: 6, grain: 6 });
    const slow = assessSettlementRace({
      myRoads: 2,
      opponentRoads: 1,
      myProduction: ours,
      opponentProduction: hand({ lumber: 1, brick: 1, wool: 6, grain: 6 }),
      myHand: empty(),
      opponentKnown: empty(),
      opponentUnknown: 0
    });
    const matched = assessSettlementRace({
      myRoads: 2,
      opponentRoads: 1,
      myProduction: ours,
      opponentProduction: ours,
      myHand: empty(),
      opponentKnown: empty(),
      opponentUnknown: 0
    });

    expect(slow.urgent).toBe(true);
    expect(slow.lost).toBe(false);
    expect(slow.myTurns).toBeLessThan(slow.opponentTurns ?? Infinity);
    expect(matched.lost).toBe(true);
    expect(matched.opponentTurns).toBeLessThan(matched.myTurns);
  });

  it("does not turn an unknown hand into a known road", () => {
    const uncertain = assessSettlementRace({
      myRoads: 2,
      opponentRoads: 1,
      myProduction: empty(),
      opponentProduction: empty(),
      myHand: empty(),
      opponentKnown: empty(),
      opponentUnknown: 8
    });
    const known = assessSettlementRace({
      myRoads: 2,
      opponentRoads: 1,
      myProduction: empty(),
      opponentProduction: empty(),
      myHand: empty(),
      opponentKnown: hand({ lumber: 2, brick: 2, wool: 1, grain: 1 }),
      opponentUnknown: 0
    });

    expect(uncertain.lost).toBe(false);
    expect(uncertain.possibleThreat).toBe(true);
    expect(uncertain.certainty).toBe("uncertain");
    expect(uncertain.opponentTurns).toBe(Infinity);
    expect(uncertain.adjustment).toBeGreaterThan(known.adjustment);
    expect(known.lost).toBe(true);
    expect(JSON.stringify(uncertain)).not.toContain("likely");
  });

  it("charges only the roads that are not already built", () => {
    const production = hand({ lumber: 4, brick: 4, wool: 4, grain: 4 });
    const reused = assessSettlementRace({
      myRoads: 1,
      myProduction: production,
      opponentProduction: empty(),
      myHand: empty()
    });
    const full = assessSettlementRace({
      myRoads: 3,
      myProduction: production,
      opponentProduction: empty(),
      myHand: empty()
    });

    expect(reused.myTurns).toBe(finishTurns(1, empty(), production, hand({ lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 })));
    expect(reused.myTurns).toBeLessThan(full.myTurns);
    expect(reused.myRoads).toBe(1);
  });

  it("counts a new harbor once and an owned harbor as no extra race value", () => {
    const shared = {
      myRoads: 1,
      opponentRoads: 3,
      myProduction: hand({ lumber: 4, brick: 4, wool: 4, grain: 4 }),
      opponentProduction: empty(),
      myHand: hand({ lumber: 2, brick: 2, wool: 1, grain: 1 }),
      opponentKnown: empty(),
      opponentUnknown: 0
    };
    const owned = assessSettlementRace({ ...shared, portImproves: false });
    const fresh = assessSettlementRace({ ...shared, portImproves: true });

    expect(owned.incrementalPort).toBe(0);
    expect(fresh.incrementalPort).toBeGreaterThan(0);
    expect(fresh.adjustment).toBe(owned.adjustment);
  });

  it("marks a sole lost settlement as a dead end and keeps an alternative", () => {
    const lost = assessSettlementRace({
      myRoads: 2,
      opponentRoads: 1,
      myProduction: empty(),
      opponentProduction: empty(),
      myHand: empty(),
      opponentKnown: hand({ lumber: 2, brick: 2, wool: 1, grain: 1 }),
      opponentUnknown: 0,
      soleAccess: true
    });
    const open = assessSettlementRace({
      myRoads: 1,
      myProduction: hand({ lumber: 5, brick: 5, wool: 5, grain: 5 }),
      opponentProduction: empty(),
      myHand: hand({ lumber: 2, brick: 2, wool: 1, grain: 1 }),
      soleAccess: true
    });

    expect(lost.deadEnd).toBe(true);
    expect(lost.choke).toBe(true);
    expect(open.deadEnd).toBe(false);
    expect(routeIsDeadEnd([lost])).toBe(true);
    expect(routeIsDeadEnd([open])).toBe(false);
  });

  it("prefers the settlement the opponent cannot take on the live board", () => {
    const layout = buildRaceBoard(true);
    const cards = {
      hand: layout.ourHand,
      opponentKnown: empty(),
      opponentUnknown: 0,
      maxDist: 2
    };
    const ranked = rankLiveSpots(layout.board, layout.placements, "c1", [], {
      myHand: layout.ourHand,
      opponentKnown: empty(),
      opponentUnknown: 0
    });
    const trap = ranked.spots.find((spot) => spot.at === layout.trapAt);
    const safe = ranked.spots.find((spot) => spot.at === layout.safeAt);
    const edge = bestEdge(layout.board, layout.placements, "c1", cards);
    const edges = rankEdges(layout.board, layout.placements, "c1", cards);
    const trapEdge = edges.find((row) => row.edge === layout.trapEdgeAt);

    expect(trap?.race?.lost).toBe(true);
    expect(trap?.race?.myRoads).toBe(2);
    expect(safe?.race?.lost).toBe(false);
    expect(safe?.race?.myRoads).toBe(1);
    expect(edge?.edge).not.toBe(layout.trapEdgeAt);
    expect(edge?.toward).not.toBe(layout.trapAt);
    expect(trapEdge?.dead).toBe(true);
    expect(edge && trapEdge && edge.score > trapEdge.score).toBe(true);

    const chosen = baselineRolloutPolicy.selectAction(layout.state, "c1", getLegalActions(layout.state, "c1"), createSeededRng(1), {
      stepIndex: 0,
      bankTradesThisTurn: 0
    });
    expect(chosen.type).toBe("buildRoad");
    if (chosen.type !== "buildRoad") return;
    expect(layout.state.topology.edges[chosen.edgeIndex].at).toBe(edge?.edge);
    expect(layout.state.topology.edges[chosen.edgeIndex].at).not.toBe(layout.trapEdgeAt);
  });

  it("does not call a broke opponent a winner just because he is closer", () => {
    const layout = buildRaceBoard(false);
    const ranked = rankLiveSpots(layout.board, layout.placements, "c1", [], {
      myHand: layout.ourHand,
      opponentKnown: empty(),
      opponentUnknown: 0
    });
    const trap = ranked.spots.find((spot) => spot.at === layout.trapAt);
    expect(trap?.race?.opponentRoads).toBeLessThan(trap?.race?.myRoads ?? 0);
    expect(trap?.race?.opponentCanContest).toBe(false);
    expect(trap?.race?.lost).toBe(false);
  });

  it("keeps an affordable city ahead of a contested road", () => {
    const { board, placements } = cityBoard();
    const plan = planTurn({
      board,
      placements,
      me: ME,
      hand: hand({ lumber: 1, brick: 1, wool: 0, grain: 2, ore: 3 }),
      handKnown: true,
      snapshot: snapshotFor(hand({ lumber: 1, brick: 1, wool: 0, grain: 2, ore: 3 }))
    });
    expect(plan.headline.toLowerCase()).toContain("city");
    expect(plan.headline).not.toContain("Road to the");
    expect(plan.shadowEvaluation).toBeUndefined();
    expect(plan.evaluation?.evaluatorId).toBe("settlement_race_v1");
  });

  it("builds a city before a road in the baseline rollout", () => {
    const state = playableState();
    state.players[0].hand = hand({ lumber: 1, brick: 1, wool: 0, grain: 2, ore: 3 });
    const chosen = baselineRolloutPolicy.selectAction(state, "c1", getLegalActions(state, "c1"), createSeededRng(2), {
      stepIndex: 0,
      bankTradesThisTurn: 0
    });
    expect(chosen.type).toBe("buildCity");
  });

  it("takes an immediate winning settlement before a road", () => {
    const state = playableState();
    state.rules = { ...state.rules, victoryPointsToWin: 2 };
    state.players[0].hand = hand({ lumber: 2, brick: 2, wool: 1, grain: 1 });
    const target = state.topology.corners.find((corner) => corner.index !== state.home && !corner.adjacentCornerIndices.includes(state.home));
    if (!target) throw new Error("No winning settlement.");
    for (const edge of shortestEdges(state.topology, state.home, target.index)) state.edgeOwner[edge.index] = "c1";
    const chosen = baselineRolloutPolicy.selectAction(state, "c1", getLegalActions(state, "c1"), createSeededRng(3), {
      stepIndex: 0,
      bankTradesThisTurn: 0
    });
    expect(chosen.type).toBe("buildSettlement");
    if (chosen.type !== "buildSettlement") return;
    const won = applyAction(state, "c1", chosen);
    expect(won.ok).toBe(true);
    if (!won.ok) return;
    expect(won.state.winnerId).toBe("c1");
  });

  it("does not add portWorth on top of the spot score", () => {
    const board = harborBoard();
    const ctx = contextFor(board.board);
    const report = portReportFor(ctx, board.placements, ME);
    const target = ctx.byAt.get(board.targetAt);
    if (!target?.port) throw new Error("Target has no harbor.");
    const own = profileOf(ctx, board.placements, (owner) => owner === ME);
    const scored = scoreSpot(ctx, target, own, new Set(board.placements.settlements.keys()), report.rates.rates);
    const plan = planMidgame(board.board, board.placements, ME);
    const spot = plan.expansion.find((row) => row.at === board.targetAt);
    const worth = portWorth(target.port, report.rates.rates, empty(), spot?.dist ?? 1);
    expect(worth).toBeGreaterThan(0);
    expect(spot).toBeDefined();
    expect(spot?.score).toBeCloseTo(scored.value - 1.4 * (spot?.dist ?? 0), 5);
  });
});

function radiusBoard(): Board {
  const coordinates: Array<[number, number]> = [];
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      if (Math.max(Math.abs(x), Math.abs(y), Math.abs(x + y)) <= 2) coordinates.push([x, y]);
    }
  }
  return {
    hexes: coordinates.map(([x, y], index) => ({ id: `h${index}`, x, y, resource: "lumber" as const, number: 5 })),
    ports: [],
    robberStart: "h0"
  };
}

function shortestEdges(topology: BoardTopology, from: number, to: number) {
  const previous = new Map<number, { corner: number; edgeIndex: number }>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current === to) break;
    const corner = topology.corners[current];
    for (let i = 0; i < corner.incidentEdgeIndices.length; i++) {
      const next = corner.adjacentCornerIndices[i];
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, { corner: current, edgeIndex: corner.incidentEdgeIndices[i] });
      queue.push(next);
    }
  }
  const edges: TopologyEdge[] = [];
  let cursor = to;
  while (cursor !== from) {
    const step = previous.get(cursor);
    if (!step) return [];
    edges.push(topology.edges[step.edgeIndex]);
    cursor = step.corner;
  }
  return edges.reverse();
}

function sharesHex(a: TopologyCorner, b: TopologyCorner): boolean {
  return a.hexIndices.some((index) => b.hexIndices.includes(index));
}

function buildRaceBoard(opponentProduces: boolean) {
  const bare = buildBoardTopology(radiusBoard());
  const distances = bare.corners.map((corner) => {
    const dist = new Array<number>(bare.corners.length).fill(Infinity);
    dist[corner.index] = 0;
    const queue = [corner.index];
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of bare.corners[current].adjacentCornerIndices) {
        if (dist[next] !== Infinity) continue;
        dist[next] = dist[current] + 1;
        queue.push(next);
      }
    }
    return dist;
  });
  const usable = bare.corners.filter((corner) => corner.hexIndices.length >= 2);
  let pairCount = 0;
  let houseCount = 0;
  let found:
    | {
        anchor: TopologyCorner;
        trap: TopologyCorner;
        safe: TopologyCorner;
        lumber: TopologyCorner;
        brick: TopologyCorner;
        wool: TopologyCorner;
        trapPath: TopologyEdge[];
        safePath: TopologyEdge[];
        oppPath: TopologyEdge[];
      }
    | undefined;
  for (const anchor of usable) {
    const traps = usable.filter((corner) => distances[anchor.index][corner.index] === 2 && corner.hexIndices.length >= 2);
    for (const trap of traps) {
      const trapPath = shortestEdges(bare, anchor.index, trap.index);
      if (trapPath.length !== 2) continue;
      for (const safe of traps) {
        if (safe.index === trap.index || safe.adjacentCornerIndices.includes(anchor.index) || trap.adjacentCornerIndices.includes(anchor.index)) continue;
        if (safe.adjacentCornerIndices.includes(trap.index)) continue;
        const safePath = shortestEdges(bare, anchor.index, safe.index);
        if (safePath.length !== 2 || safePath[0].index === trapPath[0].index) continue;
        const anchorHexes = new Set(anchor.hexIndices);
        if (!trap.hexIndices.some((hexIndex) => !anchorHexes.has(hexIndex))) continue;
        if (!safe.hexIndices.some((hexIndex) => !anchorHexes.has(hexIndex) && !trap.hexIndices.includes(hexIndex))) continue;
        pairCount += 1;
        const reserved = new Set([...anchor.hexIndices, ...trap.hexIndices, ...safe.hexIndices]);
        const exclusive = (corner: TopologyCorner) => corner.hexIndices.filter((hexIndex) => !reserved.has(hexIndex)).length;
        const houses = usable.filter(
          (corner) =>
            corner.index !== anchor.index &&
            corner.index !== trap.index &&
            corner.index !== safe.index &&
            !corner.adjacentCornerIndices.includes(anchor.index) &&
            !corner.adjacentCornerIndices.includes(trap.index) &&
            !corner.adjacentCornerIndices.includes(safe.index) &&
            exclusive(corner) >= 2
        );
        for (const lumber of houses) {
          if (distances[lumber.index][trap.index] !== 2) continue;
          const oppPath = shortestEdges(bare, lumber.index, trap.index);
          if (oppPath.length !== 2) continue;
          if (oppPath.some((edge) => trapPath.some((ours) => ours.index === edge.index) || safePath.some((ours) => ours.index === edge.index))) continue;
          houseCount += 1;
          const others = houses.filter((corner) => corner.index !== lumber.index && !sharesHex(corner, lumber) && !corner.adjacentCornerIndices.includes(lumber.index));
          for (const brick of others) {
            for (const wool of others) {
              if (wool.index === brick.index || sharesHex(wool, brick) || wool.adjacentCornerIndices.includes(brick.index)) continue;
              const touched = new Set<number>([lumber.index, brick.index, wool.index]);
              for (const edge of oppPath) {
                touched.add(edge.c1);
                touched.add(edge.c2);
              }
              const closestToSafe = Math.min(...[...touched].map((index) => distances[index][safe.index]));
              if (closestToSafe < 2) continue;
              found = { anchor, trap, safe, lumber, brick, wool, trapPath, safePath, oppPath };
              break;
            }
            if (found) break;
          }
          if (found) break;
        }
        if (found) break;
      }
      if (found) break;
    }
    if (found) break;
  }
  if (!found) throw new Error(`Could not place a settlement race. pairs=${pairCount} houses=${houseCount}`);

  const board = radiusBoard();
  for (const hex of board.hexes) {
    hex.resource = null;
    hex.number = null;
  }
  const claimed = new Set<number>();
  const claim = (corner: TopologyCorner, resources: Array<Board["hexes"][number]["resource"]>, numbers: number[]) => {
    const free = corner.hexIndices.filter((hexIndex) => !claimed.has(hexIndex));
    resources.forEach((resource, index) => {
      const hexIndex = free[index];
      if (!resource || hexIndex === undefined) return;
      board.hexes[hexIndex].resource = resource;
      board.hexes[hexIndex].number = numbers[index] ?? 6;
      claimed.add(hexIndex);
    });
  };
  claim(found.anchor, ["lumber", "brick"], [6, 6]);
  claim(found.trap, ["ore", "ore"], [6, 9]);
  claim(found.safe, ["ore", "ore"], [6, 8]);
  if (opponentProduces) {
    claim(found.lumber, ["lumber", "lumber"], [6, 8]);
    claim(found.brick, ["brick", "brick"], [6, 8]);
    claim(found.wool, ["wool", "grain"], [6, 8]);
  }
  const topology = buildBoardTopology(board);
  const at = (corner: TopologyCorner) => {
    const next = topology.corners.find((candidate) => candidate.at === corner.at);
    if (!next) throw new Error(`Missing corner ${corner.at}`);
    return next;
  };
  const anchor = at(found.anchor);
  const trap = at(found.trap);
  const safe = at(found.safe);
  const lumber = at(found.lumber);
  const brick = at(found.brick);
  const wool = at(found.wool);
  const edgeAt = (edge: TopologyEdge) => topology.edges.find((candidate) => candidate.at === edge.at);
  const trapPath = found.trapPath.map(edgeAt);
  const safePath = found.safePath.map(edgeAt);
  const oppPath = found.oppPath.map(edgeAt);
  if (trapPath.some((edge) => !edge) || safePath.some((edge) => !edge) || oppPath.some((edge) => !edge)) {
    throw new Error("Race edges changed after the board was numbered.");
  }
  const created = createInitialConcreteState({
    topology,
    playerIds: ["c1", "c2"],
    rules: { victoryPointsToWin: 15, cardDiscardLimit: 9, friendlyRobber: false, diceMode: "balanced" }
  });
  if (!created.ok) throw new Error(created.error.message);
  const state = created.state;
  state.phase = "main";
  state.dice = { thrown: true, d1: 2, d2: 3, total: 5 };
  const ourHand = hand({ lumber: 1, brick: 1, wool: 1, grain: 1 });
  state.players[0].hand = ourHand;
  state.players[1].hand = empty();
  const own = (index: number, player: string) => {
    state.cornerOwner[index] = player;
    state.cornerPiece[index] = 1;
  };
  own(anchor.index, "c1");
  own(lumber.index, "c2");
  if (opponentProduces) {
    own(brick.index, "c2");
    own(wool.index, "c2");
  }
  state.edgeOwner[safePath[0]!.index] = "c1";
  for (const edge of oppPath) state.edgeOwner[edge!.index] = "c2";
  state.players[0].settlementsLeft = 4;
  state.players[1].settlementsLeft = 4;
  state.players[0].roadsLeft = 12;
  state.players[1].roadsLeft = 12;
  return {
    board,
    state,
    placements: placementsOf(state),
    ourHand,
    trapAt: trap.at,
    safeAt: safe.at,
    trapEdgeAt: trapPath[0]!.at
  };
}

function placementsOf(state: ConcreteSimulatedGameState): Placements {
  const placements: Placements = { settlements: new Map(), cities: new Map(), roads: new Map() };
  state.cornerOwner.forEach((owner, index) => {
    if (owner) placements.settlements.set(state.topology.corners[index].at, owner);
  });
  state.edgeOwner.forEach((owner, index) => {
    if (owner) placements.roads.set(state.topology.edges[index].at, owner);
  });
  return placements;
}

function harborBoard() {
  const bare = buildBoardTopology(radiusBoard());
  const coastal = bare.edges.filter((edge) => edge.hexIndices.length === 1);
  let generic: TopologyEdge | undefined;
  let specific: TopologyEdge | undefined;
  for (const left of coastal) {
    for (const right of coastal) {
      if (left.index === right.index) continue;
      const from = bare.corners[left.c1];
      const to = bare.corners[right.c1];
      if (from.adjacentCornerIndices.includes(to.index)) continue;
      const path = shortestEdges(bare, from.index, to.index);
      if (path.length < 2 || path.length > 3) continue;
      generic = left;
      specific = right;
      break;
    }
    if (specific) break;
  }
  if (!generic || !specific) throw new Error("Need two harbors.");
  const board: Board = { ...radiusBoard(), ports: [{ at: generic.at, kind: "any" }, { at: specific.at, kind: "ore" }] };
  const topology = buildBoardTopology(board);
  const owned = topology.corners[topology.edges.find((edge) => edge.at === generic.at)!.c1];
  const target = topology.corners[topology.edges.find((edge) => edge.at === specific.at)!.c1];
  const path = shortestEdges(topology, owned.index, target.index);
  const placements: Placements = { settlements: new Map([[owned.at, ME]]), cities: new Map(), roads: new Map() };
  for (const edge of path.slice(0, -1)) placements.roads.set(edge.at, ME);
  target.hexIndices.forEach((hexIndex, index) => {
    board.hexes[hexIndex].resource = "ore";
    board.hexes[hexIndex].number = index === 0 ? 6 : 8;
  });
  return { board, placements, targetAt: target.at };
}

function cityBoard() {
  const topology = buildBoardTopology(radiusBoard());
  const home = topology.corners.find((corner) => corner.hexIndices.length >= 2);
  if (!home) throw new Error("No city vertex.");
  const board = radiusBoard();
  board.hexes[home.hexIndices[0]].resource = "ore";
  board.hexes[home.hexIndices[0]].number = 6;
  board.hexes[home.hexIndices[1]].resource = "grain";
  board.hexes[home.hexIndices[1]].number = 8;
  const placements: Placements = { settlements: new Map([[home.at, ME]]), cities: new Map(), roads: new Map() };
  return { board, placements };
}

function playableState(): ConcreteSimulatedGameState & { home: number } {
  const board = radiusBoard();
  const topology = buildBoardTopology(board);
  const home = topology.corners.find((corner) => corner.hexIndices.length >= 2);
  if (!home) throw new Error("No home vertex.");
  board.hexes[home.hexIndices[0]].resource = "ore";
  board.hexes[home.hexIndices[0]].number = 6;
  board.hexes[home.hexIndices[1]].resource = "grain";
  board.hexes[home.hexIndices[1]].number = 9;
  const numbered = buildBoardTopology(board);
  const created = createInitialConcreteState({
    topology: numbered,
    playerIds: ["c1", "c2"],
    rules: { victoryPointsToWin: 15, cardDiscardLimit: 9, friendlyRobber: false, diceMode: "balanced" }
  });
  if (!created.ok) throw new Error(created.error.message);
  const state = created.state as ConcreteSimulatedGameState & { home: number };
  const corner = numbered.corners.find((candidate) => candidate.at === home.at);
  if (!corner) throw new Error("Home corner moved.");
  state.phase = "main";
  state.dice = { thrown: true, d1: 3, d2: 3, total: 6 };
  state.cornerOwner[corner.index] = "c1";
  state.cornerPiece[corner.index] = 1;
  state.home = corner.index;
  state.players[0].settlementsLeft = 4;
  state.players[0].roadsLeft = 14;
  return state;
}

function snapshotFor(cards: ResourceHand): GameSnapshot {
  const player = (id: string): PlayerSnapshot => ({
    id,
    vp: 2,
    visibleVp: 2,
    hiddenVp: 0,
    handSize: Object.values(cards).reduce((sum, count) => sum + count, 0),
    ratios: {},
    roadLength: 1,
    hasLongestRoad: false,
    army: 0,
    hasLargestArmy: false,
    devsInHand: 0,
    unknownDevsInHand: 0,
    devsPlayed: 0,
    knights: 0,
    settlementsLeft: 4,
    citiesLeft: 3,
    roadsLeft: 14
  });
  return {
    players: [player(ME), player(OPP)],
    dice: { thrown: true, d1: 3, d2: 3 },
    completedTurns: 8,
    gameSettings: { victoryPointsToWin: 15, cardDiscardLimit: 9 }
  };
}
