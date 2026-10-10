// Recovered from content.js (lines 1988-2085)
import { pips } from "../replay";
import { contextFor, isLegal, occupiedMap, planOpening, type BoardContext, type OpeningMode, type OpeningPlan } from "../strategy";
import type { Board, Placements, PortKind } from "../types";
import { applyPort, newPlayer, payValue, pipOf, race, type SimPlayer, type SimProd } from "./sim";

export function coachedOpening(board: Board, placements: Placements, me: string, limit = 3, myTurn: boolean | undefined = undefined): OpeningPlan {
  const wide = planOpening(board, placements, me, Math.max(limit, 8), myTurn);
  if (wide.mode === "waiting" || wide.picks.length < 2) return { ...wide, picks: wide.picks.slice(0, limit) };
  const ctx = contextFor(board);
  const rated = wide.picks.slice(0, 8).map((pick) => ({
    pick,
    sim: ratePick(ctx, board, placements, me, pick.at, pick.followUp?.at, wide.oppWants.map((w) => w.at), wide.mode)
  }));
  rated.sort((a, b) => b.pick.score - a.pick.score || b.sim.win - a.sim.win || a.sim.turns - b.sim.turns);
  const picks = rated.slice(0, limit).map((r) => r.pick);
  return { ...wide, picks };
}

const cache = new Map<string, { win: number; turns: number }>();

function ratePick(
  ctx: BoardContext,
  board: Board,
  placements: Placements,
  me: string,
  at: string,
  follow: string | undefined,
  oppWants: string[],
  mode: OpeningMode
): { win: number; turns: number } {
  const built = occupiedMap(placements);
  const mine = [...built].filter(([, o]) => o === me).map(([id]) => id);
  const his = [...built].filter(([, o]) => o !== me).map(([id]) => id);
  const mySpots = [...mine, at];
  if (mySpots.length < 2 && follow && follow !== at) mySpots.push(follow);
  const blocked = new Set([...built.keys(), ...mySpots]);
  const oppSpots = [...his];
  for (const id of oppWants) {
    if (oppSpots.length >= 2) break;
    if (blocked.has(id) || oppSpots.includes(id)) continue;
    if (oppSpots.some((s) => (ctx.nbrs.get(s) ?? []).includes(id)) || mySpots.some((s) => (ctx.nbrs.get(s) ?? []).includes(id) || s === id)) continue;
    oppSpots.push(id);
    blocked.add(id);
  }
  if (oppSpots.length < 2 && mode !== "last") {
    for (const c of ctx.corners) {
      if (oppSpots.length >= 2) break;
      if (!isLegal(ctx, c.at, blocked)) continue;
      oppSpots.push(c.at);
      blocked.add(c.at);
    }
  }
  const key = `${mySpots.join(";")}|${oppSpots.join(";")}|${board.hexes.length}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const mePlayer = fromSpots(ctx, mySpots, blocked, new Set(oppSpots));
  const oppPlayer = fromSpots(ctx, oppSpots, blocked, new Set(mySpots));
  const result = oppSpots.length ? race(mePlayer, oppPlayer, { seed: 11, trials: 6, maxTurns: 42 }) : { a: { win: 1, turns: 40 }, b: { win: 0, turns: 42 } };
  const rate = { win: result.a.win, turns: result.a.turns };
  cache.set(key, rate);
  if (cache.size > 400) cache.clear();
  return rate;
}

function prodsOf(ctx: BoardContext, at: string): SimProd[] {
  const corner = ctx.byAt.get(at);
  if (!corner) return [];
  const out: SimProd[] = [];
  for (const id of corner.hexIds) {
    const hex = ctx.hexById.get(id);
    if (hex?.resource && hex.number) out.push({ resource: hex.resource, number: hex.number, weight: 1 });
  }
  return out;
}

function fromSpots(ctx: BoardContext, spots: string[], taken: Set<string>, enemy: Set<string>): SimPlayer {
  const p = newPlayer({ vp: Math.max(1, spots.length), roads: Math.max(1, spots.length) });
  p.buildings = spots.map((at) => {
    const prods = prodsOf(ctx, at);
    return { prods, pip: pipOf(prods), city: false };
  });
  const second = spots[spots.length - 1];
  for (const prod of prodsOf(ctx, second)) p.hand[prod.resource]++;
  for (const at of spots) applyPort(p, ctx.byAt.get(at)?.port);
  const dist = roadsFrom(ctx, spots, enemy);
  const expansions = [];
  for (const c of ctx.corners) {
    if (!isLegal(ctx, c.at, taken)) continue;
    const roads = dist.get(c.at);
    if (!roads || roads > 4) continue;
    const prods = prodsOf(ctx, c.at);
    expansions.push({ prods, pip: pipOf(prods) + portBias(c.port, prods), roads, port: c.port });
  }
  expansions.sort((a, b) => payValue(b.prods, b.roads, b.port) - payValue(a.prods, a.roads, a.port));
  p.expansions = expansions.slice(0, 3);
  return p;
}

function portBias(port: PortKind | undefined, prods: SimProd[]): number {
  if (!port) return 0;
  if (port === "any") return 3;
  const made = prods.filter((p) => p.resource === port).reduce((s, p) => s + pips(p.number), 0);
  return made >= 3 ? 3 : 1;
}

function roadsFrom(ctx: BoardContext, roots: string[], blocked: Set<string>): Map<string, number> {
  const dist = new Map<string, number>();
  const queue = [...roots];
  for (const r of roots) dist.set(r, 0);
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    const d = dist.get(at) ?? 0;
    for (const n of ctx.nbrs.get(at) ?? []) {
      if (dist.has(n) || blocked.has(n)) continue;
      dist.set(n, d + 1);
      queue.push(n);
    }
  }
  return dist;
}
