// Recovered from content.js (lines 2303-2611)
import { contextFor, isLegal, occupiedMap, portReportFor, profileOf, roadDistance, scoreSpot, type BoardContext } from "../strategy";
import { RESOURCES, type Board, type Placements, type Resource, type ResourceBag, type ResourceHand } from "../types";
import { assessSettlementRace, routeIsDeadEnd } from "./race";
import { ratesFromPlacements, resourcesImprovedByHarbor } from "./ports";
import { listOpenEdges, roadToward } from "./roads";
import { applyPort, newPlayer, payValue, pipOf, race, type SimPlayer, type SimProd } from "./sim";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface RollInfo {
  total: number;
  d1?: number;
  d2?: number;
  player?: string;
}

export type RollInput = number | RollInfo;

export interface RankedEdge {
  edge: string;
  toward?: string;
  follow?: string;
  score: number;
  dead: boolean;
  reason: string;
}

const FACE = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];
const DECK = 36;
const WINDOW = 24;

function asRolls(rolls: RollInput[]): RollInfo[] {
  return rolls.map((r) => (typeof r === "number" ? { total: r } : r));
}

function freshPairs(): Map<string, number> {
  const pairs = new Map<string, number>();
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) pairs.set(`${a},${b}`, 1);
  return pairs;
}

function takePair(pairs: Map<string, number>, roll: RollInfo) {
  if (roll.d1 && roll.d2) {
    const key = `${roll.d1},${roll.d2}`;
    const n = pairs.get(key) ?? 0;
    if (n > 0) {
      pairs.set(key, n - 1);
      return;
    }
  }
  for (const [key, n] of pairs) {
    if (n <= 0) continue;
    const [a, b] = key.split(",").map(Number);
    if (a + b === roll.total) {
      pairs.set(key, n - 1);
      return;
    }
  }
}

function deckOf(rolls: RollInfo[], aligned: boolean): { copies: number[]; weight: number[]; bagLeft: number; restarted: boolean } {
  const copies = new Array<number>(13).fill(0);
  const weight = new Array<number>(13).fill(0);
  const pairs = freshPairs();
  let restarted = false;
  if (aligned && rolls.length > 0) {
    const into = rolls.length % WINDOW;
    restarted = into === 0;
    const window = restarted ? [] : rolls.slice(-into);
    for (const roll of window) takePair(pairs, roll);
  }
  const last = aligned && rolls.length ? rolls[rolls.length - 1].total : undefined;
  for (const [key, n] of pairs) {
    if (n <= 0) continue;
    const [a, b] = key.split(",").map(Number);
    copies[a + b] += n;
  }
  let bagLeft = 0;
  for (let n = 2; n <= 12; n++) {
    weight[n] = last === n ? copies[n] * 0.7 : copies[n];
    bagLeft += copies[n];
  }
  return { copies, weight, bagLeft, restarted };
}

export function bagState(rolls: RollInput[], aligned: boolean) {
  const deck = deckOf(asRolls(rolls), aligned);
  return {
    left: deck.copies,
    weight: deck.weight,
    bagLeft: deck.bagLeft,
    aligned,
    sevensLeft: deck.copies[7] ?? 0,
    restarted: deck.restarted
  };
}

export function mostLikelyRolls(rolls: RollInput[], aligned: boolean): number[] {
  const bag = bagState(rolls, aligned);
  let best = -1;
  const nums: number[] = [];
  for (let n = 2; n <= 12; n++) {
    const w = bag.weight[n] ?? 0;
    if (w > best) {
      best = w;
      nums.length = 0;
      nums.push(n);
    } else if (w === best && w > 0) nums.push(n);
  }
  return nums;
}

export function payFaces(numbers: number[], left: number[]): number {
  const seen = new Set<number>();
  let faces = 0;
  for (const n of numbers) {
    if (seen.has(n) || n < 2 || n > 12) continue;
    seen.add(n);
    faces += left[n] ?? 0;
  }
  return faces;
}

export function fairFaces(numbers: number[]): number {
  return payFaces(numbers, FACE);
}

export function repeatedPips(numbers: number[]): number {
  const seen = new Set<number>();
  let extra = 0;
  for (const n of numbers) {
    if (n < 2 || n > 12) continue;
    if (seen.has(n)) extra += FACE[n] ?? 0;
    else seen.add(n);
  }
  return extra;
}

