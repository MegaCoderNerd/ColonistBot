/**
 * Geometric isomorphism between a Colonist board and AlphaBot's canonical
 * 19-hex topology (catan-rl `catan-core/src/board.rs`, revision 021279c).
 *
 * AlphaBot vertex ids are the first-encounter order of its own pointy-top
 * construction. Colonist corner ids are discovery order. This file does not
 * assume those sequences match. It rebuilds AlphaBot's coordinates, then
 * tries the 12 orientation-preserving and reflected alignments of the hex
 * grid. A result is returned only when one alignment fits. Canonical port
 * edges, which are fixed in AlphaBot's topology, are the only labels used
 * to choose among alignments. Resource types and number tokens are ignored.
 */

import { hexCenter, viewPoint, type Point } from "../geometry";
import type { BoardTopology } from "./topology";

const SQRT3 = Math.sqrt(3);
/** AlphaBot comment: x is in half-widths, y is in units of R/2, with R = 1. */
const ALPHA_X = SQRT3 / 2;
const ALPHA_Y = 0.5;
const SNAP = 1e-4;

const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -2],
  [1, -1],
  [1, 1],
  [0, 2],
  [-1, 1],
  [-1, -1]
];
const TILE_ROWS = [3, 4, 5, 4, 3] as const;

/** Literal port endpoints from `Topology::build` in catan-core. */
const PORT_ENDPOINTS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [7, 10],
  [12, 22],
  [35, 36],
  [45, 46],
  [50, 53],
  [47, 48],
  [39, 40],
  [27, 28]
];

export interface BoardView {
  readonly rot: 0 | 2 | 4 | 6 | 8 | 10;
  readonly flip: boolean;
}

export interface AlphabotTopology {
  readonly tiles: readonly { readonly id: number; readonly point: Point; readonly vertices: readonly number[] }[];
  readonly vertices: readonly { readonly id: number; readonly point: Point; readonly edges: readonly number[] }[];
  readonly edges: readonly { readonly id: number; readonly v1: number; readonly v2: number; readonly tiles: readonly number[] }[];
  readonly ports: readonly { readonly id: number; readonly edge: number; readonly v1: number; readonly v2: number }[];
}

export interface TopologyCandidate {
  readonly view: BoardView;
  readonly hexToAlphabot: readonly number[];
  readonly alphabotToHex: readonly number[];
  readonly cornerToVertex: readonly number[];
  readonly vertexToCorner: readonly number[];
  readonly edgeToAlphabot: readonly number[];
  readonly alphabotToEdge: readonly number[];
  readonly ports: readonly { readonly colonistPort: number; readonly alphabotPort: number }[];
}

export type TopologyMappingResult =
  | { readonly ok: true; readonly mapping: TopologyCandidate }
  | { readonly ok: false; readonly reason: "invalid"; readonly detail: string }
  | { readonly ok: false; readonly reason: "ambiguous"; readonly detail: string; readonly candidates: readonly TopologyCandidate[] };

const VIEWS: readonly BoardView[] = [false, true].flatMap((flip) =>
  ([0, 2, 4, 6, 8, 10] as const).map((rot) => ({ rot, flip }))
);

function keyOf(ix: number, iy: number): string {
  return `${ix},${iy}`;
}

function screenOfAlpha(ix: number, iy: number): Point {
  return { x: ix * ALPHA_X, y: iy * ALPHA_Y };
}

function snapAlpha(point: Point): { ix: number; iy: number } | null {
  const ix = Math.round(point.x / ALPHA_X);
  const iy = Math.round(point.y / ALPHA_Y);
  const back = screenOfAlpha(ix, iy);
  if (Math.hypot(back.x - point.x, back.y - point.y) > SNAP) return null;
  return { ix, iy };
}

function inverse(forward: readonly number[], size: number): number[] | null {
  const back = Array.from({ length: size }, () => -1);
  for (let from = 0; from < forward.length; from++) {
    const to = forward[from];
    if (to < 0 || to >= size || back[to] !== -1) return null;
    back[to] = from;
  }
  return back.every((value) => value >= 0) ? back : null;
}

function sameSet(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return right.every((value) => seen.has(value));
}

function cycleAgrees(actual: readonly number[], expected: readonly number[], reversed: boolean): boolean {
  if (actual.length !== expected.length || actual.length === 0) return false;
  const ring = reversed ? [...expected].reverse() : [...expected];
  for (let start = 0; start < ring.length; start++) {
    if (ring.every((value, index) => value === actual[(start + index) % ring.length])) return true;
  }
  return false;
}

