// Recovered from content.js (lines 2854-3217)
import { hexesAtCorner, pips } from "../replay";
import { assessSettlementRace, type RaceAssessment } from "./race";
import { ratesFromPlacements, resourcesImprovedByHarbor } from "./ports";
import { contextFor, isLegal, occupiedMap, portReportFor, profileOf, roadDistance, scoreSpot, type BoardContext } from "../strategy";
import { RESOURCES, type Board, type DevCardKind, type GameEvent, type Placements, type PortKind, type Resource, type ResourceBag, type ResourceHand } from "../types";
import { roadToward } from "./roads";
import { bagSwing, bestEdge } from "./value";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface DieRead {
  weight: Record<number, number>;
  rolls: number;
  aligned: boolean;
  bagLeft: number;
  note: string;
}

export interface PlayerTableRead {
  id: string;
  produced: ResourceHand;
  spent: ResourceHand;
  likely: ResourceHand;
  unknownCards: number;
  handSize: number;
  devsBought: number;
  devsPlayed: DevCardKind[];
  devsHidden: number;
  knights: number;
  did: string[];
}

export interface TableRead {
  dice: DieRead;
  me?: PlayerTableRead;
  opp?: PlayerTableRead;
  hexPaid: Map<string, { resource: Resource; number: number; by: Record<string, number> }>;
  partial: boolean;
  sevens?: string;
}

export interface RankedLiveSpot {
  at: string;
  dist: number;
  step?: { edge: string; dist: number };
  pips: number;
  numbers: number[];
  port?: PortKind;
  pipsBy: ResourceHand;
  value: number;
  tags: string[];
  reason: string;
  race?: RaceAssessment;
}

const LABEL: Record<Resource, string> = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };
const FACE: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
const SPEND: Record<"road" | "settlement" | "city" | "dev", ResourceBag> = {
  road: { lumber: 1, brick: 1 },
  settlement: { lumber: 1, brick: 1, wool: 1, grain: 1 },
  city: { grain: 2, ore: 3 },
  dev: { wool: 1, grain: 1, ore: 1 }
};
const emptyRes = (): ResourceHand => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });

export function bagAligned(completedTurns: number | undefined, rollCount: number): boolean {
  if (rollCount < 1) return completedTurns === undefined || completedTurns <= 0;
  if (completedTurns === undefined) return false;
  return Math.abs(completedTurns - rollCount) <= 2;
}

export function dieRead(rolls: number[], aligned: boolean): DieRead {
  const weight: Record<number, number> = {};
  for (let n = 2; n <= 12; n++) weight[n] = 1;
  const into = rolls.length % 24;
  const cycle = !aligned || rolls.length === 0 || into === 0 ? [] : rolls.slice(-into);
  const seen = new Array<number>(13).fill(0);
  for (const n of cycle) if (n >= 2 && n <= 12) seen[n]++;
  const bagLeft = 36 - cycle.length;
  const confidence = aligned ? Math.min(1, cycle.length / 16) : 0;
  const due: number[] = [];
  const cold: number[] = [];
  for (let n = 2; n <= 12; n++) {
    if (n === 7) continue;
    const fair = FACE[n] / 36;
    const left = Math.max(0, FACE[n] - seen[n]);
    const hat = bagLeft > 0 ? left / bagLeft : fair;
    const raw = 1 + confidence * (hat / fair - 1);
    weight[n] = Math.min(1.65, Math.max(0.55, raw));
    if (confidence >= 0.45 && weight[n] >= 1.28) due.push(n);
    if (confidence >= 0.45 && weight[n] <= 0.78) cold.push(n);
  }
  const note = [
    cold.length
      ? `${cold.join(" and ")} ${cold.length === 1 ? "has" : "have"} already rolled ${cold.length === 1 ? "its" : "their"} share, so ${cold.length === 1 ? "it is" : "they are"} worth less until the bag restarts`
      : "",
    due.length ? `${due.join(" and ")} ${due.length === 1 ? "is" : "are"} still due` : ""
  ]
    .filter(Boolean)
    .join(". ");
  return { weight, rolls: rolls.length, aligned, bagLeft, note: note ? `${note}.` : "" };
}

