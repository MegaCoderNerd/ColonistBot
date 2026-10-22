// Recovered from content.js (lines 1254-1692)
import { boardCorners, edgePoints, pointKey, type CornerInfo } from "./geometry";
import {
  applyHarborToRates,
  assessPortAccess,
  portWorth,
  portsNear,
  ratesFromPlacements,
  resourcesImprovedByHarbor,
  viablePortTargets,
  describePortTarget,
  type PortAccessReport
} from "./engine/ports";
import { pips } from "./replay";
import { RESOURCES, type Board, type HexTile, type Placements, type PortKind, type Resource, type ResourceHand } from "./types";
import type { ShadowEvaluationReport } from "./engine/shadow";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface BoardContext {
  board: Board;
  corners: CornerInfo[];
  byAt: Map<string, CornerInfo>;
  keyToAt: Map<string, string>;
  nbrs: Map<string, string[]>;
  ring2: Map<string, string[]>;
  hexById: Map<string, HexTile>;
  resPips: ResourceHand;
  resWeight: ResourceHand;
}

export type OpeningMode = "first" | "pair" | "second" | "last" | "waiting";

export interface OpeningPick {
  at: string;
  score: number;
  pips: number;
  resources: Resource[];
  numbers: number[];
  port?: PortKind;
  tags?: string[];
  followUp?: { at: string; reason: string };
  reason: string;
}

export interface OpeningPlan {
  mode: OpeningMode;
  picks: OpeningPick[];
  oppWants: Array<{ at: string; reason: string }>;
  note: string;
  shadowEvaluation?: ShadowEvaluationReport;
}

export interface MidgameSpot {
  at: string;
  dist: number;
  score: number;
  reason: string;
}

export interface MidgamePlan {
  expansion: MidgameSpot[];
  oppWants: MidgameSpot[];
  upgrade?: string;
  weaknesses: string[];
}

const LABEL: Record<Resource, string> = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };
const emptyProfile = (): ResourceHand => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
const contexts = new WeakMap<Board, BoardContext>();

export function contextFor(board: Board): BoardContext {
  const cached = contexts.get(board);
  if (cached) return cached;
  const corners = boardCorners(board);
  const byAt = new Map(corners.map((c) => [c.at, c]));
  const keyToAt = new Map(corners.map((c) => [pointKey(c.point), c.at]));
  const nbrs = new Map<string, string[]>();
  for (const a of corners) {
    nbrs.set(
      a.at,
      corners.filter((b) => b !== a && Math.abs(Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) - 1) < 0.05).map((b) => b.at)
    );
  }
  const ring2 = new Map<string, string[]>();
  for (const [at, near] of nbrs) {
    const out = new Set<string>();
    for (const n of near) for (const m of nbrs.get(n) ?? []) if (m !== at && !near.includes(m)) out.add(m);
    ring2.set(at, [...out]);
  }
  const resPips = emptyProfile();
  for (const h of board.hexes) if (h.resource) resPips[h.resource] += pips(h.number);
  const total = RESOURCES.reduce((s, r) => s + resPips[r], 0);
  const avg = total / RESOURCES.length || 1;
  const resWeight = emptyProfile();
  for (const r of RESOURCES) resWeight[r] = resPips[r] === 0 ? 1.4 : Math.min(1.4, Math.max(0.8, avg / resPips[r]));
  const ctx: BoardContext = { board, corners, byAt, keyToAt, nbrs, ring2, hexById: new Map(board.hexes.map((h) => [h.id, h])), resPips, resWeight };
  contexts.set(board, ctx);
  return ctx;
}

export function occupiedMap(p: Placements): Map<string, string> {
  return new Map([...p.settlements, ...p.cities]);
}

export function profileOf(ctx: BoardContext, p: Placements, owner: (o: string) => boolean): ResourceHand {
  const out = emptyProfile();
  for (const [at, o] of p.settlements) if (owner(o)) addCorner(ctx, out, at, 1);
  for (const [at, o] of p.cities) if (owner(o)) addCorner(ctx, out, at, 2);
  return out;
}