/** Rebuild AlphaBot's topology from the coordinate rules in its source. */
export function buildAlphabotTopology(): AlphabotTopology {
  const vertexAt = new Map<string, number>();
  const vertices: Array<{ id: number; ix: number; iy: number; point: Point; edges: number[] }> = [];
  const tiles: Array<{ id: number; point: Point; vertices: number[] }> = [];
  for (let row = 0; row < TILE_ROWS.length; row++) {
    const count = TILE_ROWS[row];
    const iy = 3 * (row - 2);
    const xStart = -(count - 1);
    for (let col = 0; col < count; col++) {
      const cx = xStart + 2 * col;
      const around: number[] = [];
      for (const [dx, dy] of CORNER_OFFSETS) {
        const ix = cx + dx;
        const iyCorner = iy + dy;
        const key = keyOf(ix, iyCorner);
        let id = vertexAt.get(key);
        if (id === undefined) {
          id = vertices.length;
          vertexAt.set(key, id);
          vertices.push({ id, ix, iy: iyCorner, point: screenOfAlpha(ix, iyCorner), edges: [] });
        }
        around.push(id);
      }
      tiles.push({ id: tiles.length, point: screenOfAlpha(cx, iy), vertices: around });
    }
  }

  const edgePairs: Array<[number, number]> = [];
  const seenEdges = new Set<string>();
  for (const tile of tiles) {
    for (let i = 0; i < tile.vertices.length; i++) {
      const a = tile.vertices[i];
      const b = tile.vertices[(i + 1) % tile.vertices.length];
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${lo},${hi}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edgePairs.push([lo, hi]);
    }
  }
  edgePairs.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const edgeByPair = new Map<string, number>();
  const edges = edgePairs.map(([v1, v2], id) => {
    edgeByPair.set(`${v1},${v2}`, id);
    vertices[v1].edges.push(id);
    vertices[v2].edges.push(id);
    const onTiles = tiles.filter((tile) => tile.vertices.includes(v1) && tile.vertices.includes(v2)).map((tile) => tile.id);
    return { id, v1, v2, tiles: onTiles };
  });

  const ports = PORT_ENDPOINTS.map(([a, b], id) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const edge = edgeByPair.get(`${lo},${hi}`);
    if (edge === undefined) throw new Error(`AlphaBot port ${id} is not an edge of the generated topology.`);
    return { id, edge, v1: a, v2: b };
  });

  return { tiles, vertices, edges, ports };
}

const ALPHABOT = buildAlphabotTopology();