export function bagSwing(numbers: number[], rolls: RollInput[], aligned: boolean): number {
  const bag = bagState(rolls, aligned);
  const faces = payFaces(numbers, bag.left);
  const fair = fairFaces(numbers) / 36;
  const rate = bag.bagLeft > 0 ? faces / bag.bagLeft : 0;
  return (rate - fair) * 40 - repeatedPips(numbers) * 0.9;
}

export function nextRollText(rolls: RollInput[], aligned: boolean): string {
  const bag = bagState(rolls, aligned);
  if (!aligned) return "The rolls since this tab connected are not the whole bag. On a fair bag the next roll is most likely 7 (6 of 36).";
  const nums = mostLikelyRolls(rolls, aligned);
  const restart = bag.restarted ? "The deck restarted with 12 cards left. " : "";
  if (!nums.length) return `${restart}The deck is empty and restarts. The next roll is most likely 7 (6 of ${DECK}).`;
  const shown = bag.left[nums[0]] ?? 0;
  if (nums.length === 1) return `${restart}Next roll is most likely ${nums[0]} (${shown} left in ${bag.bagLeft}).`;
  return `${restart}Next roll is most likely ${nums.join(" or ")}, ${shown} left each in ${bag.bagLeft}.`;
}

export function sevensText(rolls: RollInput[], aligned: boolean, me?: string): string {
  const bag = bagState(rolls, aligned);
  const base = !aligned ? "A fair bag still holds 6 sevens in 36." : `${bag.sevensLeft} seven${bag.sevensLeft === 1 ? "" : "s"} left in ${bag.bagLeft}.`;
  const seen = asRolls(rolls);
  if (!me) return base;
  let mine = 0;
  let his = 0;
  for (const roll of seen) {
    if (roll.total !== 7 || !roll.player) continue;
    if (roll.player === me) mine++;
    else his++;
  }
  const gap = mine - his;
  if (Math.abs(gap) < 2) return base;
  if (gap > 0) return `${base} You have rolled ${gap} more sevens than he has, so the next 7 is less likely to be yours.`;
  return `${base} He has rolled ${-gap} more sevens than you have, so the next 7 is less likely to be his.`;
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function hyperAtLeast(need: number, draws: number, hits: number, total: number): number {
  if (need <= 0) return 1;
  if (draws <= 0 || total <= 0 || hits <= 0) return 0;
  const n = Math.min(draws, total);
  const denom = comb(total, n);
  if (denom <= 0) return 0;
  let ways = 0;
  for (let k = need; k <= Math.min(n, hits); k++) ways += comb(hits, k) * comb(total - hits, n - k);
  return Math.max(0, Math.min(1, ways / denom));
}

function withRoad(placements: Placements, edge: string, owner: string): Placements {
  const roads = new Map(placements.roads);
  roads.set(edge, owner);
  return { settlements: placements.settlements, cities: placements.cities, roads };
}

function productionFaces(ctx: BoardContext, placements: Placements, me: string, resource: Resource, left: number[]): number {
  let faces = 0;
  const add = (at: string, weight: number) => {
    const corner = ctx.byAt.get(at);
    if (!corner) return;
    for (const id of corner.hexIds) {
      const hex = ctx.hexById.get(id);
      if (hex?.resource !== resource || hex.number === null) continue;
      faces += (left[hex.number] ?? 0) * weight;
    }
  };
  for (const [at, owner] of placements.settlements) if (owner === me) add(at, 1);
  for (const [at, owner] of placements.cities) if (owner === me) add(at, 2);
  return faces;
}

export function rankEdges(
  board: Board,
  placements: Placements,
  me: string,
  opts: {
    from?: string;
    onlyFrom?: boolean;
    maxDist?: number;
    rolls?: RollInput[];
    aligned?: boolean;
    hand?: ResourceBag;
    opponentKnown?: ResourceBag;
    opponentUnknown?: number;
  } = {}
): RankedEdge[] {
  const maxDist = opts.maxDist ?? 2;
  const edges = listOpenEdges(board, placements, me, opts.from, opts.onlyFrom);
  if (!edges.length) return [];
  const ctx = contextFor(board);
  const bag = bagState(opts.rolls ?? [], opts.aligned === true);
  const built = occupiedMap(placements);
  const taken = new Set(built.keys());
  if (opts.from) taken.add(opts.from);
  const own = profileOf(ctx, placements, (o) => o === me);
  const his = profileOf(ctx, placements, (o) => o !== me);
  const hisDist = roadDistance(ctx, placements, (o) => o !== me);
  const ownedRates = portReportFor(ctx, placements, me).rates.rates;
  const hisRates = ratesFromPlacements(ctx, placements, (owner) => owner !== me);
  const hand = opts.hand ?? {};
  const needWheat = Math.max(0, 2 - (hand.grain ?? 0));
  const needOre = Math.max(0, 3 - (hand.ore ?? 0));
  const wheatNow = productionFaces(ctx, placements, me, "grain", bag.left);
  const oreNow = productionFaces(ctx, placements, me, "ore", bag.left);
  const clockNow =
    hyperAtLeast(needWheat, Math.min(8, bag.bagLeft), Math.min(bag.bagLeft, wheatNow), bag.bagLeft) *
    hyperAtLeast(needOre, Math.min(8, bag.bagLeft), Math.min(bag.bagLeft, oreNow), bag.bagLeft);
  const ranked = edges.map((edge) => {
    const spots: Array<{
      at: string;
      dist: number;
      score: number;
      numbers: number[];
      pips: number;
      sheep: boolean;
      label: string;
      pay: string;
      lost: boolean;
      myTurns: number;
    }> = [];
    for (const corner of ctx.corners) {
      if (!isLegal(ctx, corner.at, taken)) continue;
      const step = roadToward(board, placements, me, corner.at, opts.onlyFrom ? opts.from : undefined);
      if (!step || step.edge !== edge.edge || step.dist < 1 || step.dist > maxDist) continue;
      const scored = scoreSpot(ctx, corner, own, taken, ownedRates);
      const faces = payFaces(corner.numbers, bag.left);
      const fair = fairFaces(corner.numbers) / 36;
      const rate = bag.bagLeft > 0 ? faces / bag.bagLeft : 0;
      const hd = hisDist.get(corner.at);
      const race = assessSettlementRace({
        myRoads: step.dist,
        opponentRoads: hd,
        myProduction: own,
        opponentProduction: his,
        myHand: opts.hand,
        opponentKnown: opts.opponentKnown,
        opponentUnknown: opts.opponentUnknown,
        myRates: ownedRates,
        opponentRates: hisRates,
        portImproves: Boolean(corner.port && resourcesImprovedByHarbor(ownedRates, corner.port).length > 0),
        weActFirst: true
      });
      const ore = corner.resources.filter((r) => r === "ore").length;
      const wheat = corner.resources.filter((r) => r === "grain").length;
      const clock =
        hyperAtLeast(needWheat, Math.min(8, bag.bagLeft), Math.min(bag.bagLeft, wheatNow + wheat * faces), bag.bagLeft) *
        hyperAtLeast(needOre, Math.min(8, bag.bagLeft), Math.min(bag.bagLeft, oreNow + ore * faces), bag.bagLeft);
      const sheep = corner.pips > 0 && corner.resources.filter((r) => r === "wool").length * 5 >= corner.pips * 0.6 && ore + wheat === 0;
      const score = scored.value + (rate - fair) * 40 - repeatedPips(corner.numbers) * 0.9 - step.dist * 1.4 + (clock - clockNow) * 8 + race.adjustment;
      spots.push({
        at: corner.at,
        dist: step.dist,
        score,
        numbers: corner.numbers,
        pips: corner.pips,
        sheep,
        label: `${corner.numbers.join("/")} (${corner.pips} pips)`,
        pay: `pays on ${faces} of the remaining ${bag.bagLeft}`,
        lost: race.lost,
        myTurns: race.myTurns
      });
    }
    spots.sort((a, b) => b.score - a.score);
    const dead = routeIsDeadEnd(spots);
    const usable = spots.filter((spot) => !spot.lost && Number.isFinite(spot.myTurns));
    const best = usable[0] ?? spots[0];
    const second = (usable.length ? usable : spots).find((spot) => spot !== best);
    const score = dead ? -50 : best.score + (second ? second.score * 0.25 : 0);
    let follow: string | undefined;
    if (best && best.dist >= 2) follow = roadToward(board, withRoad(placements, edge.edge, me), me, best.at)?.edge;
    return { edge: edge.edge, toward: best?.at, follow, score, dead, best, second };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked.map((row, i) => {
    const other = ranked.find((_, j) => j !== i);
    let reason: string;
    if (row.dead) {
      reason = row.best?.lost
        ? "This road dies. He can take the settlement first."
        : row.best
          ? "This road dies. You cannot pay for the settlement it reaches."
          : "This road dies. Nothing legal to settle is within two roads.";
    }
    else {
      reason = `This road leaves toward ${row.best.label}, ${row.best.pay}.`;
      if (other?.dead) reason += " The other road dies.";
      else if (other?.best?.sheep && !row.best.sheep) reason += " The other road only adds sheep.";
      else if (other?.best && other.best.at !== row.best.at) reason += ` The other road toward ${other.best.label} is the worse spot.`;
    }
    return { edge: row.edge, toward: row.toward, follow: row.follow, score: row.score, dead: row.dead, reason };
  });
}

export function bestEdge(
  board: Board,
  placements: Placements,
  me: string,
  opts: {
    from?: string;
    onlyFrom?: boolean;
    maxDist?: number;
    rolls?: RollInput[];
    aligned?: boolean;
    hand?: ResourceBag;
    opponentKnown?: ResourceBag;
    opponentUnknown?: number;
  } = {}
): RankedEdge | undefined {
  return rankEdges(board, placements, me, opts)[0];
}

let winCache: { key: string; rolls: number; pct: number } | undefined;

function prodsOf(ctx: BoardContext, at: string, weight: number): SimProd[] {
  const corner = ctx.byAt.get(at);
  if (!corner) return [];
  const out: SimProd[] = [];
  for (const id of corner.hexIds) {
    const hex = ctx.hexById.get(id);
    if (hex?.resource && hex.number) out.push({ resource: hex.resource, number: hex.number, weight });
  }
  return out;
}

function simSide(ctx: BoardContext, placements: Placements, me: string, vp: number, hand?: ResourceBag, ratios?: ResourceBag): SimPlayer {
  const mine = (owner: string) => owner === me;
  const spots: Array<{ at: string; city: boolean }> = [];
  for (const [at, owner] of placements.settlements) if (mine(owner)) spots.push({ at, city: false });
  for (const [at, owner] of placements.cities) if (mine(owner)) spots.push({ at, city: true });
  const p = newPlayer({ vp: Math.max(vp, spots.length || 2) });
  if (hand) for (const r of RESOURCES) p.hand[r] = hand[r] ?? 0;
  if (ratios) {
    for (const r of RESOURCES) if (ratios[r]) p.ratios[r] = ratios[r]!;
  }
  p.buildings = spots.map((s) => {
    const prods = prodsOf(ctx, s.at, s.city ? 2 : 1);
    return { prods, pip: pipOf(prods), city: s.city };
  });
  p.vp = Math.max(vp, p.buildings.reduce((s, b) => s + (b.city ? 2 : 1), 0));
  for (const s of spots) applyPort(p, ctx.byAt.get(s.at)?.port);
  const roots = spots.map((s) => s.at);
  const dist = roadDistance(ctx, placements, mine);
  const taken = new Set([...placements.settlements.keys(), ...placements.cities.keys()]);
  const expansions = [];
  for (const c of ctx.corners) {
    if (!isLegal(ctx, c.at, taken)) continue;
    const roads = roots.length ? dist.get(c.at) ?? 9 : 4;
    if (roads < 1 || roads > 4) continue;
    const prods = prodsOf(ctx, c.at, 1);
    const port = c.port;
    expansions.push({ prods, pip: pipOf(prods) + (port === "any" ? 3 : port ? 2 : 0), roads, port, at: c.at });
  }
  expansions.sort((a, b) => payValue(b.prods, b.roads, b.port) - payValue(a.prods, a.roads, a.port));
  p.expansions = expansions.slice(0, 3);
  if (!p.buildings.length) p.vp = vp;
  return p;
}

export function positionWin(
  board: Board,
  placements: Placements,
  me: string,
  opts: { hand?: ResourceHand | ResourceBag; myVp: number; hisVp: number; ratios?: ResourceHand | ResourceBag; rollCount: number }
): number {
  const key = JSON.stringify([
    [...placements.settlements],
    [...placements.cities],
    [...placements.roads],
    me,
    opts.hand,
    opts.myVp,
    opts.hisVp,
    opts.ratios
  ]);
  if (winCache && winCache.key === key && opts.rollCount >= winCache.rolls && opts.rollCount - winCache.rolls < 2) return winCache.pct;
  const ctx = contextFor(board);
  const mine = simSide(ctx, placements, me, opts.myVp, opts.hand, opts.ratios);
  const oppId = [...placements.settlements.values(), ...placements.cities.values()].find((owner) => owner !== me) ?? "opp";
  const opp = simSide(ctx, placements, oppId, opts.hisVp);
  const pct = Math.round(race(mine, opp, { seed: 11, trials: 8, maxTurns: 36 }).a.win * 100);
  winCache = { key, rolls: opts.rollCount, pct };
  return pct;
}
