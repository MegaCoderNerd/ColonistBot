// Recovered from content.js (lines 143-322)
import {
  findIndexedRows,
  findLogScroller,
  findRows,
  isChatText,
  missingIndexes,
  playerColorOf,
  previousRowText,
  rowIndex,
  stripDecor,
  textOf
} from "./logScrape";
import type { LogEntry } from "../shared/schema";

const SETTLE_MS = 40;
const LEGACY_DEDUPE_MS = 300;
const SWEEP_COOLDOWN_MS = 4000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createLogCapture(doc: Document, onEntry: (entry: LogEntry) => void) {
  let seen = new Set<number>();
  let maxIdx = -1;
  let minIdx = Number.POSITIVE_INFINITY;
  let swept = false;
  let sweeping = false;
  let lastSweepAt = 0;
  let lastSweepMissing = "";
  let legacySeen = new WeakSet<Element>();
  let legacyKeys = new Map<string, number>();
  let pending = new Set<Element>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  let stopped = false;

  const emit = (row: Element) => {
    const idx = rowIndex(row);
    const text = stripDecor(textOf(row));
    if (idx !== undefined) {
      if (seen.has(idx)) return;
      seen.add(idx);
      maxIdx = Math.max(maxIdx, idx);
      minIdx = Math.min(minIdx, idx);
      if (!text || isChatText(text)) return;
      onEntry({ t: Date.now(), text, idx, color: playerColorOf(row) });
      return;
    }
    if (!text || legacySeen.has(row)) return;
    legacySeen.add(row);
    const now = Date.now();
    const key = `${text}|${previousRowText(row)}`;
    const prev = legacyKeys.get(key);
    if (prev !== undefined && now - prev < LEGACY_DEDUPE_MS) return;
    legacyKeys.set(key, now);
    if (legacyKeys.size > 500) legacyKeys = new Map([...legacyKeys].slice(-200));
    if (!isChatText(text)) onEntry({ t: now, text });
  };

  const collect = (el: Element) => {
    const indexed = findIndexedRows(el);
    return indexed.length || maxIdx >= 0 ? indexed : findRows(el);
  };

  const flushPending = () => {
    timer = undefined;
    const rows = [...pending];
    pending = new Set();
    const sorted = rows.map((row) => ({ row, idx: rowIndex(row) ?? Number.MAX_SAFE_INTEGER })).sort((a, b) => a.idx - b.idx);
    for (const { row } of sorted) emit(row);
  };

  const schedule = (els: Element[]) => {
    if (stopped) return;
    for (const el of els) pending.add(el);
    timer ??= setTimeout(flushPending, SETTLE_MS);
  };

  const scanNow = () => {
    const root = doc.body;
    if (root) schedule(collect(root));
  };

  const sweep = async (_reason?: string) => {
    if (sweeping) return;
    const scroller = findLogScroller(doc);
    if (!scroller) {
      swept = true;
      return;
    }
    sweeping = true;
    lastSweepAt = Date.now();
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 6;
    const saved = scroller.scrollTop;
    try {
      scroller.scrollTop = 0;
      await sleep(140);
      scanNow();
      for (let step = 0; step < 600; step++) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + Math.max(40, scroller.clientHeight * 0.6);
        await sleep(80);
        scanNow();
        const end = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        if (end || scroller.scrollTop === before) {
          await sleep(120);
          scanNow();
          break;
        }
      }
      await sleep(SETTLE_MS * 2);
    } finally {
      scroller.scrollTop = atBottom ? scroller.scrollHeight : saved;
      swept = true;
      sweeping = false;
      lastSweepMissing = missingIndexes(seen, floor(), maxIdx).join(",");
    }
  };

  let lastHeight = 0;
  let lastPeekAt = 0;
  const peek = async (scroller: HTMLElement) => {
    sweeping = true;
    lastPeekAt = Date.now();
    const saved = scroller.scrollTop;
    try {
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(120);
      scanNow();
      await sleep(SETTLE_MS * 2);
    } finally {
      scroller.scrollTop = saved;
      sweeping = false;
    }
  };

  const floor = () => (swept && Number.isFinite(minIdx) ? minIdx : 0);

  return {
    start() {
      if (observer) return;
      stopped = false;
      observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes.forEach((node) => {
            const el = node instanceof Element ? node : node.parentElement;
            if (el) schedule(collect(el));
          });
        }
      });
      const begin = () => {
        if (!doc.body) return;
        observer?.observe(doc.body, { childList: true, subtree: true });
        scanNow();
      };
      if (doc.body) begin();
      else doc.addEventListener("DOMContentLoaded", begin, { once: true });
    },
    reset() {
      seen = new Set();
      maxIdx = -1;
      minIdx = Number.POSITIVE_INFINITY;
      swept = false;
      lastSweepMissing = "";
      legacySeen = new WeakSet();
      legacyKeys = new Map();
    },
    scanNow,
    tick() {
      scanNow();
      if (sweeping) return;
      const scroller = findLogScroller(doc);
      if (scroller) {
        const away = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 60;
        const grew = scroller.scrollHeight !== lastHeight;
        lastHeight = scroller.scrollHeight;
        if (away && grew && Date.now() - lastPeekAt > 2000) {
          void peek(scroller);
          return;
        }
      }
      if (maxIdx < 0 || Date.now() - lastSweepAt < SWEEP_COOLDOWN_MS) return;
      const missing = missingIndexes(seen, floor(), maxIdx).join(",");
      if (missing && missing !== lastSweepMissing) void sweep("gap");
    },
    sweep,
    status() {
      return {
        seen: seen.size,
        maxIdx,
        missing: maxIdx < 0 ? 0 : missingIndexes(seen, floor(), maxIdx).length,
        swept,
        sweeping
      };
    },
    stop() {
      stopped = true;
      observer?.disconnect();
      observer = undefined;
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = new Set();
    }
  };
}
