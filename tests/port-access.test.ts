import { describe, expect, it } from "vitest";
import type { Board, Placements, ResourceHand } from "../src/analyzer/types";
import type { GameSnapshot, PlayerSnapshot } from "../src/analyzer/snapshot";
import { contextFor, portReportFor, scoreSpot } from "../src/analyzer/strategy";
import {
  mergeTradeRates,
  ratesFromPlacements,
  resourcesImprovedByHarbor,
  viablePortTargets
} from "../src/analyzer/engine/ports";
import { bestEdge } from "../src/analyzer/engine/value";
import { planTurn, tradesToPay } from "../src/analyzer/engine/decide";
import { buildBoardTopology, type BoardTopology } from "../src/analyzer/engine/topology";
import { applyAction, createInitialConcreteState, getLegalActions } from "../src/analyzer/engine/transition";
import { baselineRolloutPolicy } from "../src/analyzer/engine/rollout";
import { createSeededRng } from "../src/analyzer/engine/rng";
import type { ConcreteSimulatedGameState } from "../src/analyzer/engine/state";
import { COSTS } from "../src/analyzer/tracker";

const ME = "me";
const OPP = "opp";

function emptyPlacements(): Placements {
  return { settlements: new Map(), cities: new Map(), roads: new Map() };
}

function bankRates(): ResourceHand {
  return { lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 };
}

function radiusBoard(): Board {
  const coordinates: Array<[number, number]> = [];
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      if (Math.max(Math.abs(x), Math.abs(y), Math.abs(x + y)) <= 2) coordinates.push([x, y]);
    }
  }
  return {
    hexes: coordinates.map(([x, y], index) => ({
      id: `h${index}`,
      x,
      y,
      resource: "lumber",
      number: 5
    })),
    ports: [],
    robberStart: "h0"
  };
}

function withPorts(board: Board, ports: Board["ports"]): Board {
  return { ...board, hexes: board.hexes.map((hex) => ({ ...hex })), ports: ports ?? [] };
}

function disjointCoastal(topology: BoardTopology, count: number) {
  const used = new Set<number>();
  const chosen = [];
  for (const edge of topology.edges) {
    if (edge.hexIndices.length !== 1) continue;
    if (used.has(edge.c1) || used.has(edge.c2)) continue;
    if ([...used].some((index) => topology.corners[index].adjacentCornerIndices.includes(edge.c1) || topology.corners[index].adjacentCornerIndices.includes(edge.c2))) {
      continue;
    }
    chosen.push(edge);
    used.add(edge.c1);
    used.add(edge.c2);
    if (chosen.length === count) break;
  }
  if (chosen.length < count) throw new Error(`Needed ${count} separated coastal edges, found ${chosen.length}.`);
  return chosen;
}

function boardWithHarbors() {
  const bare = buildBoardTopology(radiusBoard());
  const [generic, specific, secondGeneric] = disjointCoastal(bare, 3);
  const board = withPorts(bare.board, [
    { at: generic.at, kind: "any" },
    { at: specific.at, kind: "ore" },
    { at: secondGeneric.at, kind: "any" }
  ]);
  const topology = buildBoardTopology(board);
  return { board, topology, genericAt: generic.at, specificAt: specific.at, secondGenericAt: secondGeneric.at };
}

function harborCorners(topology: BoardTopology, edgeAt: string) {
  const edge = topology.edges.find((candidate) => candidate.at === edgeAt);
  if (!edge) throw new Error(`Missing edge ${edgeAt}`);
  return [topology.corners[edge.c1], topology.corners[edge.c2]] as const;
}

function reportFor(board: Board, placements: Placements, playerId = ME) {
  return portReportFor(contextFor(board), placements, playerId);
}