export function addCorner(ctx: BoardContext, profile: ResourceHand, at: string, weight = 1) {
  const c = ctx.byAt.get(at);
  if (!c) return;
  for (const id of c.hexIds) {
    const h = ctx.hexById.get(id);
    if (h?.resource) profile[h.resource] += pips(h.number) * weight;
  }
}

const withCorner = (ctx: BoardContext, profile: ResourceHand, at: string): ResourceHand => {
  const next = { ...profile };
  addCorner(ctx, next, at);
  return next;
};

export function isLegal(ctx: BoardContext, at: string, taken: Set<string>): boolean {
  const c = ctx.byAt.get(at);
  if (!c || c.resources.length === 0 || taken.has(at)) return false;
  return !(ctx.nbrs.get(at) ?? []).some((n) => taken.has(n));
}

export function portReportFor(ctx: BoardContext, placements: Placements, playerId: string): PortAccessReport {
  const taken = new Set(occupiedMap(placements).keys());
  return assessPortAccess({
    ctx,
    placements,
    playerId,
    myDistance: roadDistance(ctx, placements, (owner) => owner === playerId),
    opponentDistance: roadDistance(ctx, placements, (owner) => owner !== playerId),
    settlementLegal: (at) => isLegal(ctx, at, taken)
  });
}

export function scoreSpot(
  ctx: BoardContext,
  c: CornerInfo,
  own: ResourceHand,
  taken: Set<string>,
  rates?: ResourceHand
): { at: string; value: number; pips: number; tags: string[] } {
  const tags: string[] = [];
  const hexes = c.hexIds.map((id) => ctx.hexById.get(id)).filter((h): h is HexTile => Boolean(h));
  const kinds = new Set<Resource>();
  const seenNumbers = new Set<number>();
  let value = 0;
  let dupNumber = 0;
  let dupResource = 0;
  let desert = 0;
  const pipsHere = emptyProfile();
  for (const h of hexes) {
    if (!h.resource) {
      desert++;
      continue;
    }
    const p = pips(h.number);
    pipsHere[h.resource] += p;
    value += p * ctx.resWeight[h.resource];
    if (h.resource === "grain") value += p * 0.6;
    else if (h.resource === "ore") value += p * 0.55;
    if (ctx.resWeight[h.resource] >= 1.15) value += p * 0.4;
    if (kinds.has(h.resource)) dupResource++;
    kinds.add(h.resource);
    if (h.number !== null) {
      if (seenNumbers.has(h.number)) dupNumber++;
      seenNumbers.add(h.number);
    }
  }
  value += 0.9 * kinds.size;
  if (dupNumber) {
    value -= 0.7 * dupNumber;
    tags.push("repeats a number");
  }
  if (dupResource) value -= 0.6 * dupResource;
  if (desert) {
    value -= 3.2 * desert;
    tags.push("touches the desert");
  }
  if (kinds.has("ore") && kinds.has("grain")) {
    value += pipsHere.ore >= 4 && pipsHere.grain >= 4 ? 4.4 : 3.2;
    tags.push("ore + wheat for cities");
  }
  if (kinds.has("brick") && kinds.has("lumber")) {
    value += 1.4;
    tags.push("brick + wood for roads");
  }
  if (!kinds.has("ore") && !kinds.has("grain") && pipsHere.wool >= c.pips * 0.5 && c.pips >= 8 && !c.port) {
    value -= 2.6;
    tags.push("no wheat or ore");
  }
  const hasOwn = RESOURCES.some((r) => own[r] > 0);
  const fresh = hasOwn ? [...kinds].filter((r) => own[r] === 0) : [];
  for (const r of fresh) {
    const need = r === "grain" || r === "ore" ? 2.6 : r === "lumber" || r === "brick" ? 1.5 : 0.5;
    value += need + 0.2 * pipsHere[r];
    tags.push(`adds ${LABEL[r]}`);
  }
  for (const r of kinds) if (ctx.resWeight[r] >= 1.15) tags.push(`scarce ${LABEL[r]}`);
  const after = new Set(taken);
  after.add(c.at);
  const room = (ctx.ring2.get(c.at) ?? []).filter((n) => isLegal(ctx, n, after)).length;
  value += Math.min(5, room) * 0.3;
  if (room <= 1) {
    value -= 1;
    tags.push("cramped");
  } else if (room >= 4) tags.push("room to expand");
  const harborHelps = (kind: PortKind | undefined) => !kind || !rates || resourcesImprovedByHarbor(rates, kind).length > 0;
  if (c.port && harborHelps(c.port)) {
    if (c.port === "any") {
      value += 3.2;
      tags.push("3:1 port");
    } else {
      const feed = pipsHere[c.port] + own[c.port];
      value += feed >= 4 ? 3.6 + Math.min(1.2, 0.12 * feed) : 1.8;
      tags.push(`2:1 ${LABEL[c.port]} port`);
    }
  }
  for (const near of portsNear(ctx, c.at, 2)) {
    if (near.dist === 0 || !harborHelps(near.kind)) continue;
    if (near.dist === 1 && near.kind === "any") value += 2.6;
    else if (near.dist === 1 && near.kind !== "any" && (pipsHere[near.kind] >= 4 || own[near.kind] >= 4)) value += 2.8;
    const worth = near.dist === 1 ? 0 : portWorth(near.kind, own, pipsHere, near.dist);
    if (near.dist > 1 && worth < 0.25) continue;
    value += worth;
    const closePort = near.dist === 1 && (near.kind === "any" || pipsHere[near.kind] >= 4 || own[near.kind] >= 4);
    if (closePort || worth >= 0.45) {
      const name = near.kind === "any" ? "3:1 port" : `2:1 ${LABEL[near.kind]} port`;
      tags.push(`${name} ${near.dist} road${near.dist > 1 ? "s" : ""} away`);
    }
  }
  return { at: c.at, value, pips: c.pips, tags };
}

