// Recovered from content.js (lines 5361-5480)
import type { DecodedFrame } from "../decode";
import type { Board, GameEvent, HexTile, PlayerInfo, Resource } from "../types";
import { isObject, num, type AdapterParseResult, type FrameAdapter } from "./types";

const TYPED = { log: 7, playerState: 12, board: 14, edge: 15, corner: 16, robber: 17 } as const;
const NUMERIC_RESOURCE: Record<number, Resource | null> = { 0: null, 1: "lumber", 2: "brick", 3: "wool", 4: "grain", 5: "ore" };
const NAMED_RESOURCE: Array<[RegExp, Resource]> = [
  [/lumber|wood|forest/i, "lumber"],
  [/brick|hill/i, "brick"],
  [/wool|sheep|pasture/i, "wool"],
  [/grain|wheat|field/i, "grain"],
  [/\bore\b|mountain/i, "ore"]
];

function resourceOf(v: unknown): Resource | null {
  const n = num(v);
  if (n !== undefined && typeof v !== "string") return NUMERIC_RESOURCE[n] ?? null;
  if (typeof v === "string") return NAMED_RESOURCE.find(([re]) => re.test(v))?.[1] ?? NUMERIC_RESOURCE[num(v) ?? -1] ?? null;
  return null;
}

function envelopes(value: unknown, depth = 0): Array<{ type: number; body: Record<string, unknown> }> {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.flatMap((v) => envelopes(v, depth + 1));
  if (!isObject(value)) return [];
  const out: Array<{ type: number; body: Record<string, unknown> }> = [];
  const type = num(value.type);
  if (type !== undefined && (Object.values(TYPED) as number[]).includes(type)) {
    const inner = [value.payload, value.data, value.body, value.event].find(isObject);
    out.push({ type, body: inner ?? value });
  }
  for (const key of ["data", "payload", "events", "messages"]) {
    const child = value[key];
    if (isObject(child) || Array.isArray(child)) out.push(...envelopes(child, depth + 1));
  }
  return out;
}

function coords(raw: Record<string, unknown>): string | undefined {
  const c = [raw.hexCorner, raw.hexEdge, raw.coordinates, raw.position, raw].find(isObject);
  const nested = [c, raw].find((o) => o && num(o.x) !== undefined && num(o.y) !== undefined && num(o.z) !== undefined);
  return nested ? `${num(nested.x)},${num(nested.y)},${num(nested.z)}` : undefined;
}

const ownerOf = (raw: Record<string, unknown>): string | undefined => {
  const o = [raw.owner, raw.playerColor, raw.color, raw.player].map(num).find((n) => n !== undefined);
  return o === undefined ? undefined : `c${o}`;
};

function list(body: Record<string, unknown>, keys: string[]): Array<Record<string, unknown>> {
  for (const key of keys) {
    const v = body[key];
    if (Array.isArray(v)) return v.filter(isObject);
    if (isObject(v)) return Object.values(v).filter(isObject);
  }
  return [];
}

function readBoard(body: Record<string, unknown>): Board | undefined {
  const tiles = list(body, ["tiles", "hexes", "hexStates", "tileHexStates", "faces", "map"]);
  const hexes: HexTile[] = [];
  tiles.forEach((raw, i) => {
    const x = num(raw.x);
    const y = num(raw.y);
    if (x === undefined || y === undefined) return;
    const resource = resourceOf(raw.type ?? raw.resource ?? raw.tileType);
    hexes.push({ id: String(num(raw.id) ?? i), x, y, resource, number: resource ? num(raw.diceNumber ?? raw.number ?? raw.rollNumber) ?? null : null });
  });
  if (!hexes.length) return undefined;
  return { hexes, robberStart: hexes.find((h) => h.resource === null)?.id };
}

export const typedEventsAdapter: FrameAdapter = {
  name: "typed-events",
  parse(frames: DecodedFrame[]): AdapterParseResult {
    const players = new Map<string, PlayerInfo>();
    const events: GameEvent[] = [];
    const corners = new Map<string, number>();
    const edges = new Set<string>();
    const vp = new Map<string, number>();
    let board: Board | undefined;
    let rolls = 0;
    let lastRobber: string | undefined;

    for (const f of frames) {
      if (f.frame.dir !== "in" || f.value === undefined) continue;
      for (const { type, body } of envelopes(f.value)) {
        const t = f.frame.t;
        if (type === TYPED.board) board = readBoard(body) ?? board;
        else if (type === TYPED.playerState) {
          for (const raw of [body, ...list(body, ["players", "playerStates"])]) {
            const id = ownerOf(raw);
            if (!id) continue;
            const name = [raw.username, raw.displayName, raw.name].find((n): n is string => typeof n === "string" && n.length > 0);
            const prev = players.get(id);
            players.set(id, { id, color: num(String(id).slice(1)), name: name ?? prev?.name ?? `Player ${String(id).slice(1)}` });
            const points = num(raw.victoryPoints ?? raw.vp ?? raw.points);
            if (points !== undefined && vp.get(id) !== points) {
              vp.set(id, points);
              events.push({ type: "vp", player: id, vp: points, t, turn: rolls });
            }
          }
        } else if (type === TYPED.corner) {
          for (const raw of [body, ...list(body, ["corners", "buildings"])]) {
            const at = coords(raw);
            const owner = ownerOf(raw);
            const kind = num(raw.buildingType ?? raw.type ?? raw.piece) ?? 1;
            if (!at || !owner || corners.get(at) === kind) continue;
            corners.set(at, kind);
            events.push({ type: "build", player: owner, piece: kind >= 2 ? "city" : "settlement", at, setup: rolls === 0, t, turn: rolls });
          }
        } else if (type === TYPED.edge) {
          for (const raw of [body, ...list(body, ["edges", "roads"])]) {
            const at = coords(raw);
            const owner = ownerOf(raw);
            if (!at || !owner || edges.has(at)) continue;
            edges.add(at);
            events.push({ type: "build", player: owner, piece: "road", at, setup: rolls === 0, t, turn: rolls });
          }
        } else if (type === TYPED.robber) {
          const where = num(body.tileIndex ?? body.locationTileIndex ?? body.hexId ?? body.id ?? body.index);
          if (where !== undefined && String(where) !== lastRobber) {
            if (lastRobber !== undefined) events.push({ type: "robberMove", player: ownerOf(body) ?? "unknown", hex: String(where), t, turn: rolls });
            lastRobber = String(where);
          }
        }
      }
    }
    return { players: [...players.values()], events, board, warnings: [] };
  }
};