export function readTable(
  board: Board,
  events: GameEvent[],
  me: string,
  opts: {
    handSize?: Record<string, number>;
    devsInHand?: Record<string, number>;
    knights?: Record<string, number>;
    completedTurns?: number;
  } = {}
): TableRead {
  const rolls = events.filter((e): e is Extract<GameEvent, { type: "roll" }> => e.type === "roll").map((e) => e.total);
  const aligned = bagAligned(opts.completedTurns, rolls.length);
  const dice = dieRead(rolls, aligned);
  const produced = new Map<string, ResourceHand>();
  const spent = new Map<string, ResourceHand>();
  const bought = new Map<string, number>();
  const played = new Map<string, DevCardKind[]>();
  const did = new Map<string, string[]>();
  const handSize = new Map<string, number>(Object.entries(opts.handSize ?? {}));
  const buildings = new Map<string, { player: string; piece: "settlement" | "city" }>();
  const hexPaid = new Map<string, { resource: Resource; number: number; by: Record<string, number> }>();
  let robber = board.robberStart;
  const ensure = (id: string) => {
    if (!produced.has(id)) produced.set(id, emptyRes());
    if (!spent.has(id)) spent.set(id, emptyRes());
    return id;
  };
  const pay = (id: string, cost: ResourceBag) => {
    const bag = spent.get(ensure(id))!;
    for (const r of RESOURCES) bag[r] += cost[r] ?? 0;
  };
  const note = (id: string, text: string) => {
    const list = did.get(id) ?? [];
    const roads = /^built (\d+) roads$/.exec(list[list.length - 1] ?? "");
    if (text === "built a road" && roads) list[list.length - 1] = `built ${Number(roads[1]) + 1} roads`;
    else if (text === "built a road" && list[list.length - 1] === "built a road") list[list.length - 1] = "built 2 roads";
    else list.push(text);
    did.set(id, list.slice(-4));
  };
  const spotText = (at?: string) => {
    if (!at) return "";
    const hexes = hexesAtCorner(board, at).filter((h) => h.number);
    return hexes.map((h) => h.number).join("/");
  };
  for (const e of events) {
    if (e.type === "build" && e.at && e.piece !== "road") {
      buildings.set(e.at, { player: e.player, piece: e.piece === "city" ? "city" : "settlement" });
      if (!e.setup && !e.free) pay(e.player, SPEND[e.piece]);
      if (!e.setup) note(e.player, e.piece === "city" ? `citied ${spotText(e.at) || "a spot"}` : `settled ${spotText(e.at) || "a spot"}`);
    } else if (e.type === "build" && e.piece === "road") {
      if (!e.setup && !e.free) pay(e.player, SPEND.road);
      if (!e.setup) note(e.player, "built a road");
    } else if (e.type === "devBuy") {
      pay(e.player, SPEND.dev);
      bought.set(e.player, (bought.get(e.player) ?? 0) + 1);
      note(e.player, "bought a dev card");
    } else if (e.type === "devPlay") {
      const list = played.get(e.player) ?? [];
      list.push(e.card);
      played.set(e.player, list);
      note(
        e.player,
        e.card === "unknown"
          ? "played a dev card"
          : `played ${e.card === "victoryPoint" ? "a victory point" : e.card === "yearOfPlenty" ? "Year of Plenty" : e.card === "roadBuilding" ? "Road Building" : e.card === "monopoly" ? "Monopoly" : "a knight"}`
      );
    } else if (e.type === "hand") {
      handSize.set(e.player, e.size);
    } else if (e.type === "robberMove" && e.hex) {
      robber = e.hex;
      const hex = board.hexes.find((h) => h.id === e.hex);
      if (hex?.number && hex.resource) note(e.player, `robbed the ${hex.number} ${LABEL[hex.resource]}`);
    } else if (e.type === "roll" && e.total !== 7) {
      for (const [at, b] of buildings) {
        for (const hex of hexesAtCorner(board, at)) {
          if (!hex.resource || hex.number !== e.total || hex.id === robber) continue;
          const n = b.piece === "city" ? 2 : 1;
          produced.get(ensure(b.player))![hex.resource] += n;
          const paid = hexPaid.get(hex.id) ?? { resource: hex.resource, number: hex.number, by: {} };
          paid.by[b.player] = (paid.by[b.player] ?? 0) + n;
          hexPaid.set(hex.id, paid);
        }
      }
    }
  }
  const ids = new Set([...produced.keys(), ...spent.keys(), ...Object.keys(opts.handSize ?? {}), me]);
  const player = (id: string): PlayerTableRead => {
    const got = produced.get(id) ?? emptyRes();
    const used = spent.get(id) ?? emptyRes();
    const ledger = emptyRes();
    let unseen = 0;
    for (const r of RESOURCES) {
      const net = got[r] - used[r];
      if (net >= 0) ledger[r] = net;
      else unseen += -net;
    }
    const size = handSize.get(id);
    const sum = RESOURCES.reduce((s, r) => s + ledger[r], 0);
    const likely = emptyRes();
    let unknown = 0;
    if (unseen > sum) {
      unknown = size ?? unseen;
    } else if (size === undefined) {
      for (const r of RESOURCES) likely[r] = ledger[r];
      unknown = unseen;
    } else if (sum > size) {
      const scale = size / sum;
      for (const r of RESOURCES) likely[r] = Math.round(ledger[r] * scale);
    } else {
      for (const r of RESOURCES) likely[r] = ledger[r];
      unknown = size - sum;
    }
    const plays = played.get(id) ?? [];
    const hidden = Math.max(0, opts.devsInHand?.[id] ?? Math.max(0, (bought.get(id) ?? 0) - plays.length));
    return {
      id,
      produced: got,
      spent: used,
      likely,
      unknownCards: Math.max(0, unknown),
      handSize: size ?? sum,
      devsBought: bought.get(id) ?? 0,
      devsPlayed: plays,
      devsHidden: hidden,
      knights: Math.max(opts.knights?.[id] ?? 0, plays.filter((c) => c === "knight").length),
      did: did.get(id) ?? []
    };
  };
  const oppId = [...ids].filter((id) => id !== me).sort((a, b) => (handSize.get(b) ?? 0) - (handSize.get(a) ?? 0))[0];
  const named = events.filter((e): e is Extract<GameEvent, { type: "roll" }> => e.type === "roll" && e.total === 7 && Boolean(e.player));
  const mySevens = named.filter((e) => e.player === me).length;
  const hisSevens = named.length - mySevens;
  const sevens =
    named.length >= 2 && Math.abs(mySevens - hisSevens) >= 2
      ? hisSevens > mySevens
        ? `He has rolled ${hisSevens} sevens and you have rolled ${mySevens}.`
        : `You have rolled ${mySevens} sevens and he has rolled ${hisSevens}.`
      : undefined;
  return {
    dice,
    me: ids.has(me) ? player(me) : undefined,
    opp: oppId ? player(oppId) : undefined,
    hexPaid,
    partial: !aligned && rolls.length > 0,
    sevens
  };
}