export function legalCorners(ctx: BoardContext, taken: Set<string>): CornerInfo[] {
  return ctx.corners.filter((c) => isLegal(ctx, c.at, taken));
}

function rankFor(ctx: BoardContext, profile: ResourceHand, taken: Set<string>, rates?: ResourceHand) {
  return legalCorners(ctx, taken)
    .map((c) => {
      const s = scoreSpot(ctx, c, profile, taken, rates);
      return { at: c.at, value: s.value, s };
    })
    .sort((a, b) => b.value - a.value);
}

const DENIAL_WEIGHTS = [1, 0.5, 0.25];

function denial(ctx: BoardContext, theirs: Array<{ at: string; value: number }>, at: string): number {
  const gone = new Set([at, ...(ctx.nbrs.get(at) ?? [])]);
  const top = (list: Array<{ at: string; value: number }>) => list.slice(0, 3).map((r) => r.value);
  const before = top(theirs);
  const after = top(theirs.filter((r) => !gone.has(r.at)));
  return DENIAL_WEIGHTS.reduce((s, w, i) => s + w * ((before[i] ?? 0) - (after[i] ?? 0)), 0);
}

const NOTES: Record<OpeningMode, string> = {
  first: "You place first. Scores look ahead: he takes two spots before your second, so a spot that leaves a strong second one for you ranks higher.",
  pair: "You place two in a row. Each pick is scored together with your best second spot (marked +).",
  second: "Your second settlement. Scores favour what you still lack and the spots he still wants.",
  last: "Your last placement and he cannot react any more, so this is pure value.",
  waiting: "Waiting for him. These are the spots he is most likely to take next."
};

function spotLead(c: CornerInfo): string {
  const ore = c.resources.includes("ore");
  const wheat = c.resources.includes("grain");
  if (ore && wheat) return "Ore and wheat. ";
  if (wheat) return "Wheat, still short of ore. ";
  if (ore) return "Ore, still short of wheat. ";
  return "No wheat or ore. ";
}

