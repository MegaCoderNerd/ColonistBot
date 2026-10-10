// Recovered from content.js (lines 501-712)
import { COLONIST_1V1_RULES, type GameRules } from "./rules";
import { RESOURCES, type GameEvent, type Resource, type ResourceBag, type ResourceHand } from "./types";
import type { PanelSnapshot } from "../shared/schema";

export const COSTS: Record<"road" | "settlement" | "city" | "dev", ResourceBag> = {
  road: { brick: 1, lumber: 1 },
  settlement: { brick: 1, lumber: 1, wool: 1, grain: 1 },
  city: { grain: 2, ore: 3 },
  dev: { ore: 1, wool: 1, grain: 1 }
};

export const emptyHand = (): ResourceHand => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
export const handTotal = (h: ResourceHand): number => RESOURCES.reduce((s, r) => s + h[r], 0);

// [RECONSTRUCTED TYPE DECLARATIONS]
export type Affordability = "yes" | "maybe" | "no";

export interface TrackedPlayer {
  hand: ResourceHand;
  unknown: number;
  unknownLoss: number;
  devBought: number;
  devPlayed: number;
  knights: number;
  panelCards?: number;
  warnings: string[];
}

export interface PlayerHandView {
  name: string;
  hand: ResourceHand;
  unknown: number;
  total: number;
  panelCards?: number;
  delta: number;
  synced?: boolean;
  exact?: boolean;
  devBought: number;
  devPlayed: number;
  devUnplayed: number;
  knights: number;
  afford: Record<"road" | "settlement" | "city" | "dev", Affordability>;
  discardOnSeven: number;
  stealOdds: Record<Resource, number>;
  warnings: string[];
}

export function canPay(hand: ResourceHand, unknown: number, cost: ResourceBag): Affordability {
  let missing = 0;
  for (const r of RESOURCES) missing += Math.max(0, (cost[r] ?? 0) - hand[r]);
  if (missing === 0) return "yes";
  return missing <= unknown ? "maybe" : "no";
}

export class HandTracker {
  players = new Map<string, TrackedPlayer>();
  rules: GameRules;
  rolls = 0;
  roadBuildingLeft = new Map<string, number>();

  constructor(rules: GameRules = COLONIST_1V1_RULES) {
    this.rules = rules;
  }

  ensure(name: string): TrackedPlayer {
    let p = this.players.get(name);
    if (!p) {
      p = { hand: emptyHand(), unknown: 0, unknownLoss: 0, devBought: 0, devPlayed: 0, knights: 0, warnings: [] };
      this.players.set(name, p);
    }
    return p;
  }

  names(): string[] {
    return [...this.players.keys()];
  }

  add(name: string, cards: ResourceBag | undefined, sign: 1 | -1, why: string) {
    if (!cards) return;
    const p = this.ensure(name);
    for (const r of RESOURCES) {
      const n = cards[r] ?? 0;
      if (!n) continue;
      if (sign === 1) p.hand[r] += n;
      else {
        if (p.hand[r] < n) {
          const short = n - p.hand[r];
          const covered = Math.min(short, p.unknown);
          p.unknown -= covered;
          if (short > covered) p.warnings.push(`${why}: log says ${name} spent ${n} ${r} but only ${p.hand[r] + covered} were tracked`);
          p.hand[r] = 0;
        } else p.hand[r] -= n;
      }
    }
  }