const COST: Record<"settlement" | "city", ResourceBag> = {
  settlement: { lumber: 1, brick: 1, wool: 1, grain: 1 },
  city: { grain: 2, ore: 3 }
};

export function canBuild(hand: ResourceHand, kind: "settlement" | "city"): boolean {
  const cost = COST[kind];
  return RESOURCES.every((r) => hand[r] >= (cost[r] ?? 0));
}

export function situationBrief(read: TableRead, knownHand?: { hand: ResourceHand; unknown: number }): string {
  const o = read.opp;
  if (!o && !knownHand) return read.dice.note;
  const parts: string[] = [];
  if (read.sevens) parts.push(read.sevens);
  if (o && read.partial && !knownHand && (o.did.length || RESOURCES.some((r) => o.produced[r] > 0))) parts.push("Since this tab connected:");
  if (o && o.knights >= 2)
    parts.push(`He has played ${o.knights} knights${o.devsHidden ? ` and holds ${o.devsHidden} hidden dev card${o.devsHidden === 1 ? "" : "s"}` : ""}. One more knight takes the largest army.`);
  else if (o && o.devsHidden >= 2) parts.push(`He holds ${o.devsHidden} dev cards. About one in five is a hidden point, so he is closer than the buildings show.`);
  if (knownHand) {
    const named = RESOURCES.filter((r) => knownHand.hand[r] > 0).map((r) => `${knownHand.hand[r]} ${LABEL[r]}`);
    const builds = (["city", "settlement"] as const).filter((k) => knownHand.unknown === 0 && canBuild(knownHand.hand, k));
    const hold = named.length ? named.join(", ") : "nothing we can name";
    const extra = knownHand.unknown > 0 ? ` ${knownHand.unknown} more ${knownHand.unknown === 1 ? "card is" : "cards are"} still unknown.` : "";
    const able = builds.length
      ? ` He can pay for ${builds.map((k) => (k === "city" ? "a city" : "a settlement")).join(" and ")} right now.`
      : knownHand.unknown === 0
        ? " He cannot city or settle with that."
        : "";
    parts.push(`He holds ${hold}.${extra}${able}`);
  } else if (o) {
    const known = RESOURCES.reduce((s, r) => s + o.likely[r], 0);
    const rich = RESOURCES.filter((r) => o.likely[r] >= 2).sort((a, b) => o.likely[b] - o.likely[a]);
    if (o.handSize >= 3 && rich.length && known >= o.unknownCards) {
      const named = rich
        .slice(0, 2)
        .map((r) => `${Math.round(o.likely[r])} ${LABEL[r]}`)
        .join(" and ");
      parts.push(
        `His hand of ${o.handSize} is likely heavy in ${named}, from what his buildings were paid minus what he spent.${o.unknownCards ? ` ${o.unknownCards} card${o.unknownCards === 1 ? "" : "s"} came from trades or steals and ${o.unknownCards === 1 ? "is" : "are"} unknown.` : ""}`
      );
    }
  }
  const hot = o
    ? [...read.hexPaid.entries()]
        .map(([id, h]) => ({ id, ...h, cards: h.by[o.id] ?? 0 }))
        .filter((h) => h.cards >= 3 && (read.dice.weight[h.number] ?? 1) >= 0.85)
        .sort((a, b) => b.cards - a.cards)[0]
    : undefined;
  if (hot)
    parts.push(
      `The ${hot.number} ${LABEL[hot.resource]} has paid him ${hot.cards} cards${(read.dice.weight[hot.number] ?? 1) >= 1.15 ? " and that number is still due" : ""}. That is the robber hex when you can move it.`
    );
  if (o && o.did.length) parts.push(`His recent plays: ${o.did.slice(-3).join(", ")}.`);
  if (read.dice.note) parts.push(read.dice.note);
  const body = parts.filter((p) => p !== "Since this tab connected:");
  if (!body.length) return "";
  const text = body.slice(0, 3).join(" ");
  if (!parts.includes("Since this tab connected:")) return text;
  return `Since this tab connected, ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

export function holdingResource(read: TableRead): Resource | undefined {
  const o = read.opp;
  if (!o || o.handSize < 3) return undefined;
  const known = RESOURCES.reduce((s, r) => s + o.likely[r], 0);
  if (known < o.unknownCards) return undefined;
  return RESOURCES.filter((r) => o.likely[r] >= 2).sort((a, b) => o.likely[b] - o.likely[a])[0];
}

export function cityPick(
  ctx: BoardContext,
  board: Board,
  placements: Placements,
  me: string,
  weight: Record<number, number>
): { at: string; name: string; gain: number } | undefined {
  let best: { at: string; name: string; gain: number } | undefined;
  for (const [at, owner] of placements.settlements) {
    if (owner !== me) continue;
    const corner = ctx.byAt.get(at);
    if (!corner) continue;
    let gain = 0;
    let ore = false;
    let wheat = false;
    for (const hex of hexesAtCorner(board, at)) {
      if (!hex.resource || hex.number === null) continue;
      const pip = pips(hex.number) * (weight[hex.number] ?? 1);
      if (hex.resource === "ore") {
        ore = true;
        gain += pip * 2.4;
      } else if (hex.resource === "grain") {
        wheat = true;
        gain += pip * 2.2;
      } else gain += pip * 0.35;
    }
    if (ore && wheat) gain += 6;
    const name = `${corner.numbers.join("/")} (${corner.pips} pips${ore && wheat ? ", ore and wheat" : ""})`;
    if (!best || gain > best.gain) best = { at, name, gain };
  }
  return best;
}

export function rankLiveSpots(
  board: Board,
  placements: Placements,
  me: string,
  events: GameEvent[] = [],
  opts: {
    handSize?: Record<string, number>;
    devsInHand?: Record<string, number>;
    knights?: Record<string, number>;
    completedTurns?: number;
    myHand?: ResourceHand;
    opponentKnown?: ResourceHand;
    opponentUnknown?: number;
  } = {}
): { spots: RankedLiveSpot[]; read: TableRead } {
  const read = readTable(board, events, me, opts);
  const ctx = contextFor(board);
  const built = occupiedMap(placements);
  const taken = new Set(built.keys());
  const own = profileOf(ctx, placements, (o) => o === me);
  const his = profileOf(ctx, placements, (o) => o !== me);
  const mine = roadDistance(ctx, placements, (o) => o === me);
  const hisReach = roadDistance(ctx, placements, (o) => o !== me);
  const myRates = portReportFor(ctx, placements, me).rates.rates;
  const hisRates = ratesFromPlacements(ctx, placements, (owner) => owner !== me);
  const hisBest = new Set(
    ctx.corners
      .filter((c) => isLegal(ctx, c.at, taken))
      .map((c) => ({ at: c.at, value: scoreSpot(ctx, c, his, taken, hisRates).value, dist: hisReach.get(c.at) ?? 99 }))
      .filter((s) => s.dist <= 2)
      .sort((a, b) => b.value - a.value)
      .slice(0, 2)
      .map((s) => s.at)
  );
  const seenRolls = events.filter((e): e is Extract<GameEvent, { type: "roll" }> => e.type === "roll").map((e) => e.total);
  const spots: RankedLiveSpot[] = [];
  for (const c of ctx.corners) {
    if (!isLegal(ctx, c.at, taken)) continue;
    const step = roadToward(board, placements, me, c.at);
    const dist = step ? step.dist : mine.get(c.at) === 0 ? 0 : 99;
    if (dist >= 99) continue;
    const scored = scoreSpot(ctx, c, own, taken, myRates);
    const pipsBy = emptyRes();
    for (const id of c.hexIds) {
      const hex = ctx.hexById.get(id);
      if (hex?.resource && hex.number !== null) pipsBy[hex.resource] += pips(hex.number);
    }
    const tags = [...scored.tags];
    let value = scored.value;
    let diceNote = "";
    for (const id of c.hexIds) {
      const hex = ctx.hexById.get(id);
      if (!hex?.resource || hex.number === null) continue;
      const mult = read.dice.weight[hex.number] ?? 1;
      value += pips(hex.number) * (mult - 1) * ctx.resWeight[hex.resource];
      if (read.dice.aligned && mult >= 1.28) diceNote = `${hex.number} is due`;
      else if (read.dice.aligned && mult <= 0.78 && !diceNote) diceNote = `${hex.number} is cold`;
    }
    if (diceNote) tags.push(diceNote);
    const distinct = new Set(c.numbers);
    if (distinct.size === 1 && c.pips >= 8) value -= (read.dice.weight[c.numbers[0]] ?? 1) > 1.1 ? 0.25 : 0.7;
    else if (distinct.size >= 2 && c.pips >= 7) value += 0.35;
    const hd = hisReach.get(c.at);
    const hisScore = scoreSpot(ctx, c, his, taken, hisRates).value;
    const race = assessSettlementRace({
      myRoads: dist,
      opponentRoads: hd,
      myProduction: own,
      opponentProduction: his,
      myHand: opts.myHand,
      opponentKnown: opts.opponentKnown,
      opponentUnknown: opts.opponentUnknown,
      myRates,
      opponentRates: hisRates,
      portImproves: Boolean(c.port && resourcesImprovedByHarbor(myRates, c.port).length > 0),
      weActFirst: true
    });
    value += race.adjustment;
    if (race.lost) tags.push("he can take it first");
    else if (race.possibleThreat) tags.push("he might contest it");
    else if (race.urgent) tags.push("take it before he can");
    else if (hd !== undefined && hd <= 2 && dist <= hd && hisScore >= 9) {
      value += Math.min(3.2, 0.22 * hisScore);
      tags.push("takes a spot he wants");
    }
    if (hisBest.has(c.at) && dist <= (hd ?? 99)) tags.push("his next spot");
    for (const r of c.resources) {
      if (his[r] === 0 && own[r] < 6 && c.resources.includes(r)) {
        const onSpot = c.hexIds.some((id) => ctx.hexById.get(id)?.resource === r && pips(ctx.hexById.get(id)?.number ?? null) >= 3);
        if (onSpot) {
          value += 1.15;
          tags.push(`denies him ${LABEL[r]}`);
          break;
        }
      }
    }
    for (const id of c.hexIds) {
      const paid = read.hexPaid.get(id);
      const cards = paid && read.opp ? paid.by[read.opp.id] ?? 0 : 0;
      if (paid && cards >= 3) {
        value += Math.min(1.6, 0.25 * cards);
        tags.push(`sits on the ${paid.number} ${LABEL[paid.resource]} that paid him ${cards}`);
        break;
      }
    }
    value += bagSwing(c.numbers, read.dice.aligned ? seenRolls : [], read.dice.aligned);
    const useful = tags.filter((t) => /denies|his next|paid him|due|cold|port|ore \+ wheat|adds |no wheat/.test(t)).slice(0, 2);
    const away = dist === 0 ? "your road already reaches it" : dist === 1 ? "one road away" : `${dist} roads away`;
    const lead =
      c.resources.includes("ore") && c.resources.includes("grain")
        ? "Ore and wheat"
        : c.resources.includes("grain")
          ? "Wheat, short of ore"
          : c.resources.includes("ore")
            ? "Ore, short of wheat"
            : "No wheat or ore";
    spots.push({
      at: c.at,
      dist,
      step,
      pips: c.pips,
      numbers: c.numbers,
      port: c.port,
      pipsBy,
      value,
      tags,
      reason: [lead, `${c.pips} pips on ${c.numbers.join("/")}`, ...useful, away].join(", ") + ".",
      race
    });
  }
  spots.sort((a, b) => b.value - a.value);
  for (const spot of spots.slice(0, 8)) {
    if (spot.dist > 2) continue;
    const leave = bestEdge(board, placements, me, {
      from: spot.at,
      onlyFrom: true,
      maxDist: 2,
      rolls: seenRolls,
      aligned: read.dice.aligned,
      hand: opts.myHand,
      opponentKnown: opts.opponentKnown,
      opponentUnknown: opts.opponentUnknown
    });
    if (!leave || leave.dead) spot.value -= 4;
    else spot.value += Math.min(2, Math.max(0, leave.score) * 0.04);
  }
  spots.sort((a, b) => b.value - a.value);
  return { spots, read };
}

export function chooseSettlement(
  spots: RankedLiveSpot[],
  roadRich: boolean
): { now?: RankedLiveSpot; toward?: RankedLiveSpot; alt?: RankedLiveSpot; skipped?: RankedLiveSpot } {
  const tempo = roadRich ? 1.05 : 2.05;
  const maxDist = roadRich ? 5 : 3;
  const open = spots.filter((s) => s.dist >= 1 && s.dist <= maxDist).sort((a, b) => b.value - tempo * b.dist - (a.value - tempo * a.dist));
  const toward = open[0];
  const alt = open[1];
  const here = spots.filter((s) => s.dist === 0).sort((a, b) => b.value - a.value)[0];
  const good = (s: RankedLiveSpot) => s.pips >= 7 || s.value >= 14 || (s.port !== undefined && s.port !== "any" && s.pips >= 4);
  if (here && good(here)) {
    const hereScore = here.value + 1;
    const towardScore = toward ? toward.value - tempo * toward.dist : -Infinity;
    if (hereScore >= towardScore) return { now: here, toward, alt, skipped: undefined };
  }
  return { toward, alt, skipped: here && toward && here.at !== toward.at ? here : undefined };
}

export function worthTheRoad(spot: RankedLiveSpot, own: ResourceHand): boolean {
  if (spot.race?.lost) return false;
  const precious = own.lumber < 3 && own.brick < 3;
  const freshLumber = own.lumber < 3 ? spot.pipsBy.lumber : 0;
  const freshBrick = own.brick < 3 ? spot.pipsBy.brick : 0;
  const portMatch = spot.port !== undefined && spot.port !== "any" && own[spot.port] >= 4;
  if (!precious) return spot.pips >= 7 || portMatch || spot.value >= 12;
  if (spot.dist > 2) return false;
  if (portMatch) return true;
  return freshLumber >= 4 || freshBrick >= 4 || freshLumber + freshBrick >= 6;
}