describe("Port access and existing-road reuse", () => {
  it("A. treats a settlement on a 3:1 harbor as active 3:1 access", () => {
    const { board, topology, genericAt } = boardWithHarbors();
    const [corner] = harborCorners(topology, genericAt);
    const placements = emptyPlacements();
    placements.settlements.set(corner.at, ME);
    const report = reportFor(board, placements);

    expect(report.active).toEqual([
      expect.objectContaining({ at: corner.at, kind: "any", piece: "settlement", harborEdgeAt: genericAt })
    ]);
    expect(report.rates.rates).toEqual({ lumber: 3, brick: 3, wool: 3, grain: 3, ore: 3 });
    expect(report.rates.source.lumber).toBe("generic");
    expect(report.potential.some((port) => port.harborEdgeAt === genericAt && port.improvesRate)).toBe(false);
    expect(viablePortTargets(report).some((port) => port.harborEdgeAt === genericAt)).toBe(false);
  });

  it("B. applies a 2:1 harbor to its own resource and keeps a separate 3:1 for the others", () => {
    const { board, topology, genericAt, specificAt } = boardWithHarbors();
    const [genericCorner] = harborCorners(topology, genericAt);
    const [oreCorner] = harborCorners(topology, specificAt);
    const placements = emptyPlacements();
    placements.settlements.set(genericCorner.at, ME);
    placements.settlements.set(oreCorner.at, ME);
    const rates = ratesFromPlacements(contextFor(board), placements, (owner) => owner === ME);

    expect(rates.ore).toBe(2);
    expect(rates.lumber).toBe(3);
    expect(rates.brick).toBe(3);
    expect(rates.wool).toBe(3);
    expect(rates.grain).toBe(3);
    expect(resourcesImprovedByHarbor(rates, "ore")).toEqual([]);
    expect(resourcesImprovedByHarbor(rates, "wool").length).toBeGreaterThan(0);
  });

  it("C. keeps the harbor when the settlement on it is upgraded to a city", () => {
    const { board, topology, genericAt } = boardWithHarbors();
    const [corner] = harborCorners(topology, genericAt);
    const placements = emptyPlacements();
    placements.cities.set(corner.at, ME);
    const report = reportFor(board, placements);

    expect(report.active[0]).toEqual(expect.objectContaining({ at: corner.at, piece: "city", kind: "any" }));
    expect(report.rates.rates.grain).toBe(3);
    expect(report.rates.rates.ore).toBe(3);
  });

  it("D. does not activate a harbor when only a road reaches it", () => {
    const { board, topology, genericAt } = boardWithHarbors();
    const [portCorner] = harborCorners(topology, genericAt);
    const start = topology.corners.find((corner) => shortestEdges(topology, corner.index, portCorner.index).length === 2);
    if (!start) throw new Error("No settlement two roads from the harbor.");
    const path = shortestEdges(topology, start.index, portCorner.index);
    const placements = emptyPlacements();
    placements.settlements.set(start.at, ME);
    for (const edge of path) placements.roads.set(edge.at, ME);
    const report = reportFor(board, placements);
    const reached = report.potential.find((port) => port.at === portCorner.at);

    expect(start.adjacentCornerIndices.includes(portCorner.index)).toBe(false);
    expect(report.active).toEqual([]);
    expect(report.rates.rates).toEqual(bankRates());
    expect(reached?.roadsRemaining).toBe(0);
    expect(reached?.improvesRate).toBe(true);
    expect(reached?.settlementLegal).toBe(true);
    expect(viablePortTargets(report).some((port) => port.at === portCorner.at && port.roadsRemaining === 0)).toBe(true);
  });

  it("E. charges only the roads that are not already built", () => {
    const { board, topology, specificAt } = boardWithHarbors();
    const [target] = harborCorners(topology, specificAt);
    const start = topology.corners.find((corner) => {
      if (corner.index === target.index || corner.adjacentCornerIndices.includes(target.index)) return false;
      return shortestEdges(topology, corner.index, target.index).length >= 2;
    });
    if (!start) throw new Error("No inland start corner.");
    const path = shortestEdges(topology, start.index, target.index);
    expect(path.length).toBeGreaterThanOrEqual(2);

    const untouched = emptyPlacements();
    untouched.settlements.set(start.at, ME);
    const before = reportFor(board, untouched).potential.find((port) => port.at === target.at);
    expect(before?.roadsRemaining).toBe(path.length);

    const built = emptyPlacements();
    built.settlements.set(start.at, ME);
    for (const edge of path.slice(0, -1)) built.roads.set(edge.at, ME);
    const after = reportFor(board, built).potential.find((port) => port.at === target.at);
    expect(after?.roadsRemaining).toBe(1);
    expect(after?.roadsRemaining).toBeLessThan(path.length);

    const countedAgain = remainingRoads(
      topology,
      topology.edges.map((edge) => (built.roads.get(edge.at) === ME ? ME : null)),
      [start.index],
      target.index,
      ME
    );
    expect(after?.roadsRemaining).toBe(countedAgain);
  });

  it("F. does not add port value for a harbor type the player already owns", () => {
    const { board, topology, genericAt, secondGenericAt } = boardWithHarbors();
    const [owned] = harborCorners(topology, genericAt);
    const [redundantCorner] = harborCorners(topology, secondGenericAt);
    const ctx = contextFor(board);
    const redundant = ctx.byAt.get(redundantCorner.at);
    if (!redundant) throw new Error("Redundant harbor vertex is missing from the coach board.");
    const taken = new Set([owned.at]);
    const ownedRates = { lumber: 3, brick: 3, wool: 3, grain: 3, ore: 3 };
    const withoutOwnership = scoreSpot(ctx, redundant, bankRates(), taken).value;
    const withOwnership = scoreSpot(ctx, redundant, bankRates(), taken, ownedRates).value;
    expect(withOwnership).toBeLessThan(withoutOwnership);

    const placements = emptyPlacements();
    placements.settlements.set(owned.at, ME);
    const report = reportFor(board, placements);
    expect(report.potential.find((port) => port.at === redundantCorner.at)?.improvesRate).toBe(false);
    expect(viablePortTargets(report).some((port) => port.harborEdgeAt === secondGenericAt)).toBe(false);
  });

  it("G. still values a harbor that improves a rate the player does not have", () => {
    const { board, topology, genericAt, specificAt } = boardWithHarbors();
    const [genericCorner] = harborCorners(topology, genericAt);
    const [oreVertex] = harborCorners(topology, specificAt);
    const ctx = contextFor(board);
    const oreCorner = ctx.byAt.get(oreVertex.at);
    if (!oreCorner) throw new Error("Ore harbor vertex is missing from the coach board.");
    const rates = { lumber: 3, brick: 3, wool: 3, grain: 3, ore: 3 };
    const alreadySpecific = { ...rates, ore: 2 };
    const open = scoreSpot(ctx, oreCorner, bankRates(), new Set([genericCorner.at]), rates).value;
    const closed = scoreSpot(ctx, oreCorner, bankRates(), new Set([genericCorner.at]), alreadySpecific).value;
    expect(open).toBeGreaterThan(closed);
    expect(resourcesImprovedByHarbor(rates, "ore")).toEqual(["ore"]);

    const placements = emptyPlacements();
    placements.settlements.set(genericCorner.at, ME);
    const target = reportFor(board, placements).potential.find((port) => port.at === oreVertex.at);
    expect(target?.improvesRate).toBe(true);
    expect(target?.improvedResources).toEqual(["ore"]);
  });

  it("H. rejects an occupied or distance-illegal harbor vertex", () => {
    const { board, topology, genericAt, specificAt } = boardWithHarbors();
    const [owned, sibling] = harborCorners(topology, genericAt);
    const [blocked] = harborCorners(topology, specificAt);
    const placements = emptyPlacements();
    placements.settlements.set(owned.at, ME);
    placements.settlements.set(blocked.at, OPP);
    const report = reportFor(board, placements);
    const siblingTarget = report.potential.find((port) => port.at === sibling.at);
    const occupiedTarget = report.potential.find((port) => port.at === blocked.at);

    expect(siblingTarget?.acquisitionBlocked).toBe(true);
    expect(siblingTarget?.settlementLegal).toBe(false);
    expect(occupiedTarget?.occupiedBy).toBe(OPP);
    expect(occupiedTarget?.acquisitionBlocked).toBe(true);
    expect(viablePortTargets(report).some((port) => port.at === sibling.at || port.at === blocked.at)).toBe(false);
  });

  it("I. uses the owned harbor rate instead of a 4:1 trade", () => {
    const hand: ResourceHand = { lumber: 0, brick: 0, wool: 3, grain: 2, ore: 2 };
    const threeToOne = { lumber: 3, brick: 3, wool: 3, grain: 3, ore: 3 };
    expect(tradesToPay(hand, threeToOne, COSTS.city)).toBe(1);
    expect(tradesToPay(hand, bankRates(), COSTS.city)).toBe(99);
    expect(mergeTradeRates(bankRates(), threeToOne)).toEqual(threeToOne);

    const { board, topology, genericAt } = boardWithHarbors();
    const corner = harborCorners(topology, genericAt).find((candidate) => candidate.hexIndices.length >= 2);
    if (!corner) throw new Error("3:1 harbor has no two-hex vertex.");
    const oreHex = corner.hexIndices[0];
    const grainHex = corner.hexIndices[1];
    board.hexes[oreHex].resource = "ore";
    board.hexes[oreHex].number = 6;
    board.hexes[grainHex].resource = "grain";
    board.hexes[grainHex].number = 8;
    const placements = emptyPlacements();
    placements.settlements.set(corner.at, ME);
    placements.settlements.set(topology.corners.find((candidate) => candidate.index !== corner.index && !candidate.adjacentCornerIndices.includes(corner.index))!.at, OPP);

    const plan = planTurn({
      board,
      placements,
      me: ME,
      hand,
      handKnown: true,
      snapshot: snapshotFor(hand)
    });

    expect(plan.headline.toLowerCase()).toContain("city");
    expect(plan.headline).not.toContain("Do not 4:1");
    expect(plan.tips.map((tip) => tip.why).join(" ")).toContain("3:1");
    expect(plan.tips.map((tip) => tip.why).join(" ")).not.toContain("bank at 4:1");
    expect(plan.shadowEvaluation).toBeUndefined();
  });

  it("keeps an affordable city ahead of a new harbor road", () => {
    const { board, topology, genericAt, specificAt } = boardWithHarbors();
    const [home] = harborCorners(topology, genericAt);
    const [orePort] = harborCorners(topology, specificAt);
    const approach = shortestEdges(topology, home.index, orePort.index)[0];
    const placements = emptyPlacements();
    placements.settlements.set(home.at, ME);
    if (approach) placements.roads.set(approach.at, ME);
    const oreHex = home.hexIndices[0];
    const grainHex = home.hexIndices[1] ?? oreHex;
    board.hexes[oreHex].resource = "ore";
    board.hexes[oreHex].number = 6;
    board.hexes[grainHex].resource = "grain";
    board.hexes[grainHex].number = 9;

    const plan = planTurn({
      board,
      placements,
      me: ME,
      hand: { lumber: 1, brick: 1, wool: 1, grain: 2, ore: 3 },
      handKnown: true,
      snapshot: snapshotFor({ lumber: 1, brick: 1, wool: 1, grain: 2, ore: 3 })
    });

    expect(plan.headline.toLowerCase()).toContain("city");
    expect(plan.headline).not.toContain("Road to the");
  });

  it("J. agrees with the spatial engine on owned rates, city upgrades, and roads still to build", () => {
    const { board, topology, genericAt } = boardWithHarbors();
    expect(topology.variant.isStandard19Hex).toBe(true);
    const [portCorner] = harborCorners(topology, genericAt);
    const created = createInitialConcreteState({
      topology,
      playerIds: ["c1", "c2"],
      rules: { victoryPointsToWin: 15, cardDiscardLimit: 9, friendlyRobber: false, diceMode: "balanced" }
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const settled = applyAction(created.state, "c1", { type: "placeSetupSettlement", cornerIndex: portCorner.index });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    const afterSettlement = placementsOf(settled.state);
    const settlementReport = portReportFor(contextFor(board), afterSettlement, "c1");
    expect(settlementReport.rates.rates).toEqual(settled.state.players[0].ratios);
    expect(settlementReport.active[0]?.piece).toBe("settlement");
    const ratesBeforeCity = { ...settled.state.players[0].ratios };

    const main = settled.state;
    main.phase = "main";
    main.dice = { thrown: true, d1: 4, d2: 5, total: 9 };
    main.players[0].hand = { lumber: 0, brick: 0, wool: 0, grain: 2, ore: 3 };
    const city = applyAction(main, "c1", { type: "buildCity", cornerIndex: portCorner.index });
    expect(city.ok).toBe(true);
    if (!city.ok) return;
    expect(city.state.players[0].ratios).toEqual(ratesBeforeCity);
    const cityReport = portReportFor(contextFor(board), placementsOf(city.state), "c1");
    expect(cityReport.active[0]?.piece).toBe("city");
    expect(cityReport.rates.rates).toEqual(city.state.players[0].ratios);

    const start = topology.corners.find((corner) => shortestEdges(topology, corner.index, portCorner.index).length >= 2 && corner.index !== portCorner.index);
    if (!start) throw new Error("No road-reuse start.");
    const path = shortestEdges(topology, start.index, portCorner.index);
    const roadsOnly = emptyPlacements();
    roadsOnly.settlements.set(start.at, "c1");
    for (const edge of path.slice(0, -1)) roadsOnly.roads.set(edge.at, "c1");
    const coachRemaining = portReportFor(contextFor(board), roadsOnly, "c1").potential.find((port) => port.at === portCorner.at)?.roadsRemaining;
    const engineRemaining = remainingRoads(
      topology,
      topology.edges.map((edge) => (roadsOnly.roads.get(edge.at) === "c1" ? "c1" : null)),
      [start.index],
      portCorner.index,
      "c1"
    );
    expect(coachRemaining).toBe(1);
    expect(coachRemaining).toBe(engineRemaining);
  });

  it("prefers production over a redundant harbor in the baseline rollout", () => {
    const setup = redundantSettlementChoice();
    const legal = getLegalActions(setup.state, "c1");
    const chosen = baselineRolloutPolicy.selectAction(setup.state, "c1", legal, createSeededRng(1), {
      stepIndex: 0,
      bankTradesThisTurn: 0
    });
    expect(chosen.type).toBe("buildSettlement");
    if (chosen.type !== "buildSettlement") return;
    expect(chosen.cornerIndex).not.toBe(setup.weakPortIndex);
    expect(orePips(setup.state, chosen.cornerIndex)).toBeGreaterThan(orePips(setup.state, setup.weakPortIndex));
  });

  it("K. reports an opponent road distance without inventing a hidden hand", () => {
    const { board, topology, specificAt } = boardWithHarbors();
    const [target] = harborCorners(topology, specificAt);
    const mine = topology.corners.find((corner) => shortestEdges(topology, corner.index, target.index).length >= 2);
    const opponent = topology.corners.find((corner) => corner.index !== mine?.index && shortestEdges(topology, corner.index, target.index).length === 1);
    if (!mine || !opponent) throw new Error("Could not place an opponent closer to the harbor.");
    const placements = emptyPlacements();
    placements.settlements.set(mine.at, ME);
    placements.settlements.set(opponent.at, OPP);
    for (const edge of shortestEdges(topology, opponent.index, target.index)) placements.roads.set(edge.at, OPP);
    const targetReport = reportFor(board, placements).potential.find((port) => port.at === target.at);

    expect(targetReport?.opponentRoadsRemaining).toBe(0);
    expect(targetReport?.roadsRemaining).toBeGreaterThan(0);
    expect(Object.keys(targetReport ?? {})).not.toContain("hand");
    expect(JSON.stringify(targetReport)).not.toContain("likely");
  });

  it("does not steer bestEdge at a redundant harbor when a stronger spot still needs a road", () => {
    const setup = redundantSettlementChoice("approach");
    const weakAt = setup.state.topology.corners[setup.weakPortIndex].at;
    const strongAt = setup.state.topology.corners[setup.strongIndex].at;
    const ctx = contextFor(setup.board);
    const placements = placementsOf(setup.state);
    const rates = portReportFor(ctx, placements, "c1").rates.rates;
    const taken = new Set<string>([...placements.settlements.keys(), ...placements.cities.keys()]);
    const weak = ctx.byAt.get(weakAt);
    const strong = ctx.byAt.get(strongAt);
    if (!weak || !strong) throw new Error("Missing scored corners.");
    const ownedWeak = scoreSpot(ctx, weak, bankRates(), taken, rates).value;
    const unownedWeak = scoreSpot(ctx, weak, bankRates(), taken).value;
    const ownedStrong = scoreSpot(ctx, strong, bankRates(), taken, rates).value;
    expect(rates.lumber).toBe(3);
    expect(ownedWeak).toBeLessThan(unownedWeak);
    expect(ownedStrong).toBeGreaterThan(ownedWeak);
    const edge = bestEdge(setup.board, placements, "c1", { maxDist: 2 });
    expect(edge?.toward).not.toBe(weakAt);
  });
});

function snapshotFor(hand: ResourceHand): GameSnapshot {
  const player = (id: string): PlayerSnapshot => ({
    id,
    vp: 2,
    visibleVp: 2,
    hiddenVp: 0,
    handSize: Object.values(hand).reduce((sum, count) => sum + count, 0),
    ratios: {},
    roadLength: 2,
    hasLongestRoad: false,
    army: 0,
    hasLargestArmy: false,
    devsInHand: 0,
    unknownDevsInHand: 0,
    devsPlayed: 0,
    knights: 0,
    settlementsLeft: 4,
    citiesLeft: 4,
    roadsLeft: 13
  });
  return {
    players: [player(ME), player(OPP)],
    dice: { thrown: true, d1: 3, d2: 3 },
    completedTurns: 10,
    gameSettings: { victoryPointsToWin: 15, cardDiscardLimit: 9 }
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
  const edges = [];
  let cursor = to;
  while (cursor !== from) {
    const step = previous.get(cursor);
    if (!step) return [];
    edges.push(topology.edges[step.edgeIndex]);
    cursor = step.corner;
  }
  return edges.reverse();
}

function remainingRoads(
  topology: BoardTopology,
  edgeOwner: Array<string | null>,
  starts: number[],
  goal: number,
  playerId: string
): number | undefined {
  const distance = new Map<number, number>();
  for (const start of starts) distance.set(start, 0);
  const done = new Set<number>();
  for (;;) {
    let current: number | undefined;
    for (const [corner, cost] of distance) {
      if (done.has(corner)) continue;
      if (current === undefined || cost < distance.get(current)!) current = corner;
    }
    if (current === undefined) return undefined;
    done.add(current);
    if (current === goal) return distance.get(current);
    const corner = topology.corners[current];
    for (let i = 0; i < corner.incidentEdgeIndices.length; i++) {
      const edgeIndex = corner.incidentEdgeIndices[i];
      const next = corner.adjacentCornerIndices[i];
      const owner = edgeOwner[edgeIndex];
      if (owner && owner !== playerId) continue;
      const step = owner === playerId ? 0 : 1;
      const nextCost = distance.get(current)! + step;
      if (nextCost < (distance.get(next) ?? Infinity)) distance.set(next, nextCost);
    }
  }
}

function orePips(state: ConcreteSimulatedGameState, cornerIndex: number): number {
  return state.topology.corners[cornerIndex].hexIndices.reduce((sum, hexIndex) => {
    const hex = state.topology.hexes[hexIndex];
    return sum + (hex.resource === "ore" ? hex.pips : 0);
  }, 0);
}

function placementsOf(state: ConcreteSimulatedGameState): Placements {
  const placements = emptyPlacements();
  state.cornerOwner.forEach((owner, index) => {
    if (!owner) return;
    const at = state.topology.corners[index].at;
    if (state.cornerPiece[index] === 2) placements.cities.set(at, owner);
    else placements.settlements.set(at, owner);
  });
  state.edgeOwner.forEach((owner, index) => {
    if (owner) placements.roads.set(state.topology.edges[index].at, owner);
  });
  return placements;
}

function redundantSettlementChoice(roads: "full" | "approach" = "full"): {
  state: ConcreteSimulatedGameState;
  board: Board;
  strongIndex: number;
  weakPortIndex: number;
} {
  const bare = buildBoardTopology(radiusBoard());
  const twoHex = bare.corners.filter((corner) => corner.hexIndices.length === 2);
  let weakAt = "";
  let strongAt = "";
  let anchorAt = "";
  let weakPortAt = "";
  let ownedPortAt = "";
  let weakHexes: number[] = [];
  let strongHexes: number[] = [];
  for (const left of twoHex) {
    for (const right of twoHex) {
      if (left.index === right.index) continue;
      if (left.hexIndices.some((index) => right.hexIndices.includes(index))) continue;
      if (left.adjacentCornerIndices.includes(right.index)) continue;
      const home = bare.corners.find(
        (corner) =>
          corner.index !== left.index &&
          corner.index !== right.index &&
          !corner.adjacentCornerIndices.includes(left.index) &&
          !corner.adjacentCornerIndices.includes(right.index) &&
          shortestEdges(bare, corner.index, left.index).length >= 2 &&
          shortestEdges(bare, corner.index, right.index).length >= 2
      );
      if (!home) continue;
      const weakEdge = left.incidentEdgeIndices
        .map((index) => bare.edges[index])
        .find((edge) => {
          const other = edge.c1 === left.index ? edge.c2 : edge.c1;
          return edge.hexIndices.length === 1 && other !== right.index && other !== home.index && !home.adjacentCornerIndices.includes(other);
        });
      const ownedEdge = home.incidentEdgeIndices
        .map((index) => bare.edges[index])
        .find((edge) => {
          const other = edge.c1 === home.index ? edge.c2 : edge.c1;
          return (
            edge.hexIndices.length === 1 &&
            edge.at !== weakEdge?.at &&
            other !== left.index &&
            other !== right.index &&
            !bare.corners[other].adjacentCornerIndices.includes(left.index) &&
            !bare.corners[other].adjacentCornerIndices.includes(right.index)
          );
        });
      if (!weakEdge || !ownedEdge) continue;
      weakAt = left.at;
      strongAt = right.at;
      anchorAt = home.at;
      weakPortAt = weakEdge.at;
      ownedPortAt = ownedEdge.at;
      weakHexes = [...left.hexIndices];
      strongHexes = [...right.hexIndices];
      break;
    }
    if (weakAt) break;
  }
  if (!weakAt || !strongAt || !anchorAt) throw new Error("Could not place a redundant harbor against a stronger spot.");

  const board = withPorts(bare.board, [
    { at: ownedPortAt, kind: "any" },
    { at: weakPortAt, kind: "any" }
  ]);
  for (const hex of board.hexes) {
    hex.resource = null;
    hex.number = null;
  }
  const [weakFive, weakFour] = weakHexes;
  const [strongFirst, strongSecond] = strongHexes;
  board.hexes[weakFive].resource = "ore";
  board.hexes[weakFive].number = 6;
  board.hexes[weakFour].resource = "ore";
  board.hexes[weakFour].number = 9;
  board.hexes[strongFirst].resource = "ore";
  board.hexes[strongFirst].number = 6;
  board.hexes[strongSecond].resource = "ore";
  board.hexes[strongSecond].number = 8;
  const topology = buildBoardTopology(board);
  const atIndex = (at: string) => {
    const corner = topology.corners.find((candidate) => candidate.at === at);
    if (!corner) throw new Error(`Corner ${at} disappeared after adding harbors.`);
    return corner.index;
  };
  const anchorIndex = atIndex(anchorAt);
  const weakIndex = atIndex(weakAt);
  const strongIndex = atIndex(strongAt);
  if (topology.corners[anchorIndex].port !== "any" || topology.corners[weakIndex].port !== "any") {
    throw new Error("Harbor did not attach to the chosen vertices.");
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
  state.cornerOwner[anchorIndex] = "c1";
  state.cornerPiece[anchorIndex] = 1;
  state.players[0].settlementsLeft = 4;
  state.players[0].ratios = { lumber: 3, brick: 3, wool: 3, grain: 3, ore: 3 };
  state.players[0].hand = { lumber: 1, brick: 1, wool: 1, grain: 1, ore: 0 };
  for (const target of [weakIndex, strongIndex]) {
    const path = shortestEdges(topology, anchorIndex, target);
    const built = roads === "full" ? path : path.slice(0, -1);
    for (const edge of built) state.edgeOwner[edge.index] = "c1";
  }
  state.players[0].roadsLeft = Math.max(0, 15 - topology.edges.filter((edge) => state.edgeOwner[edge.index] === "c1").length);
  return { state, board, strongIndex, weakPortIndex: weakIndex };
}