export function describe(ctx: BoardContext, at: string, tags: string[], label: Record<Resource, string> = LABEL): string {
  const c = ctx.byAt.get(at);
  if (!c) return at;
  const parts = c.numbers.map((n, i) => `${n} ${label[c.resources[i]] ?? ""}`.trim());
  return `${c.pips} pips (${parts.join(", ")})${tags.length ? `, ${tags.join(", ")}` : ""}`;
}

export function planOpening(board: Board, placements: Placements, me: string, limit = 3, myTurn: boolean | undefined = undefined): OpeningPlan {
  const ctx = contextFor(board);
  const built = occupiedMap(placements);
  const taken = new Set(built.keys());
  const mineN = [...built.values()].filter((o) => o === me).length;
  const oppN = built.size - mineN;
  const own = profileOf(ctx, placements, (o) => o === me);
  const his = profileOf(ctx, placements, (o) => o !== me);
  let mode: OpeningMode;
  if (mineN === 0 && oppN === 0) mode = "first";
  else if (mineN === 0) mode = "pair";
  else if (mineN >= 2 || (mineN === 1 && oppN === 0)) mode = "waiting";
  else if (mineN === 1 && oppN >= 2) mode = "last";
  else mode = "second";
  if (myTurn === false) mode = "waiting";
  else if (myTurn === true && mode === "waiting") mode = "second";
  const myRates = ratesFromPlacements(ctx, placements, (owner) => owner === me);
  const hisRates = ratesFromPlacements(ctx, placements, (owner) => owner !== me);
  const theirs = rankFor(ctx, his, taken, hisRates);
  const oppWants = theirs.slice(0, 3).map((r) => ({ at: r.at, reason: describe(ctx, r.at, r.s.tags.slice(0, 3)) }));
  if (mode === "waiting") return { mode, picks: [], oppWants, note: NOTES[mode] };
  const followWeight = mode === "first" ? 0.6 : mode === "pair" ? 0.9 : 0;
  const denialWeight = mode === "last" ? 0 : 0.5;
  const mine = rankFor(ctx, own, taken, myRates);
  const scored = mine.map((cand) => {
    const dn = denialWeight ? denial(ctx, theirs, cand.at) : 0;
    let follow = 0;
    let followAt: string | undefined;
    const hisProjected: string[] = [];
    if (followWeight) {
      const t1 = new Set(taken);
      t1.add(cand.at);
      const own1 = withCorner(ctx, own, cand.at);
      let t2 = t1;
      if (mode === "first") {
        t2 = new Set(t1);
        let his2 = his;
        let hisRatesAfter = hisRates;
        for (let i = 0; i < 2; i++) {
          const pick = rankFor(ctx, his2, t2, hisRatesAfter)[0];
          if (!pick) break;
          t2.add(pick.at);
          hisProjected.push(pick.at);
          his2 = withCorner(ctx, his2, pick.at);
          const takenPort = ctx.byAt.get(pick.at)?.port;
          if (takenPort) hisRatesAfter = applyHarborToRates(hisRatesAfter, takenPort);
        }
      }
      const pickedPort = ctx.byAt.get(cand.at)?.port;
      const ownRatesAfter = pickedPort ? applyHarborToRates(myRates, pickedPort) : myRates;
      const hisAfter = mode === "pair" ? rankFor(ctx, his, t1, hisRates) : [];
      const best = rankFor(ctx, own1, t2, ownRatesAfter)
        .map((r) => ({ r, v: r.value + (mode === "pair" ? 0.4 * denial(ctx, hisAfter, r.at) : 0) }))
        .sort((a, b) => b.v - a.v)[0];
      if (best) {
        follow = best.v;
        followAt = best.r.at;
      }
    }
    const myAts = [...placements.settlements].filter(([, o]) => o === me).map(([at]) => at);
    if (!myAts.includes(cand.at)) myAts.push(cand.at);
    if (followAt && !myAts.includes(followAt)) myAts.push(followAt);
    const hisAts = [...placements.settlements].filter(([, o]) => o !== me).map(([at]) => at);
    for (const at of hisProjected) if (!hisAts.includes(at)) hisAts.push(at);
    if (hisAts.length < 2) {
      const blocked = new Set([...taken, ...myAts, ...hisAts]);
      while (hisAts.length < 2) {
        const next = rankFor(ctx, his, blocked)[0];
        if (!next) break;
        hisAts.push(next.at);
        blocked.add(next.at);
      }
    }
    const gap = myAts.reduce((s, at) => s + (ctx.byAt.get(at)?.pips ?? 0), 0) - hisAts.reduce((s, at) => s + (ctx.byAt.get(at)?.pips ?? 0), 0);
    return { cand, dn, follow, followAt, gap, total: cand.value + followWeight * follow + denialWeight * dn + 0.12 * gap };
  });
  scored.sort((a, b) => b.total - a.total);
  const picks: OpeningPick[] = [];
  for (const item of scored) {
    if (picks.some((p) => (ctx.nbrs.get(p.at) ?? []).includes(item.cand.at))) continue;
    const c = ctx.byAt.get(item.cand.at)!;
    const tags = [...item.cand.s.tags];
    const topHis = theirs[0];
    const rankInHis = theirs.slice(0, 3).findIndex((r) => r.at === item.cand.at);
    if (denialWeight && rankInHis >= 0) tags.unshift(rankInHis === 0 ? "takes his best spot" : `takes his #${rankInHis + 1} spot`);
    else if (denialWeight && topHis && (ctx.nbrs.get(item.cand.at) ?? []).includes(topHis.at)) tags.unshift("blocks his best spot");
    else if (denialWeight && item.dn >= 2) tags.unshift("hurts his options");
    picks.push({
      at: item.cand.at,
      score: item.total,
      pips: c.pips,
      resources: c.resources,
      numbers: c.numbers,
      port: c.port,
      tags,
      followUp: item.followAt ? { at: item.followAt, reason: describe(ctx, item.followAt, []) } : undefined,
      reason: `${spotLead(c)}${describe(ctx, item.cand.at, tags.slice(0, 4))}. ${item.gap > 0 ? `+${item.gap} pips on him` : item.gap < 0 ? `He keeps the better opening (${item.gap} pips)` : "Even opening pips"}.`
    });
    if (picks.length >= limit) break;
  }
  return { mode, picks, oppWants, note: NOTES[mode] };
}

