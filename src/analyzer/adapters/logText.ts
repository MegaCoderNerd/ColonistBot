// Recovered from content.js (lines 327-489)
import { RESOURCES, type DevCardKind, type GameEvent, type GameEventDraft, type PieceKind, type PlayerInfo, type Resource, type ResourceBag } from "../types";

const RESOURCE_WORDS: Array<[RegExp, Resource]> = [
  [/^(?:card[_-]?|res(?:ource)?[_-]?)?(lumber|wood|tree|forest)s?$/i, "lumber"],
  [/^(?:card[_-]?|res(?:ource)?[_-]?)?(brick|clay|hill)s?$/i, "brick"],
  [/^(?:card[_-]?|res(?:ource)?[_-]?)?(wool|sheep|pasture)s?$/i, "wool"],
  [/^(?:card[_-]?|res(?:ource)?[_-]?)?(grain|wheat|field)s?$/i, "grain"],
  [/^(?:card[_-]?|res(?:ource)?[_-]?)?(ore|stone|mountain)s?$/i, "ore"]
];

export function resourceCards(fragment: string): ResourceBag {
  const cards: ResourceBag = {};
  for (const token of fragment.split(/[^A-Za-z_-]+/)) {
    if (!token) continue;
    for (const [re, resource] of RESOURCE_WORDS) {
      if (re.test(token)) {
        cards[resource] = (cards[resource] ?? 0) + 1;
        break;
      }
    }
  }
  return cards;
}

export function firstResource(fragment: string): Resource | undefined {
  return RESOURCES.find((r) => (resourceCards(fragment)[r] ?? 0) > 0);
}

const CARD_NAMES: Array<[RegExp, DevCardKind]> = [
  [/knight|soldier/i, "knight"],
  [/year of plenty/i, "yearOfPlenty"],
  [/monopoly/i, "monopoly"],
  [/road building/i, "roadBuilding"],
  [/victory point|\bvp\b/i, "victoryPoint"]
];

export function cardFrom(text: string): DevCardKind | undefined {
  return CARD_NAMES.find(([re]) => re.test(text))?.[1];
}

const LEADING_ICON_PREFIX = /^(?:(?:bot(?!\s+is\b)|trophy|player|icon[_a-z0-9-]*)\s+)+/i;
const TRAILING_ICON_SUFFIX = /(?:\s+trophy)+$/i;

export function normalizeRow(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, " ")
    .replace(/\bPlayer avatar\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_ICON_PREFIX, "")
    .replace(TRAILING_ICON_SUFFIX, "")
    .trim();
}

const VIEWER = "You";
const NOISE = /\b(is blocked by the Robber|wants to give|proposed counter offer|Learn how to play|will take over|has disconnected|has reconnected|Bot is (?:placing|selecting))\b|\b(has left|have left|left the (game|room)|has joined|joined the (game|room)|disconnected|reconnected|rejoined|was kicked|votes?|spectat|is now ready|game (is )?starting)\b/i;
const CHAT = /^\S+:\s/;
const you = (name: string, me?: string) => (name && /^you$/i.test(name) ? me ?? VIEWER : name);

// [RECONSTRUCTED TYPE DECLARATIONS]
export type RowParseResult =
  | { kind: "ignored" }
  | { kind: "unparsed" }
  | { kind: "event"; draft: GameEventDraft; subject?: string };

