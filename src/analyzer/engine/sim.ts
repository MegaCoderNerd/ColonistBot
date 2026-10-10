// Recovered from content.js (lines 1727-1986)
import { pips } from "../replay";
import { RESOURCES, type PortKind, type Resource, type ResourceBag, type ResourceHand } from "../types";
import { createDice } from "./dice";
import { mulberry32 } from "./rng";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface SimProd {
  resource: Resource;
  number: number;
  weight: number;
}

export interface SimBuilding {
  prods: SimProd[];
  pip: number;
  city: boolean;
}

export interface SimExpansion {
  prods: SimProd[];
  pip: number;
  roads: number;
  port?: PortKind;
  at?: string;
}

export interface SimPlayer {
  buildings: SimBuilding[];
  expansions: SimExpansion[];
  progress: number;
  hand: ResourceHand;
  ratios: ResourceHand;
  vp: number;
  knights: number;
  devs: number;
  roads: number;
  hasRoad: boolean;
  hasArmy: boolean;
  blocked: number | null;
}

export interface RaceOptions {
  trials?: number;
  maxTurns?: number;
  goal?: number;
  discardLimit?: number;
  seed?: number;
  balanced?: boolean;
}

const empty = (): ResourceHand => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
const CITY: ResourceBag = { grain: 2, ore: 3 };
const SETTLEMENT: ResourceBag = { lumber: 1, brick: 1, wool: 1, grain: 1 };
const ROAD: ResourceBag = { lumber: 1, brick: 1 };
const DEV: ResourceBag = { wool: 1, grain: 1, ore: 1 };

export function newPlayer(partial: Partial<SimPlayer> = {}): SimPlayer {
  return {
    buildings: [],
    expansions: [],
    progress: 0,
    hand: empty(),
    ratios: { lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 },
    vp: 2,
    knights: 0,
    devs: 0,
    roads: 2,
    hasRoad: false,
    hasArmy: false,
    blocked: null,
    ...partial
  };
}

export function clonePlayer(p: SimPlayer): SimPlayer {
  return {
    ...p,
    hand: { ...p.hand },
    ratios: { ...p.ratios },
    buildings: p.buildings.map((b) => ({ ...b, prods: b.prods.map((x) => ({ ...x })) })),
    expansions: p.expansions.map((e) => ({ ...e, prods: e.prods.map((x) => ({ ...x })) }))
  };
}

export function applyPort(p: SimPlayer, port?: PortKind) {
  if (!port) return;
  if (port === "any") {
    for (const r of RESOURCES) p.ratios[r] = Math.min(p.ratios[r], 3);
  } else p.ratios[port] = Math.min(p.ratios[port], 2);
}

const count = (h: ResourceHand): number => RESOURCES.reduce((s, r) => s + h[r], 0);

function canPay(h: ResourceHand, cost: ResourceBag): boolean {
  return RESOURCES.every((r) => h[r] >= (cost[r] ?? 0));
}

function pay(h: ResourceHand, cost: ResourceBag) {
  for (const r of RESOURCES) h[r] -= cost[r] ?? 0;
}

function acquire(p: SimPlayer, cost: ResourceBag, limit = 5): boolean {
  for (let n = 0; n < limit && !canPay(p.hand, cost); n++) {
    let want: Resource | undefined;
    let worst = 0;
    for (const r of RESOURCES) {
      const short = (cost[r] ?? 0) - p.hand[r];
      if (short > worst) {
        worst = short;
        want = r;
      }
    }
    if (!want) break;
    let give: Resource | undefined;
    let best = 0;
    for (const r of RESOURCES) {
      if (r === want || p.hand[r] < p.ratios[r]) continue;
      if (p.hand[r] - p.ratios[r] < (cost[r] ?? 0)) continue;
      const spare = p.hand[r] / p.ratios[r];
      if (spare > best) {
        best = spare;
        give = r;
      }
    }
    if (!give) return false;
    p.hand[give] -= p.ratios[give];
    p.hand[want]++;
  }
  if (!canPay(p.hand, cost)) return false;
  pay(p.hand, cost);
  return true;
}

