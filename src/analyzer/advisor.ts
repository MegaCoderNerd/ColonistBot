// Recovered from content.js (lines 2087-2260)
import { boardBounds, boardCorners, cornerPoint, DEFAULT_VIEW, edgePoints, hexCenter, hexVertices, portAnchor, viewPoint } from "./geometry";
import { contextFor, hexDependence } from "./strategy";
import { COSTS, type PlayerHandView } from "./tracker";
import { RESOURCES, type Board, type GameEvent, type Placements, type Resource } from "./types";
import type { MapView } from "../shared/schema";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface RobberTarget {
  hexId: string;
  number: number;
  resource: Resource | null;
  blocksOpponent: number;
  blocksSelf: number;
  targets: string[];
  note?: string;
  score: number;
}

export interface MapMark {
  at: string;
  label: string;
  kind: "follow" | "his" | "road";
  later?: boolean;
}

export function placementsFrom(events: GameEvent[]): Placements {
  const out: Placements = { settlements: new Map(), cities: new Map(), roads: new Map() };
  for (const e of events) {
    if (e.type !== "build" || !e.at) continue;
    if (e.piece === "settlement") out.settlements.set(e.at, e.player);
    else if (e.piece === "city") {
      out.settlements.delete(e.at);
      out.cities.set(e.at, e.player);
    } else out.roads.set(e.at, e.player);
  }
  return out;
}

const RES_LABEL: Record<Resource, string> = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };

export function occupied(p: Placements): Map<string, string> {
  return new Map([...p.settlements, ...p.cities]);
}

export function publicVp(placements: Placements, player: string): number {
  let vp = 0;
  for (const o of placements.settlements.values()) if (o === player) vp += 1;
  for (const o of placements.cities.values()) if (o === player) vp += 2;
  return vp;
}