export function parseRow(rawText: string, rolls: number, me?: string): RowParseResult {
  const text = normalizeRow(rawText);
  if (!text) return { kind: "ignored" };
  let m: RegExpExecArray | null;
  const event = (draft: GameEventDraft, subject?: string): RowParseResult => ({ kind: "event", draft, subject });
  const who = (name: string) => you(name, me);
  if (CHAT.test(text) || NOISE.test(text)) return { kind: "ignored" };
  if ((m = /^(\S+) rolled\b.*?dice[_ ]?([1-6])\D+dice[_ ]?([1-6])/i.exec(text))) {
    const d1 = Number(m[2]);
    const d2 = Number(m[3]);
    const actor = /^dice$/i.test(m[1]) ? undefined : who(m[1]);
    return event({ type: "roll", ...(actor ? { player: actor } : {}), d1, d2, total: d1 + d2 }, actor);
  }
  if ((m = /^(\S+) rolled\b\D{0,12}(\d{1,2})\b/i.exec(text)) && Number(m[2]) >= 2 && Number(m[2]) <= 12) {
    const actor = /^dice$/i.test(m[1]) ? undefined : who(m[1]);
    return event({ type: "roll", ...(actor ? { player: actor } : {}), total: Number(m[2]) }, actor);
  }
  if ((m = /^(\S+) (?:placed|built)\b.*?\b(road|settlement|city)\b/i.exec(text))) {
    return event({ type: "build", player: who(m[1]), piece: m[2].toLowerCase() as PieceKind, setup: rolls === 0 }, who(m[1]));
  }
  if ((m = /^(\S+) (?:upgraded|upgrade)\b.*\bcity\b/i.exec(text))) {
    return event({ type: "build", player: who(m[1]), piece: "city", setup: false }, who(m[1]));
  }
  if ((m = /^(\S+) bought\b.*\b(?:development|dev)\b/i.exec(text))) {
    return event({ type: "devBuy", player: who(m[1]) }, who(m[1]));
  }
  if ((m = /^(\S+) (?:used|played)\b(.*)$/i.exec(text))) {
    const card = cardFrom(m[2]);
    if (card) return event({ type: "devPlay", player: who(m[1]), card }, who(m[1]));
  }
  if ((m = /^(\S+) (?:moved|placed)\b.*\brobber\b/i.exec(text))) {
    return event({ type: "robberMove", player: who(m[1]) }, who(m[1]));
  }
  if ((m = /^(\S+) stole\s+(\d+)\b(.*)$/i.exec(text)) && !/\bfrom\b/i.test(m[3])) {
    const resource = firstResource(m[3]);
    if (resource) return event({ type: "monopoly", player: who(m[1]), cards: { [resource]: Number(m[2]) } }, who(m[1]));
  }
  if ((m = /^(\S+) stole\b(.*?)\bfrom (\S+)/i.exec(text))) {
    return event({ type: "steal", player: who(m[1]), victim: who(m[3]), card: firstResource(m[2]) }, who(m[1]));
  }
  if ((m = /^(\S+) gave bank\b(.*?)\band took\b(.*)$/i.exec(text)) || (m = /^(\S+) traded\b(.*?)\bwith the bank\b(.*)$/i.exec(text))) {
    return event({ type: "bankTrade", player: who(m[1]), gave: resourceCards(m[2]), got: resourceCards(m[3]) }, who(m[1]));
  }
  if ((m = /^(\S+) (?:traded|gave)\b(.*?)\b(?:and took|and got|for)\b(.*?)\b(?:with|from) (\S+)\s*$/i.exec(text))) {
    return event({ type: "trade", player: who(m[1]), partner: who(m[4]), gave: resourceCards(m[2]), got: resourceCards(m[3]) }, who(m[1]));
  }
  if ((m = /^(\S+) discarded\b(.*)$/i.exec(text))) {
    return event({ type: "discard", player: who(m[1]), cards: resourceCards(m[2]) }, who(m[1]));
  }
  if ((m = /\blongest road\b.*?\b(?:passed|transferred)\b.*?\bto (\S+)/i.exec(text))) {
    return event({ type: "longestRoad", player: who(m[1]) }, who(m[1]));
  }
  if ((m = /\blargest army\b.*?\b(?:passed|transferred)\b.*?\bto (\S+)/i.exec(text))) {
    return event({ type: "largestArmy", player: who(m[1]) }, who(m[1]));
  }
  if ((m = /^(\S+) .*\blongest road\b/i.exec(text)) && !/^(?:longest|largest)\b/i.test(m[1]) && /\b(?:received|took|got|has|claimed|gained)\b/i.test(text)) {
    return event({ type: "longestRoad", player: who(m[1]) }, who(m[1]));
  }
  if ((m = /^(\S+) .*\blargest army\b/i.exec(text)) && !/^(?:longest|largest)\b/i.test(m[1]) && /\b(?:received|took|got|has|claimed|gained)\b/i.test(text)) {
    return event({ type: "largestArmy", player: who(m[1]) }, who(m[1]));
  }
  if ((m = /^(\S+) won the game/i.exec(text))) {
    return event({ type: "gameEnd", winner: who(m[1]) }, who(m[1]));
  }
  if ((m = /^(\S+) took from bank\b(.*)$/i.exec(text))) {
    const cards = resourceCards(m[2]);
    if (Object.keys(cards).length) return event({ type: "gain", player: who(m[1]), cards, source: "other" }, who(m[1]));
  }
  if ((m = /^(\S+) (?:got|received)\b(.*)$/i.exec(text))) {
    const cards = resourceCards(m[2]);
    if (Object.keys(cards).length) return event({ type: "gain", player: who(m[1]), cards, source: "other" }, who(m[1]));
  }
  return { kind: "unparsed" };
}