function centroid(points: readonly Point[]): Point {
  const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function align(point: Point, origin: Point, view: BoardView): Point {
  return viewPoint({ x: point.x - origin.x, y: point.y - origin.y }, view);
}

function candidateFor(topology: BoardTopology, view: BoardView, origin: Point): TopologyCandidate | null {
  const alpha = ALPHABOT;
  const tileAt = new Map(alpha.tiles.map((tile) => {
    const snapped = snapAlpha(tile.point);
    return [snapped ? keyOf(snapped.ix, snapped.iy) : "", tile.id] as const;
  }));
  const vertexAt = new Map(alpha.vertices.map((vertex) => {
    const snapped = snapAlpha(vertex.point);
    return [snapped ? keyOf(snapped.ix, snapped.iy) : "", vertex.id] as const;
  }));

  const hexToAlphabot: number[] = [];
  for (const hex of topology.hexes) {
    const snapped = snapAlpha(align(hexCenter(hex.x, hex.y), origin, view));
    const id = snapped ? tileAt.get(keyOf(snapped.ix, snapped.iy)) : undefined;
    if (id === undefined) return null;
    hexToAlphabot.push(id);
  }
  const alphabotToHex = inverse(hexToAlphabot, alpha.tiles.length);
  if (!alphabotToHex) return null;

  const cornerToVertex: number[] = [];
  for (const corner of topology.corners) {
    const snapped = snapAlpha(align(corner.point, origin, view));
    const id = snapped ? vertexAt.get(keyOf(snapped.ix, snapped.iy)) : undefined;
    if (id === undefined) return null;
    cornerToVertex.push(id);
  }
  const vertexToCorner = inverse(cornerToVertex, alpha.vertices.length);
  if (!vertexToCorner) return null;

  const edgeToAlphabot: number[] = [];
  for (const edge of topology.edges) {
    const a = cornerToVertex[edge.c1];
    const b = cornerToVertex[edge.c2];
    const found = alpha.edges.find((candidate) => (candidate.v1 === a && candidate.v2 === b) || (candidate.v1 === b && candidate.v2 === a));
    if (!found) return null;
    const colonistTiles = edge.hexIndices.map((hex) => hexToAlphabot[hex]);
    if (!sameSet(colonistTiles, found.tiles)) return null;
    edgeToAlphabot.push(found.id);
  }
  const alphabotToEdge = inverse(edgeToAlphabot, alpha.edges.length);
  if (!alphabotToEdge) return null;

  for (const corner of topology.corners) {
    const vertex = alpha.vertices[cornerToVertex[corner.index]];
    const mappedEdges = corner.incidentEdgeIndices.map((edge) => edgeToAlphabot[edge]);
    if (!sameSet(mappedEdges, vertex.edges)) return null;
    const mappedNeighbors = corner.adjacentCornerIndices.map((next) => cornerToVertex[next]);
    const alphaNeighbors = vertex.edges.flatMap((edge) => {
      const item = alpha.edges[edge];
      return item.v1 === vertex.id ? [item.v2] : [item.v1];
    });
    if (!sameSet(mappedNeighbors, alphaNeighbors)) return null;
  }

  for (const hex of topology.hexes) {
    const tile = alpha.tiles[hexToAlphabot[hex.index]];
    const mappedCorners = hex.cornerIndices.map((corner) => cornerToVertex[corner]);
    if (!sameSet(mappedCorners, tile.vertices)) return null;
    if (!cycleAgrees(mappedCorners, tile.vertices, view.flip)) return null;
    const mappedEdges = hex.edgeIndices.map((edge) => edgeToAlphabot[edge]);
    const tileEdges = alpha.edges.filter((edge) => edge.tiles.includes(tile.id)).map((edge) => edge.id);
    if (!sameSet(mappedEdges, tileEdges)) return null;
  }

  const ports: Array<{ colonistPort: number; alphabotPort: number }> = [];
  for (const port of topology.ports) {
    if (port.edgeIndex === undefined) continue;
    const edgeId = edgeToAlphabot[port.edgeIndex];
    const alphaPort = alpha.ports.find((candidate) => candidate.edge === edgeId);
    if (!alphaPort) continue;
    const land = topology.edges[port.edgeIndex].hexIndices.map((hex) => hexToAlphabot[hex]);
    if (!sameSet(land, alpha.edges[edgeId].tiles)) return null;
    ports.push({ colonistPort: port.index, alphabotPort: alphaPort.id });
  }

  return { view, hexToAlphabot, alphabotToHex, cornerToVertex, vertexToCorner, edgeToAlphabot, alphabotToEdge, ports };
}

function portsSelectCanonical(candidate: TopologyCandidate): boolean {
  if (candidate.ports.length !== PORT_ENDPOINTS.length) return false;
  const got = new Set(candidate.ports.map((port) => port.alphabotPort));
  return got.size === PORT_ENDPOINTS.length && PORT_ENDPOINTS.every((_, index) => got.has(index));
}

/**
 * Map a Colonist topology onto AlphaBot's canonical board.
 * Returns every geometrically valid alignment when the board does not carry
 * AlphaBot's nine fixed port edges, instead of choosing one.
 */
export function mapColonistTopology(topology: BoardTopology): TopologyMappingResult {
  if (!topology.variant.isStandard19Hex || topology.hexes.length !== 19 || topology.corners.length !== 54 || topology.edges.length !== 72) {
    return { ok: false, reason: "invalid", detail: `Expected 19 hexes, 54 corners and 72 edges, got ${topology.hexes.length}/${topology.corners.length}/${topology.edges.length}.` };
  }
  const origin = centroid(topology.hexes.map((hex) => hexCenter(hex.x, hex.y)));
  const candidates = VIEWS.flatMap((view) => {
    const candidate = candidateFor(topology, view, origin);
    return candidate ? [candidate] : [];
  });
  if (candidates.length === 0) {
    return { ok: false, reason: "invalid", detail: "No rotation or reflection places this board on AlphaBot's 19-hex geometry." };
  }
  if (topology.ports.length === 0) {
    return {
      ok: false,
      reason: "ambiguous",
      detail: `${candidates.length} alignments preserve the hex graph. AlphaBot's fixed port edges are not on this board, so none is selected.`,
      candidates
    };
  }
  const selected = candidates.filter(portsSelectCanonical);
  if (selected.length === 1) return { ok: true, mapping: selected[0] };
  return {
    ok: false,
    reason: "ambiguous",
    detail: selected.length === 0
      ? `${candidates.length} alignments preserve the hex graph. The ${topology.ports.length} ports do not match AlphaBot's nine fixed port edges under exactly one of them.`
      : `${selected.length} alignments match both the hex graph and the canonical port edges.`,
    candidates: selected.length > 0 ? selected : candidates
  };
}

export function alphabotCanonicalTopology(): AlphabotTopology {
  return ALPHABOT;
}
