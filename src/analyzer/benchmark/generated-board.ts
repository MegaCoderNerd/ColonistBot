/**
 * Recording-free standard board for cross-play.
 *
 * The layout is a radius-2 hex of 19 tiles. Resource counts and number tokens match the
 * base game. The shuffle is seeded, so the same seed rebuilds the same board. This is not
 * a Colonist map seed and it is not a claim about the official map generator.
 */

import type { Board, HexTile, PortKind, Resource } from "../types";
import { buildBoardTopology, type BoardTopology } from "../engine/topology";
import { createSeededRng } from "../engine/rng";
import { buildObservedGameState, type ObservedGameState } from "../engine/state";

const RESOURCE_BAG: Array<Resource | null> = [
  "lumber", "lumber", "lumber", "lumber",
  "wool", "wool", "wool", "wool",
  "grain", "grain", "grain", "grain",
  "brick", "brick", "brick",
  "ore", "ore", "ore",
  null
];

const NUMBER_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
const PORT_KINDS: PortKind[] = ["ore", "lumber", "brick", "grain", "wool", "any", "any", "any", "any"];

export interface GeneratedOpening {
  readonly seed: string;
  readonly board: Board;
  readonly topology: BoardTopology;
  readonly observed: ObservedGameState;
  readonly highNumbersTouch: boolean;
}

function axialHexes(): Array<[number, number]> {
  const coordinates: Array<[number, number]> = [];
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      if (Math.max(Math.abs(x), Math.abs(y), Math.abs(x + y)) <= 2) coordinates.push([x, y]);
    }
  }
  return coordinates;
}

function neighborsOf(hexes: readonly HexTile[], index: number): number[] {
  const here = hexes[index];
  const byCoord = new Map(hexes.map((hex, hexIndex) => [`${hex.x},${hex.y}`, hexIndex]));
  const found: number[] = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]] as const) {
    const next = byCoord.get(`${here.x + dx},${here.y + dy}`);
    if (next !== undefined) found.push(next);
  }
  return found;
}

function highNumbersTouch(hexes: readonly HexTile[]): boolean {
  return hexes.some((hex, index) => {
    if (hex.number !== 6 && hex.number !== 8) return false;
    return neighborsOf(hexes, index).some((next) => {
      const number = hexes[next].number;
      return number === 6 || number === 8;
    });
  });
}

function separateHighNumbers(hexes: HexTile[]): boolean {
  for (let attempt = 0; attempt < 48; attempt++) {
    if (!highNumbersTouch(hexes)) return false;
    const hot = hexes.findIndex((hex, index) => (hex.number === 6 || hex.number === 8) && neighborsOf(hexes, index).some((next) => {
      const number = hexes[next].number;
      return number === 6 || number === 8;
    }));
    const cool = hexes.findIndex((hex) => hex.number !== null && hex.number !== 6 && hex.number !== 8);
    if (hot < 0 || cool < 0) break;
    const swapped = hexes[hot].number;
    hexes[hot].number = hexes[cool].number;
    hexes[cool].number = swapped;
  }
  return highNumbersTouch(hexes);
}

function bareBoard(seed: string): { board: Board; highNumbersTouch: boolean } {
  const rng = createSeededRng(`${seed}:board`);
  const resources = rng.shuffle(RESOURCE_BAG);
  const numbers = rng.shuffle(NUMBER_TOKENS);
  let numberCursor = 0;
  const hexes: HexTile[] = axialHexes().map(([x, y], index) => {
    const resource = resources[index] ?? null;
    const number = resource === null ? null : numbers[numberCursor++] ?? null;
    return { id: `h${index}`, x, y, resource, number };
  });
  const touching = separateHighNumbers(hexes);
  return {
    board: { hexes, ports: [], robberStart: hexes.find((hex) => hex.resource === null)?.id ?? hexes[0].id },
    highNumbersTouch: touching
  };
}

function withPorts(board: Board, seed: string): Board {
  const topology = buildBoardTopology(board);
  const coastal = topology.edges.filter((edge) => edge.hexIndices.length === 1);
  const rng = createSeededRng(`${seed}:ports`);
  const order = rng.shuffle(coastal.map((edge) => edge.index));
  const usedCorners = new Set<number>();
  const chosen: Array<{ at: string; kind: PortKind }> = [];
  for (const edgeIndex of order) {
    if (chosen.length >= PORT_KINDS.length) break;
    const edge = topology.edges[edgeIndex];
    if (!edge || usedCorners.has(edge.c1) || usedCorners.has(edge.c2)) continue;
    usedCorners.add(edge.c1);
    usedCorners.add(edge.c2);
    chosen.push({ at: edge.at, kind: PORT_KINDS[chosen.length] });
  }
  for (const edgeIndex of order) {
    if (chosen.length >= PORT_KINDS.length) break;
    const edge = topology.edges[edgeIndex];
    if (!edge || chosen.some((port) => port.at === edge.at)) continue;
    chosen.push({ at: edge.at, kind: PORT_KINDS[chosen.length] });
  }
  return { ...board, ports: chosen };
}

/** A validated standard 19-hex opening position. The same seed returns the same board. */
export function buildGeneratedOpening(seed: string): GeneratedOpening {
  const bare = bareBoard(seed);
  const board = withPorts(bare.board, seed);
  const topology = buildBoardTopology(board);
  if (!topology.variant.isStandard19Hex || topology.colonistIdsSource === "none") {
    throw new Error("Generated board is not a validated standard 19-hex topology.");
  }
  const observed = buildObservedGameState({
    board,
    placements: { settlements: new Map(), cities: new Map(), roads: new Map() },
    players: [{ id: "c1" }, { id: "c2" }],
    selfId: "c1",
    selfHand: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
    selfHandKnown: true,
    warnings: []
  });
  return { seed, board, topology, observed, highNumbersTouch: bare.highNumbersTouch };
}
