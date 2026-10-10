// Recovered from content.js (lines 4959-4967)
import type { DecodedFrame } from "../decode";
import type { GameSnapshot } from "../snapshot";
import type { Board, GameEvent, PlayerInfo } from "../types";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface AdapterParseResult {
  players: PlayerInfo[];
  events: GameEvent[];
  board?: Board;
  warnings: string[];
  selfId?: string;
  selfCards?: number[];
  handSizes?: Record<string, number>;
  turnPlayer?: string;
  snapshot?: GameSnapshot;
}

export interface FrameAdapter {
  name: string;
  parse(frames: DecodedFrame[]): AdapterParseResult;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