const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function edgeOwners(ctx: BoardContext, p: Placements): { owners: Map<string, string>; ends: Map<string, [string, string]> } {
  const owners = new Map<string, string>();
  const ends = new Map<string, [string, string]>();
  for (const [at, owner] of p.roads) {
    const pts = edgePoints(at);
    const a = pts && ctx.keyToAt.get(pointKey(pts[0]));
    const b = pts && ctx.keyToAt.get(pointKey(pts[1]));
    if (!a || !b) continue;
    owners.set(edgeKey(a, b), owner);
    ends.set(at, [a, b]);
  }
  return { owners, ends };
}

export function roadDistance(ctx: BoardContext, p: Placements, owner: (o: string) => boolean): Map<string, number> {
  const built = occupiedMap(p);
  const { owners, ends } = edgeOwners(ctx, p);
  const dist = new Map<string, number>();
  for (const [at, o] of built) if (owner(o)) dist.set(at, 0);
  for (const [at, o] of p.roads) {
    if (!owner(o)) continue;
    for (const end of ends.get(at) ?? []) dist.set(end, 0);
  }
  const done = new Set<string>();
  for (;;) {
    let u: string | undefined;
    for (const [at, d] of dist) if (!done.has(at) && (u === undefined || d < dist.get(u)!)) u = at;
    if (u === undefined) break;
    done.add(u);
    const occupier = built.get(u);
    if (occupier && !owner(occupier)) continue;
    const du = dist.get(u)!;
    for (const v of ctx.nbrs.get(u) ?? []) {
      const o = owners.get(edgeKey(u, v));
      if (o && !owner(o)) continue;
      const nd = du + (o ? 0 : 1);
      if (nd < (dist.get(v) ?? Infinity)) dist.set(v, nd);
    }
  }
  return dist;
}