function produce(p: SimPlayer, roll: number) {
  if (roll === 7) return;
  for (const b of p.buildings) {
    for (const prod of b.prods) {
      if (prod.number === roll && prod.number !== p.blocked) p.hand[prod.resource] += prod.weight;
    }
  }
}

function discard(p: SimPlayer, limit: number) {
  let extra = count(p.hand) - limit;
  if (extra <= 0) return;
  const drop = Math.floor(count(p.hand) / 2);
  let left = drop;
  while (left > 0) {
    let r: Resource = "lumber";
    for (const x of RESOURCES) if (p.hand[x] > p.hand[r]) r = x;
    if (p.hand[r] <= 0) break;
    p.hand[r]--;
    left--;
  }
  void extra;
}

function steal(from: SimPlayer, to: SimPlayer, rng: () => number) {
  const n = count(from.hand);
  if (!n || from.vp <= 2) return;
  let pick = Math.floor(rng() * n);
  for (const r of RESOURCES) {
    if (pick < from.hand[r]) {
      from.hand[r]--;
      to.hand[r]++;
      return;
    }
    pick -= from.hand[r];
  }
}

function bestNumber(p: SimPlayer): number | null {
  const by = new Map<number, number>();
  for (const b of p.buildings) for (const prod of b.prods) by.set(prod.number, (by.get(prod.number) ?? 0) + pips(prod.number) * prod.weight);
  let best = 0;
  let num: number | null = null;
  for (const [n, v] of by)
    if (v > best) {
      best = v;
      num = n;
    }
  return num;
}

export function payValue(prods: SimProd[], roads = 0, port?: PortKind): number {
  let ore = 0;
  let wheat = 0;
  let other = 0;
  for (const prod of prods) {
    const n = pips(prod.number) * prod.weight;
    if (prod.resource === "ore") ore += n;
    else if (prod.resource === "grain") wheat += n;
    else other += n;
  }
  return ore * 2.1 + wheat * 2 + other * 0.7 + (ore > 0 && wheat > 0 ? 5 : 0) + (port === "any" ? 2 : port ? 2.4 : 0) - roads * 1.3;
}

function city(p: SimPlayer): boolean {
  const open = p.buildings.filter((b) => !b.city);
  if (!open.length || p.buildings.filter((b) => b.city).length >= 4) return false;
  open.sort((a, b) => payValue(b.prods) - payValue(a.prods));
  const b = open[0];
  b.city = true;
  for (const prod of b.prods) prod.weight *= 2;
  b.pip *= 2;
  p.vp++;
  return true;
}

function settle(p: SimPlayer): boolean {
  const exp = p.expansions[0];
  if (!exp || p.progress < exp.roads || p.buildings.length >= 5) return false;
  p.expansions.shift();
  p.progress = 0;
  p.buildings.push({ prods: exp.prods.map((x) => ({ ...x })), pip: exp.pip, city: false });
  p.vp++;
  applyPort(p, exp.port);
  return true;
}

function road(p: SimPlayer, opponent: SimPlayer): boolean {
  const exp = p.expansions[0];
  if (!exp || p.progress >= exp.roads) return false;
  p.progress++;
  p.roads++;
  if (p.roads >= 5 && !p.hasRoad && !opponent.hasRoad) {
    p.hasRoad = true;
    p.vp += 2;
  }
  return true;
}

function dev(p: SimPlayer, rng: () => number) {
  p.devs++;
  const roll = rng();
  if (roll < 14 / 25) {
    p.knights++;
    if (p.knights >= 3 && !p.hasArmy) {
      p.hasArmy = true;
      p.vp += 2;
    }
  } else if (roll < 19 / 25) p.vp++;
  else if (roll < 21 / 25) p.progress += 2;
  else {
    const r = RESOURCES[Math.floor(rng() * RESOURCES.length)];
    p.hand[r] += 2;
  }
}