  apply(e: GameEvent) {
    switch (e.type) {
      case "roll":
        if (e.player) this.ensure(e.player);
        this.rolls++;
        this.roadBuildingLeft.clear();
        break;
      case "gain":
        this.add(e.player, e.cards, 1, "gain");
        break;
      case "build": {
        this.ensure(e.player);
        if (e.setup) break;
        if (e.piece === "road" && e.free) break;
        this.add(e.player, COSTS[e.piece], -1, `build ${e.piece}`);
        break;
      }
      case "devBuy": {
        this.add(e.player, COSTS.dev, -1, "development card");
        this.ensure(e.player).devBought++;
        break;
      }
      case "devPlay": {
        const p = this.ensure(e.player);
        p.devPlayed++;
        if (e.card === "knight") p.knights++;
        break;
      }
      case "bankTrade":
        this.add(e.player, e.gave, -1, "bank trade");
        this.add(e.player, e.got, 1, "bank trade");
        break;
      case "trade":
        this.add(e.player, e.gave, -1, "trade");
        this.add(e.player, e.got, 1, "trade");
        if (e.partner) {
          this.add(e.partner, e.got, -1, "trade");
          this.add(e.partner, e.gave, 1, "trade");
        }
        break;
      case "discard":
        this.add(e.player, e.cards, -1, "discard");
        break;
      case "steal": {
        if (!e.victim) break;
        if (e.card) {
          this.add(e.victim, { [e.card]: 1 }, -1, "steal");
          this.add(e.player, { [e.card]: 1 }, 1, "steal");
        } else {
          const victim = this.ensure(e.victim);
          if (victim.unknown > 0) victim.unknown--;
          else victim.unknownLoss++;
          this.ensure(e.player).unknown++;
        }
        break;
      }
      case "monopoly": {
        const thief = this.ensure(e.player);
        for (const r of RESOURCES) {
          const n = e.cards[r] ?? 0;
          if (!n) continue;
          let taken = 0;
          for (const [name, p] of this.players) {
            if (name === e.player) continue;
            taken += p.hand[r];
            p.hand[r] = 0;
          }
          if (taken !== n) thief.warnings.push(`Monopoly took ${n} ${r} but the tracker expected ${taken}`);
          thief.hand[r] += n;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Manual correction from the overlay. */
  adjust(name: string, resource: Resource, delta: number) {
    const p = this.ensure(name);
    p.hand[resource] = Math.max(0, p.hand[resource] + delta);
  }

  /** Converts unexplained cards into a known resource, for example after the user spots a missed row. */
  resolveUnknown(name: string, resource: Resource) {
    const p = this.ensure(name);
    if (p.unknown > 0) {
      p.unknown--;
      p.hand[resource]++;
    }
  }

  setPanelCards(name: string, cards: number | undefined) {
    this.ensure(name).panelCards = cards;
  }

  clearWarnings(name: string) {
    this.ensure(name).warnings = [];
  }

  view(name: string): PlayerHandView {
    const p = this.ensure(name);
    const total = handTotal(p.hand) + p.unknown;
    const delta = p.panelCards === undefined ? 0 : p.panelCards - total;
    const odds = {} as Record<Resource, number>;
    for (const r of RESOURCES) odds[r] = total ? p.hand[r] / total : 0;
    return {
      name,
      hand: { ...p.hand },
      unknown: p.unknown,
      total,
      panelCards: p.panelCards,
      delta,
      synced: p.panelCards === undefined ? undefined : delta === 0,
      devBought: p.devBought,
      devPlayed: p.devPlayed,
      devUnplayed: Math.max(0, p.devBought - p.devPlayed),
      knights: p.knights,
      afford: {
        road: canPay(p.hand, p.unknown, COSTS.road),
        settlement: canPay(p.hand, p.unknown, COSTS.settlement),
        city: canPay(p.hand, p.unknown, COSTS.city),
        dev: canPay(p.hand, p.unknown, COSTS.dev)
      },
      discardOnSeven: total > this.rules.discardLimit ? Math.floor(total / 2) : 0,
      stealOdds: odds,
      warnings: [...p.warnings]
    };
  }

  views(): PlayerHandView[] {
    return this.names().map((n) => this.view(n));
  }

  /** Persistable copy. */
  toJSON() {
    return {
      players: Object.fromEntries(
        [...this.players].map(([name, p]) => [
          name,
          { hand: p.hand, unknown: p.unknown, unknownLoss: p.unknownLoss, devBought: p.devBought, devPlayed: p.devPlayed, knights: p.knights }
        ])
      )
    };
  }

  static restore(saved: ReturnType<HandTracker["toJSON"]>, rules?: GameRules): HandTracker {
    const t = new HandTracker(rules);
    for (const [name, s] of Object.entries(saved.players)) {
      const p = t.ensure(name);
      p.hand = { ...emptyHand(), ...s.hand };
      p.unknown = s.unknown;
      p.unknownLoss = s.unknownLoss;
      p.devBought = s.devBought;
      p.devPlayed = s.devPlayed;
      p.knights = s.knights;
    }
    return t;
  }
}

export function panelCardsByName(snapshot: PanelSnapshot | undefined, names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!snapshot) return out;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const block of snapshot.players) {
    if (block.cards === undefined) continue;
    const name = sorted.find((n) => block.text.includes(n));
    if (name && !(name in out)) out[name] = block.cards;
  }
  return out;
}