const roadsText = (d: number) => (d === 0 ? "reachable by your road" : `${d} road${d > 1 ? "s" : ""} away`);

export function planMidgame(board: Board, placements: Placements, me: string): MidgamePlan {
  const ctx = contextFor(board);
  const built = occupiedMap(placements);
  const taken = new Set(built.keys());
  const isMe = (o: string) => o === me;
  const isHim = (o: string) => o !== me;
  const own = profileOf(ctx, placements, isMe);
  const his = profileOf(ctx, placements, isHim);
  const myDist = roadDistance(ctx, placements, isMe);
  const hisDist = roadDistance(ctx, placements, isHim);
  const portReport = portReportFor(ctx, placements, me);
  const myRates = portReport.rates.rates;
  const hisRates = ratesFromPlacements(ctx, placements, isHim);
  const spread = (spots: MidgameSpot[], limit: number) => {
    const picked: MidgameSpot[] = [];
    for (const s of spots.sort((a, b) => b.score - a.score)) {
      if (picked.some((p) => (ctx.nbrs.get(p.at) ?? []).includes(s.at))) continue;
      picked.push(s);
      if (picked.length >= limit) break;
    }
    return picked;
  };
  const expansion: MidgameSpot[] = [];
  const oppWants: MidgameSpot[] = [];
  for (const c of legalCorners(ctx, taken)) {
    const d = myDist.get(c.at) ?? Infinity;
    const hd = hisDist.get(c.at) ?? Infinity;
    const mineScore = scoreSpot(ctx, c, own, taken, myRates);
    const hisScore = scoreSpot(ctx, c, his, taken, hisRates);
    if (d <= 2) {
      const tags = [roadsText(d), ...mineScore.tags.slice(0, 3)];
      if (hd <= 2) tags.push(`he can reach it too (${hd === 0 ? "now" : `${hd} road${hd > 1 ? "s" : ""}`})`);
      expansion.push({ at: c.at, dist: d, score: mineScore.value - 1.4 * d + (hd <= 2 ? 0.3 * hisScore.value : 0), reason: describe(ctx, c.at, tags) });
    }
    if (hd <= 2) {
      const tags = [roadsText(hd).replace("your", "his")];
      tags.push(d <= 3 ? (d <= hd ? `you can get there first (${d} road${d === 1 ? "" : "s"})` : `you are ${d} road${d === 1 ? "" : "s"} away`) : "out of your reach");
      tags.push(...hisScore.tags.slice(0, 2));
      oppWants.push({ at: c.at, dist: hd, score: hisScore.value - 1.4 * hd, reason: describe(ctx, c.at, tags) });
    }
  }
  let upgrade: string | undefined;
  const settlements = [...placements.settlements]
    .filter(([, o]) => isMe(o))
    .map(([at]) => ctx.byAt.get(at))
    .filter((c): c is CornerInfo => Boolean(c));
  if (settlements.length) {
    const cityWorth = (c: CornerInfo) => {
      let ore = 0;
      let wheat = 0;
      let other = 0;
      c.resources.forEach((r, i) => {
        const n = pips(c.numbers[i] ?? null);
        if (r === "ore") ore += n;
        else if (r === "grain") wheat += n;
        else other += n;
      });
      return ore * 2.4 + wheat * 2.2 + other * 0.35 + (ore > 0 && wheat > 0 ? 6 : 0);
    };
    const best = settlements.slice().sort((a, b) => cityWorth(b) - cityWorth(a))[0];
    const ore = best.resources.includes("ore");
    const wheat = best.resources.includes("grain");
    const why =
      ore && wheat
        ? "It has ore and wheat, which a higher pip count without them does not."
        : wheat
          ? "It has the wheat. A higher pip count with no wheat is the worse city."
          : ore
            ? "It has the ore. A higher pip count with no ore is the worse city."
            : "None of your settlements has wheat or ore, so this is the least bad city.";
    upgrade = `City on ${best.numbers.join("/")} (${best.pips} pips). ${why}`;
  }
  const weaknesses: string[] = [];
  const nextPort = viablePortTargets(portReport)
    .filter((port) => (port.roadsRemaining ?? 99) <= 4)
    .sort((a, b) => (a.roadsRemaining ?? 99) - (b.roadsRemaining ?? 99))[0];
  if (nextPort && portWorth(nextPort.kind, own, emptyProfile(), nextPort.roadsRemaining ?? 0, nextPort.opponentRoadsRemaining) >= 0.55) {
    weaknesses.push(`Port: ${describePortTarget(nextPort)}. A spot that reaches a new harbor is worth more than the same pips inland.`);
  }
  const missing = (p: ResourceHand) => RESOURCES.filter((r) => p[r] === 0);
  const mineMissing = missing(own);
  if (mineMissing.length) weaknesses.push(`You produce no ${mineMissing.map((r) => LABEL[r]).join(" or ")}; expansion spots that add it rank higher.`);
  const hisMissing = missing(his);
  if (hisMissing.length && built.size > 0) weaknesses.push(`He produces no ${hisMissing.map((r) => LABEL[r]).join(" or ")}: a spot that gives it denies him, and he will have to trade or use a port.`);
  const scarce = RESOURCES.filter((r) => ctx.resWeight[r] >= 1.25).sort((a, b) => ctx.resPips[a] - ctx.resPips[b])[0];
  if (scarce) weaknesses.push(`${LABEL[scarce][0].toUpperCase()}${LABEL[scarce].slice(1)} is scarce on this board (${ctx.resPips[scarce]} pips in total), so whoever controls it has leverage.`);
  for (const [who, owner] of [
    ["Your", isMe],
    ["His", isHim]
  ] as const) {
    const lean = incomeLean(ctx, placements, owner);
    if (lean) weaknesses.push(`${who} income leans on the ${lean.number} ${LABEL[lean.resource]} hex (${Math.round(lean.share * 100)}% of the pips); a robber there hurts ${who === "Your" ? "you" : "him"} most.`);
  }
  return { expansion: spread(expansion, 2), oppWants: spread(oppWants, 2), upgrade, weaknesses };
}

