// Recovered from content.js (lines 714-846)
import { LogParser } from "../analyzer/adapters/logText";
import { COLONIST_1V1_RULES, type GameRules } from "../analyzer/rules";
import { HandTracker, panelCardsByName, type PlayerHandView } from "../analyzer/tracker";
import type { Resource } from "../analyzer/types";
import type { LogEntry, PanelSnapshot } from "../shared/schema";

const NO_INDEX_BASE = 1e9;

export class LiveEngine {
  rows = new Map<number, LogEntry>();
  parser: LogParser;
  tracker: HandTracker;
  lastIdx = -1;
  dirty = false;
  panel?: PanelSnapshot;
  adjustments = new Map<string, number>();
  me?: string;
  noIndex = 0;
  rules: GameRules;
  lastRowAt = 0;
  winner?: string;

  constructor(me?: string, rules: GameRules = COLONIST_1V1_RULES) {
    this.rules = rules;
    this.me = me;
    this.parser = new LogParser(me);
    this.tracker = new HandTracker(rules);
  }

  setMe(me?: string) {
    if (me && me !== this.me) {
      this.me = me;
      this.dirty = true;
    }
  }

  reset() {
    this.rows = new Map();
    this.adjustments = new Map();
    this.lastIdx = -1;
    this.noIndex = 0;
    this.winner = undefined;
    this.rebuildNow();
  }

  addEntry(entry: LogEntry) {
    if (entry.panel || !entry.text) return;
    const idx = entry.idx ?? NO_INDEX_BASE + this.noIndex++;
    if (this.rows.has(idx)) return;
    this.rows.set(idx, entry);
    this.lastRowAt = Date.now();
    if (this.dirty || idx < this.lastIdx) {
      this.dirty = true;
      return;
    }
    this.lastIdx = idx;
    this.applyRow(entry);
  }

  applyRow(entry: LogEntry) {
    const r = this.parser.push(entry);
    if (r.kind === "event") {
      this.tracker.apply(r.event);
      if (r.event.type === "gameEnd") this.winner = r.event.winner;
    }
  }

  rebuildNow() {
    this.parser = new LogParser(this.me);
    this.tracker = new HandTracker(this.rules);
    this.winner = undefined;
    const sorted = [...this.rows.entries()].sort((a, b) => a[0] - b[0]);
    for (const [idx, entry] of sorted) {
      this.applyRow(entry);
      this.lastIdx = idx;
    }
    for (const [key, delta] of this.adjustments) {
      const [name, resource] = key.split("|");
      this.tracker.adjust(name, resource as Resource, delta);
    }
    this.dirty = false;
    this.applyPanel();
  }

  setPanel(snapshot?: PanelSnapshot) {
    this.panel = snapshot;
    if (!this.dirty) this.applyPanel();
  }

  applyPanel() {
    const counts = panelCardsByName(this.panel, this.tracker.names());
    for (const name of this.tracker.names()) this.tracker.setPanelCards(name, counts[name]);
  }

  adjust(name: string, resource: Resource, delta: number) {
    if (this.dirty) this.rebuildNow();
    this.tracker.adjust(name, resource, delta);
    const key = `${name}|${resource}`;
    this.adjustments.set(key, (this.adjustments.get(key) ?? 0) + delta);
  }

  clearAdjustments() {
    this.adjustments = new Map();
    this.dirty = true;
  }

  adjustmentsJSON(): Record<string, number> {
    return Object.fromEntries(this.adjustments);
  }

  loadAdjustments(saved: Record<string, number>) {
    this.adjustments = new Map(Object.entries(saved).filter(([, v]) => v));
    this.dirty = true;
  }

  adjustmentCount(): number {
    return [...this.adjustments.values()].filter(Boolean).length;
  }

  views(): PlayerHandView[] {
    if (this.dirty) this.rebuildNow();
    const views = this.tracker.views();
    const me = this.me;
    return views.sort((a, b) => Number(b.name === me) - Number(a.name === me) || a.name.localeCompare(b.name));
  }

  rowCount(): number {
    return this.rows.size;
  }

  /** Row indexes between the first and last seen row that have not been received. */
  missingCount(): number {
    const idxs = [...this.rows.keys()].filter((i) => i < NO_INDEX_BASE);
    if (!idxs.length) return 0;
    return Math.max(...idxs) - Math.min(...idxs) + 1 - idxs.length;
  }

  /** Time of the first "<name> placed a ..." row, used to match a log name to a network player. */
  firstPlacedAt(name: string): number | undefined {
    const re = new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+placed a\\b`, "i");
    let best: number | undefined;
    for (const row of this.rows.values()) if (re.test(row.text) && (best === undefined || row.t < best)) best = row.t;
    return best;
  }

  /** Settlements this player placed or built, from the log rows read so far. */
  loggedSettlements(name: string): number {
    const re = new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(placed|built) an? settlement\\b`, "i");
    let n = 0;
    for (const row of this.rows.values()) if (re.test(row.text)) n++;
    return n;
  }

  /** True once the first dice roll is in; before that nobody holds more than their starting cards. */
  rolls(): number {
    return this.parser.rolls;
  }
}
