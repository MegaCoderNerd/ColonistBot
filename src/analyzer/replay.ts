// Recovered from content.js (lines 848-860)
import type { Board, HexTile } from "./types";

export function pips(n: number | null): number {
  return n === null || n === 7 ? 0 : 6 - Math.abs(7 - n);
}

export function cornerHexKeys(x: number, y: number, z: number): string[] {
  return z === 0 ? [`${x},${y}`, `${x + 1},${y - 1}`, `${x},${y - 1}`] : [`${x},${y}`, `${x},${y + 1}`, `${x - 1},${y + 1}`];
}

export function hexesAtCorner(board: Board, at: string): HexTile[] {
  const [x, y, z] = at.split(",").map(Number);
  if ([x, y, z].some(Number.isNaN)) return [];
  const byCoord = new Map(board.hexes.map((h) => [`${h.x},${h.y}`, h]));
  return cornerHexKeys(x, y, z).flatMap((k) => byCoord.get(k) ?? []);
}
