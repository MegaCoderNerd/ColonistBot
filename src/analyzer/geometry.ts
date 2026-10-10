// Recovered from content.js (lines 862-980)
import { cornerHexKeys, pips } from "./replay";
import type { Board, PortEdge, PortKind, Resource } from "./types";
import type { MapView } from "../shared/schema";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface Point {
  x: number;
  y: number;
}

export interface CornerInfo {
  at: string;
  point: Point;
  pips: number;
  resources: Resource[];
  numbers: number[];
  hexIds: string[];
  port?: PortKind;
}

const SQRT3 = Math.sqrt(3);

export function hexCenter(x: number, y: number, size = 1): Point {
  return { x: size * SQRT3 * (x + y / 2), y: size * 1.5 * y };
}

export function cornerPoint(at: string, size = 1): Point | undefined {
  const [x, y, z] = at.split(",").map(Number);
  if ([x, y, z].some(Number.isNaN)) return undefined;
  const c = hexCenter(x, y, size);
  return { x: c.x, y: c.y + (z === 0 ? -size : size) };
}

const EDGE_NEIGHBOUR: Array<[number, number]> = [
  [0, -1],
  [-1, 0],
  [-1, 1]
];

export function edgePoints(at: string, size = 1): [Point, Point] | undefined {
  const [x, y, z] = at.split(",").map(Number);
  if ([x, y, z].some(Number.isNaN)) return undefined;
  const c = hexCenter(x, y, size);
  const top = { x: c.x, y: c.y - size };
  const upperLeft = { x: c.x - (SQRT3 / 2) * size, y: c.y - size / 2 };
  const lowerLeft = { x: c.x - (SQRT3 / 2) * size, y: c.y + size / 2 };
  const bottom = { x: c.x, y: c.y + size };
  if (z === 0) return [top, upperLeft];
  if (z === 1) return [upperLeft, lowerLeft];
  if (z === 2) return [lowerLeft, bottom];
  return undefined;
}

export const DEFAULT_VIEW: MapView = { rot: 0, flip: false };

export function normalizeView(v: unknown): MapView {
  const o = (v ?? {}) as Partial<MapView>;
  const rot = Number.isInteger(o.rot) ? (((o.rot as number) % 12) + 12) % 12 : 0;
  return { rot, flip: o.flip === true };
}

export function mirrorView(v: MapView, vertical = false): MapView {
  return { flip: !v.flip, rot: ((((vertical ? 6 : 0) - v.rot) % 12) + 12) % 12 };
}

export function turnView(v: MapView, steps: number): MapView {
  return { ...v, rot: (((v.rot + steps) % 12) + 12) % 12 };
}

export function viewPoint(p: Point, view: MapView = DEFAULT_VIEW): Point {
  const x = view.flip ? -p.x : p.x;
  const a = (view.rot * Math.PI) / 6;
  return { x: x * Math.cos(a) - p.y * Math.sin(a), y: x * Math.sin(a) + p.y * Math.cos(a) };
}

const PORT_RESOURCES: Resource[] = ["lumber", "brick", "wool", "grain", "ore"];

export function portKind(type: number): PortKind | undefined {
  if (type === 1) return "any";
  return PORT_RESOURCES[type - 2];
}

export function portAnchor(board: Board, port: PortEdge, size = 1): { edge: [Point, Point]; mid: Point; out: Point } | undefined {
  const edge = edgePoints(port.at, size);
  if (!edge) return undefined;
  const [x, y, z] = port.at.split(",").map(Number);
  const [dx, dy] = EDGE_NEIGHBOUR[z] ?? [0, 0];
  const land = new Set(board.hexes.map((h) => `${h.x},${h.y}`));
  const here = land.has(`${x},${y}`);
  const there = land.has(`${x + dx},${y + dy}`);
  if (here === there) return undefined;
  const mid = { x: (edge[0].x + edge[1].x) / 2, y: (edge[0].y + edge[1].y) / 2 };
  const landHex = here ? { x, y } : { x: x + dx, y: y + dy };
  const lc = hexCenter(landHex.x, landHex.y, size);
  const len = Math.hypot(mid.x - lc.x, mid.y - lc.y) || 1;
  return { edge, mid, out: { x: (mid.x - lc.x) / len, y: (mid.y - lc.y) / len } };
}

export function hexCornerIds(x: number, y: number): string[] {
  return [`${x},${y},0`, `${x + 1},${y - 1},1`, `${x},${y + 1},0`, `${x},${y},1`, `${x - 1},${y + 1},0`, `${x},${y - 1},1`];
}

export function pointKey(p: Point): string {
  return `${Math.round(p.x * 1e3)},${Math.round(p.y * 1e3)}`;
}

export function boardCorners(board: Board, size = 1): CornerInfo[] {
  const portAt: Array<{ p: Point; kind: PortKind }> = [];
  for (const port of board.ports ?? []) {
    const edge = edgePoints(port.at, size);
    if (edge) for (const p of edge) portAt.push({ p, kind: port.kind });
  }
  const byCoord = new Map(board.hexes.map((h) => [`${h.x},${h.y}`, h]));
  const seen = new Map<string, CornerInfo>();
  for (const hex of board.hexes) {
    for (const at of hexCornerIds(hex.x, hex.y)) {
      if (seen.has(at)) continue;
      const [x, y, z] = at.split(",").map(Number);
      const touching = cornerHexKeys(x, y, z).flatMap((k) => byCoord.get(k) ?? []);
      const point = cornerPoint(at, size);
      if (!point) continue;
      seen.set(at, {
        at,
        point,
        pips: touching.reduce((s, h) => s + pips(h.number), 0),
        resources: touching.flatMap((h) => (h.resource ? [h.resource] : [])),
        numbers: touching.flatMap((h) => (h.number ? [h.number] : [])),
        hexIds: touching.map((h) => h.id),
        port: portAt.find((q) => Math.hypot(q.p.x - point.x, q.p.y - point.y) < size * 0.05)?.kind
      });
    }
  }
  return [...seen.values()];
}

export function boardBounds(board: Board, size = 1, pad = 1.2, view: MapView = DEFAULT_VIEW): { minX: number; minY: number; width: number; height: number } {
  const pts = board.hexes.flatMap((h) => {
    const c = hexCenter(h.x, h.y, size);
    return hexVertices(c, size).map((v) => viewPoint(v, view));
  });
  const margin = (pad - 1) * size;
  const minX = Math.min(...pts.map((p) => p.x)) - margin;
  const maxX = Math.max(...pts.map((p) => p.x)) + margin;
  const minY = Math.min(...pts.map((p) => p.y)) - margin;
  const maxY = Math.max(...pts.map((p) => p.y)) + margin;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

export function hexVertices(c: Point, size = 1): Point[] {
  return [0, 1, 2, 3, 4, 5].map((k) => {
    const a = (Math.PI / 180) * (60 * k - 90);
    return { x: c.x + size * Math.cos(a), y: c.y + size * Math.sin(a) };
  });
}
