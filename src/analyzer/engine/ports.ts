// Recovered from content.js (lines 1197-1252)
import { RESOURCES, type PortKind, type Resource, type ResourceHand } from "../types";
import type { BoardContext } from "../strategy";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface NearbyPort {
  at: string;
  kind: PortKind;
  dist: number;
}

export interface PortAccessItem {
  at: string;
  kind: PortKind;
  roads: number;
  value: number;
  contested: boolean;
  text: string;
}

export function portsNear(ctx: BoardContext, at: string, max = 2): NearbyPort[] {
  const out: NearbyPort[] = [];
  const seen = new Set<string>([at]);
  let ring = [at];
  for (let dist = 0; dist <= max; dist++) {
    const next: string[] = [];
    for (const id of ring) {
      const port = ctx.byAt.get(id)?.port;
      if (port) out.push({ at: id, kind: port, dist });
      if (dist === max) continue;
      for (const n of ctx.nbrs.get(id) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    ring = next;
  }
  return out;
}

const LABEL: Record<Resource, string> = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };

function productionOf(kind: PortKind, own: ResourceHand, here: ResourceHand): number {
  if (kind === "any") return RESOURCES.reduce((s, r) => s + own[r] + here[r], 0);
  return own[kind] + here[kind];
}

export function portWorth(kind: PortKind, own: ResourceHand, here: ResourceHand, roads: number, oppRoads?: number): number {
  if (roads > 4) return 0;
  const decay = [1, 0.7, 0.4, 0.2, 0.1][roads] ?? 0;
  const produced = productionOf(kind, own, here);
  const kinds = new Set([...RESOURCES.filter((r) => own[r] > 0), ...RESOURCES.filter((r) => here[r] > 0)]);
  let base = 0;
  if (kind === "any") base = kinds.size >= 3 || own.ore + own.grain + here.ore + here.grain >= 8 ? 1.4 : 0.55;
  else base = produced >= 8 ? 2.4 : produced >= 4 ? 1.5 : produced > 0 ? 0.45 : 0.15;
  let value = base * decay;
  if (oppRoads !== undefined && oppRoads < roads) value *= 0.45;
  return value;
}

export function portAccess(ctx: BoardContext, dist: Map<string, number>, own: ResourceHand, oppDist?: Map<string, number>): PortAccessItem[] {
  const out: PortAccessItem[] = [];
  for (const c of ctx.corners) {
    if (!c.port) continue;
    const roads = dist.get(c.at);
    if (roads === undefined || roads > 4) continue;
    const oppRoads = oppDist?.get(c.at);
    const value = portWorth(c.port, own, { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 }, roads, oppRoads);
    if (value <= 0) continue;
    const contested = oppRoads !== undefined && oppRoads < roads;
    const name = c.port === "any" ? "3:1 port" : `2:1 ${LABEL[c.port]} port`;
    const where = roads === 0 ? "already on it" : `${roads} road${roads === 1 ? "" : "s"} away`;
    const extra = c.port !== "any" && own[c.port] >= 4 ? ", and it matches what you produce" : "";
    const race = contested ? ", but he is closer" : "";
    out.push({ at: c.at, kind: c.port, roads, value, contested, text: `${name}, ${where}${extra}${race}` });
  }
  return out.sort((a, b) => b.value - a.value);
}