export function unparsedKey(text: string): string {
  return text.replace(/^\S+/, "<player>").replace(/\d+/g, "#").slice(0, 120);
}

export class LogParser {
  events: GameEvent[] = [];
  players = new Map<string, PlayerInfo>();
  unparsed = new Map<string, { count: number; example: string }>();
  parsed = 0;
  ignored = 0;
  afterRoll = false;
  freeRoads = new Map<string, number>();
  rolls = 0;
  me?: string;

  constructor(me?: string) {
    this.me = me;
  }

  push(entry: { t: number; text: string }): { kind: "ignored" } | { kind: "unparsed" } | { kind: "event"; event: GameEvent } {
    const text = normalizeRow(entry.text);
    if (!text) return { kind: "ignored" };
    const result = parseRow(text, this.rolls, this.me);
    if (result.kind === "ignored") {
      this.ignored++;
      return result;
    }
    if (result.kind === "unparsed") {
      const key = unparsedKey(text);
      const prev = this.unparsed.get(key);
      this.unparsed.set(key, { count: (prev?.count ?? 0) + 1, example: prev?.example ?? text });
      this.afterRoll = false;
      return result;
    }
    this.parsed++;
    const draft = result.draft;
    if (draft.type === "roll") {
      this.rolls++;
      this.afterRoll = true;
    } else if (draft.type === "gain") {
      draft.source = this.afterRoll ? "roll" : "other";
    } else {
      this.afterRoll = false;
    }
    if (result.subject && !this.players.has(result.subject)) this.players.set(result.subject, { id: result.subject, name: result.subject });
    if (draft.type === "roll") this.freeRoads.clear();
    else if (draft.type === "devPlay" && draft.card === "roadBuilding") this.freeRoads.set(draft.player, 2);
    else if (draft.type === "build" && draft.piece === "road" && !draft.setup && (this.freeRoads.get(draft.player) ?? 0) > 0) {
      this.freeRoads.set(draft.player, (this.freeRoads.get(draft.player) ?? 0) - 1);
      draft.free = true;
    }
    const event: GameEvent = { ...draft, t: entry.t, turn: this.rolls };
    this.events.push(event);
    return { kind: "event", event };
  }

  stats() {
    const unparsedRows = [...this.unparsed.entries()].map(([text, v]) => ({ text, count: v.count, example: v.example })).sort((a, b) => b.count - a.count);
    const unparsed = unparsedRows.reduce((s, r) => s + r.count, 0);
    return { total: this.parsed + this.ignored + unparsed, parsed: this.parsed, ignored: this.ignored, unparsed, unparsedRows };
  }
}