const pipTotal = (p: SimPlayer, pred: (r: Resource) => boolean) =>
  p.buildings.reduce((s, b) => s + b.prods.reduce((t, prod) => t + (pred(prod.resource) ? pips(prod.number) * prod.weight : 0), 0), 0);

function act(p: SimPlayer, opponent: SimPlayer, rng: () => number, depth = 0) {
  if (depth >= 4 || p.vp >= 15) return;
  const exp = p.expansions[0];
  const oreWheat = pipTotal(p, (r) => r === "ore" || r === "grain");
  const canCity = p.buildings.some((b) => !b.city);
  if (canCity && (oreWheat >= 7 || !exp) && acquire(p, CITY)) {
    city(p);
    act(p, opponent, rng, depth + 1);
    return;
  }
  if (exp && p.progress >= exp.roads && (exp.pip >= 6 || exp.port) && acquire(p, SETTLEMENT, 4)) {
    settle(p);
    act(p, opponent, rng, depth + 1);
    return;
  }
  if (exp && p.progress < exp.roads && (exp.port || exp.pip >= 7 || exp.roads - p.progress <= 1) && acquire(p, ROAD, 3)) {
    road(p, opponent);
    act(p, opponent, rng, depth + 1);
    return;
  }
  if (p.devs < 7 && p.knights < 4 && acquire(p, DEV, 3)) {
    dev(p, rng);
    act(p, opponent, rng, depth + 1);
    return;
  }
  if (count(p.hand) > 9 && canCity && acquire(p, CITY, 2)) {
    city(p);
    return;
  }
}

export function race(a0: SimPlayer, b0: SimPlayer, options: RaceOptions = {}): { a: { win: number; turns: number }; b: { win: number; turns: number } } {
  const trials = options.trials ?? 8;
  const maxTurns = options.maxTurns ?? 48;
  const goal = options.goal ?? 15;
  const limit = options.discardLimit ?? 9;
  const seed = options.seed ?? 1;
  const aTurns: number[] = [];
  const bTurns: number[] = [];
  let aWin = 0;
  for (let i = 0; i < trials; i++) {
    const rng = mulberry32(seed + i * 997);
    const dice = createDice(rng, options.balanced !== false);
    const a = clonePlayer(a0);
    const b = clonePlayer(b0);
    let at = maxTurns;
    let bt = maxTurns;
    const first = i % 2 === 0 ? a : b;
    const second = first === a ? b : a;
    for (let t = 1; t <= maxTurns && (at === maxTurns || bt === maxTurns); t++) {
      const roll = dice();
      const roller = t % 2 === 1 ? first : second;
      const other = roller === a ? b : a;
      if (roll === 7) {
        discard(a, limit);
        discard(b, limit);
        if (other.vp > 2) steal(other, roller, rng);
        other.blocked = bestNumber(other);
        roller.blocked = null;
      } else {
        produce(a, roll);
        produce(b, roll);
      }
      act(roller, other, rng);
      if (a.vp >= goal && at === maxTurns) at = t;
      if (b.vp >= goal && bt === maxTurns) bt = t;
    }
    aTurns.push(at);
    bTurns.push(bt);
    if (at < bt || (at === bt && a.vp > b.vp)) aWin++;
    else if (at === bt && a.vp === b.vp) aWin += 0.5;
  }
  const median = (xs: number[]) => xs.slice().sort((x, y) => x - y)[Math.floor((xs.length - 1) / 2)];
  return { a: { win: aWin / trials, turns: median(aTurns) }, b: { win: 1 - aWin / trials, turns: median(bTurns) } };
}

export function pipOf(prods: SimProd[]): number {
  return prods.reduce((s, p) => s + pips(p.number) * p.weight, 0);
}