function incomeLean(ctx: BoardContext, p: Placements, owner: (o: string) => boolean): { number: number; resource: Resource; share: number } | undefined {
  const perHex = new Map<string, number>();
  let total = 0;
  const add = (at: string, w: number) => {
    for (const id of ctx.byAt.get(at)?.hexIds ?? []) {
      const h = ctx.hexById.get(id);
      if (!h?.resource) continue;
      const v = pips(h.number) * w;
      perHex.set(id, (perHex.get(id) ?? 0) + v);
      total += v;
    }
  };
  for (const [at, o] of p.settlements) if (owner(o)) add(at, 1);
  for (const [at, o] of p.cities) if (owner(o)) add(at, 2);
  if (total < 6) return undefined;
  const [id, v] = [...perHex].sort((a, b) => b[1] - a[1])[0] ?? [];
  const h = id ? ctx.hexById.get(id) : undefined;
  return h?.resource && h.number && v / total >= 0.4 ? { number: h.number, resource: h.resource, share: v / total } : undefined;
}

export function hexDependence(ctx: BoardContext, p: Placements, owner: (o: string) => boolean): Map<string, { pips: number; share: number }> {
  const perHex = new Map<string, number>();
  const perRes = emptyProfile();
  const add = (at: string, w: number) => {
    for (const id of ctx.byAt.get(at)?.hexIds ?? []) {
      const h = ctx.hexById.get(id);
      if (!h?.resource) continue;
      const v = pips(h.number) * w;
      perHex.set(id, (perHex.get(id) ?? 0) + v);
      perRes[h.resource] += v;
    }
  };
  for (const [at, o] of p.settlements) if (owner(o)) add(at, 1);
  for (const [at, o] of p.cities) if (owner(o)) add(at, 2);
  return new Map(
    [...perHex].map(([id, v]) => {
      const r = ctx.hexById.get(id)?.resource;
      return [id, { pips: v, share: r && perRes[r] ? v / perRes[r] : 0 }];
    })
  );
}