export function robberTargets(
  board: Board,
  placements: Placements,
  me: string,
  currentHex: string | undefined,
  friendlyBelow = 3,
  limit = 2,
  needs: Resource[] = []
): RobberTarget[] {
  const corners = boardCorners(board);
  const ctx = contextFor(board);
  const dependence = hexDependence(ctx, placements, (o) => o !== me);
  const vpOf = new Map<string, number>();
  const vp = (p: string) => {
    if (!vpOf.has(p)) vpOf.set(p, publicVp(placements, p));
    return vpOf.get(p)!;
  };
  const pip = (n: number | null) => (n === null ? 0 : 6 - Math.abs(7 - n));
  const out: RobberTarget[] = [];
  for (const hex of board.hexes) {
    if (hex.id === currentHex || !hex.number) continue;
    const here = corners.filter((c) => c.hexIds.includes(hex.id));
    let legal = true;
    let blocksOpponent = 0;
    let blocksSelf = 0;
    const targets = new Set<string>();
    for (const c of here) {
      const owner = placements.settlements.get(c.at) ?? placements.cities.get(c.at);
      if (!owner) continue;
      const weight = placements.cities.has(c.at) ? 2 : 1;
      if (owner === me) blocksSelf += weight;
      else {
        if (vp(owner) < friendlyBelow) legal = false;
        blocksOpponent += weight;
        targets.add(owner);
      }
    }
    if (!legal || blocksOpponent === 0) continue;
    const r = hex.resource;
    const weight = r ? ctx.resWeight[r] : 1;
    const share = dependence.get(hex.id)?.share ?? 0;
    const needed = r !== null && needs.includes(r);
    const hisPorts = new Set<Resource>();
    for (const [at, owner] of [...placements.settlements, ...placements.cities]) {
      if (owner === me) continue;
      const port = ctx.byAt.get(at)?.port;
      if (port && port !== "any") hisPorts.add(port);
    }
    const soleWheat = r === "grain" && share >= 0.9;
    const soleOre = r === "ore" && share >= 0.9;
    const portFeed = Boolean(r && hisPorts.has(r) && share >= 0.5);
    let score = pip(hex.number) * weight * (blocksOpponent * (1 + share) + (needed ? 0.6 * blocksOpponent : 0)) - blocksSelf * pip(hex.number) * weight;
    if (soleWheat) score += 14;
    else if (soleOre) score += 9;
    else if (portFeed) score += 6;
    const notes: string[] = [];
    if (r && share >= 0.99) notes.push(`his only ${RES_LABEL[r]} source`);
    else if (r && share >= 0.5) notes.push(`most of his ${RES_LABEL[r]}`);
    if (soleWheat) notes.push("block the wheat");
    else if (soleOre) notes.push("block the ore");
    else if (portFeed && r) notes.push(`feeds his 2:1 ${RES_LABEL[r]}`);
    if (needed && r) notes.push(`he needs ${RES_LABEL[r]}`);
    if (r && weight >= 1.15) notes.push(`${RES_LABEL[r]} is scarce`);
    if (blocksSelf) notes.push(`also blocks ${blocksSelf === 1 ? "one of yours" : "two of yours"}`);
    out.push({ hexId: hex.id, number: hex.number, resource: r, blocksOpponent, blocksSelf, targets: [...targets], note: notes.join(", ") || undefined, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function buildHints(view: PlayerHandView): string[] {
  const lines: string[] = [];
  for (const key of ["city", "settlement", "dev", "road"] as const) {
    const cost = COSTS[key];
    const missing = RESOURCES.flatMap((r) => {
      const need = (cost[r] ?? 0) - view.hand[r];
      return need > 0 ? [`${need} ${RES_LABEL[r]}`] : [];
    });
    const label = { city: "City", settlement: "Settlement", dev: "Dev card", road: "Road" }[key];
    if (!missing.length) lines.push(`${label}: you can pay now`);
    else if (missing.length <= 2) lines.push(`${label}: need ${missing.join(" + ")}`);
  }
  return lines.slice(0, 3);
}

const FILL: Record<Resource | "desert", string> = { lumber: "#3f7d3a", brick: "#c0583a", wool: "#a6d06a", grain: "#e8c545", ore: "#8a96a3", desert: "#dccf9f" };
const LETTER: Record<Resource, string> = { lumber: "W", brick: "B", wool: "S", grain: "G", ore: "O" };
const MINE = "#2563eb";
const THEIRS = "#e11d48";

export function miniMapSvg(
  board: Board,
  placements: Placements,
  candidates: Array<{ at: string }>,
  me: string,
  view: MapView = DEFAULT_VIEW,
  robberHex?: string,
  marks: MapMark[] = []
): string {
  const size = 16;
  const b = boardBounds(board, size, 2.7, view);
  const f = (n: number) => n.toFixed(1);
  const T = (p: { x: number; y: number }) => viewPoint(p, view);
  const pt = (p: { x: number; y: number }) => `${f(T(p).x)},${f(T(p).y)}`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(b.minX)} ${f(b.minY)} ${f(b.width)} ${f(b.height)}" style="display:block;width:100%;height:auto;max-height:230px" font-family="system-ui,sans-serif" role="img" aria-label="Board map">`
  ];
  for (const h of board.hexes) {
    const c = hexCenter(h.x, h.y, size);
    const poly = hexVertices(c, size).map(pt).join(" ");
    parts.push(`<polygon points="${poly}" fill="${FILL[h.resource ?? "desert"]}" stroke="#1b2128" stroke-width="1"/>`);
    const tc = T(c);
    if (h.resource) parts.push(`<text x="${f(tc.x)}" y="${f(tc.y - 6.5)}" text-anchor="middle" font-size="6" font-weight="700" fill="#10151a" opacity=".75">${LETTER[h.resource]}</text>`);
    if (h.number) {
      const hot = h.number === 6 || h.number === 8;
      parts.push(
        `<circle cx="${f(tc.x)}" cy="${f(tc.y + 2)}" r="6.4" fill="#f6efd8" stroke="#10151a" stroke-width=".5"/><text x="${f(tc.x)}" y="${f(tc.y + 5)}" text-anchor="middle" font-size="${h.number > 9 ? 8 : 9}" font-weight="700" fill="${hot ? "#c2102f" : "#10151a"}">${h.number}</text>`
      );
    }
  }
  const robber = board.hexes.find((h) => h.id === robberHex);
  if (robber) {
    const rc = T(hexCenter(robber.x, robber.y, size));
    parts.push(`<ellipse cx="${f(rc.x)}" cy="${f(rc.y + 11)}" rx="3.6" ry="2" fill="#10151a" opacity=".85"/><circle cx="${f(rc.x)}" cy="${f(rc.y + 8)}" r="3.4" fill="#10151a" stroke="#fff" stroke-width=".8"/>`);
  }
  for (const port of board.ports ?? []) {
    const a = portAnchor(board, port, size);
    if (!a) continue;
    const m = T(a.mid);
    const o = T({ x: a.mid.x + a.out.x * size * 0.8, y: a.mid.y + a.out.y * size * 0.8 });
    const text = port.kind === "any" ? "3:1" : `2:1 ${LETTER[port.kind]}`;
    parts.push(
      `<line x1="${f(m.x)}" y1="${f(m.y)}" x2="${f(o.x)}" y2="${f(o.y)}" stroke="#7aa7d6" stroke-width="1.4"/><text x="${f(o.x)}" y="${f(o.y + 2)}" text-anchor="middle" font-size="6" font-weight="700" fill="#7aa7d6">${text}</text>`
    );
  }
  for (const [at, owner] of placements.roads) {
    const pts = edgePoints(at, size);
    if (pts)
      parts.push(
        `<line x1="${f(T(pts[0]).x)}" y1="${f(T(pts[0]).y)}" x2="${f(T(pts[1]).x)}" y2="${f(T(pts[1]).y)}" stroke="#fff" stroke-width="5" stroke-linecap="round"/><line x1="${f(T(pts[0]).x)}" y1="${f(T(pts[0]).y)}" x2="${f(T(pts[1]).x)}" y2="${f(T(pts[1]).y)}" stroke="${owner === me ? MINE : THEIRS}" stroke-width="3" stroke-linecap="round"/>`
      );
  }
  for (const [at, owner] of occupied(placements)) {
    const p = cornerPoint(at, size);
    if (!p) continue;
    const q = T(p);
    const city = placements.cities.has(at);
    const color = owner === me ? MINE : THEIRS;
    parts.push(
      city
        ? `<rect x="${f(q.x - 4.5)}" y="${f(q.y - 4.5)}" width="9" height="9" rx="1.5" fill="${color}" stroke="#fff" stroke-width="1.2"/>`
        : `<circle cx="${f(q.x)}" cy="${f(q.y)}" r="4" fill="${color}" stroke="#fff" stroke-width="1.2"/>`
    );
  }
  candidates.forEach((c, i) => {
    const p = cornerPoint(c.at, size);
    if (!p) return;
    const q = T(p);
    parts.push(
      `<circle cx="${f(q.x)}" cy="${f(q.y)}" r="5.5" fill="#ffd54a" stroke="#10151a" stroke-width="1"/><text x="${f(q.x)}" y="${f(q.y + 2.6)}" text-anchor="middle" font-size="7.5" font-weight="800" fill="#10151a">${i + 1}</text>`
    );
  });
  for (const m of marks) {
    if (m.kind === "road") {
      const pts = edgePoints(m.at, size);
      if (!pts) continue;
      const a = T(pts[0]);
      const b2 = T(pts[1]);
      const mid = T({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
      const later = m.later === true;
      const dash = later ? ' stroke-dasharray="4 2.5"' : "";
      parts.push(`<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b2.x)}" y2="${f(b2.y)}" stroke="#ffd54a" stroke-width="${later ? "3.5" : "6"}" stroke-linecap="round"${dash}/>`);
      if (m.label) parts.push(`<text x="${f(mid.x)}" y="${f(mid.y - 3)}" text-anchor="middle" font-size="7" font-weight="800" fill="#ffd54a">${m.label}</text>`);
      continue;
    }
    const p = cornerPoint(m.at, size);
    if (!p) continue;
    const q = T(p);
    const color = m.kind === "his" ? THEIRS : "#ffd54a";
    parts.push(
      `<circle cx="${f(q.x)}" cy="${f(q.y)}" r="5.5" fill="none" stroke="${color}" stroke-width="1.6" stroke-dasharray="2 1.4"/><text x="${f(q.x)}" y="${f(q.y + 2.4)}" text-anchor="middle" font-size="7" font-weight="800" fill="${color}">${m.label}</text>`
    );
  }
  parts.push("</svg>");
  return parts.join("");
}
