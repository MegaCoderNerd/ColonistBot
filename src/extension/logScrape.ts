// Recovered from content.js (lines 17-141)
import { SEL } from "./selectors";
import type { IconNumber, PanelPlayer, PanelSnapshot } from "../shared/schema";

const ROW_VERBS = "rolled|got|received|built|placed|bought|used|played|gave|traded|moved|stole|discarded|took|won|upgraded|claimed|offered";
const ROW_RE = new RegExp(`^(?:Player avatar\\s+)?(?:You|[^\\s:]{1,40})\\s+(?:${ROW_VERBS})\\b`, "i");
const MAX_ROW_CHARS = 300;

export function isHidden(el: Element): boolean {
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  return cs ? cs.display === "none" || cs.visibility === "hidden" : false;
}

export function textOf(node: Node, visibleOnly = false): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      parts.push(n.textContent ?? "");
    } else if (n.nodeType === 1) {
      const el = n as Element;
      if (visibleOnly && isHidden(el)) return;
      if (el.tagName === "IMG") {
        const img = el as HTMLImageElement;
        const name = (img.getAttribute("alt") || (img.getAttribute("src") ?? "").split("/").pop() || "").replace(/\.\w+(\?.*)?$/, "");
        if (name) parts.push(` ${name} `);
      } else {
        parts.push(" ");
        el.childNodes.forEach(walk);
        parts.push(" ");
      }
    }
  };
  walk(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}

export function stripDecor(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, " ").replace(/\s+/g, " ").trim();
}

export function looksLikeRow(text: string): boolean {
  const clean = stripDecor(text);
  return clean.length > 0 && clean.length <= MAX_ROW_CHARS && ROW_RE.test(clean);
}

export function isChatText(text: string): boolean {
  return /^(?:Player avatar\s+)?[^\s:]{1,40}:\s/.test(stripDecor(text));
}

export function rowIndex(el: Element): number | undefined {
  const holder = el.closest(`[${SEL.rowIndexAttr}]`);
  const raw = holder?.getAttribute(SEL.rowIndexAttr);
  if (raw === null || raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function findIndexedRows(root: Element): Element[] {
  const found = new Set<Element>();
  const own = root.closest(`[${SEL.rowIndexAttr}]`);
  if (own) found.add(own);
  root.querySelectorAll(`[${SEL.rowIndexAttr}]`).forEach((e) => found.add(e));
  return [...found].filter((e) => {
    for (let p = e.parentElement; p; p = p.parentElement) if (found.has(p)) return false;
    return true;
  });
}

export function playerColorOf(row: Element): string | undefined {
  const name = row.querySelector(SEL.strongName) as HTMLElement | null;
  return name?.style?.color || undefined;
}

export function findLogScroller(doc: Document): HTMLElement | undefined {
  const first = doc.querySelector(`[${SEL.rowIndexAttr}]`);
  for (let p = first?.parentElement ?? null; p; p = p.parentElement) {
    const oy = p.ownerDocument.defaultView?.getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll" || oy === "overlay") && p.scrollHeight > p.clientHeight + 4) return p;
  }
  return (first?.parentElement as HTMLElement | null) ?? undefined;
}

export function missingIndexes(seen: Set<number>, floor: number, max: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, floor); i <= max; i++) if (!seen.has(i)) out.push(i);
  return out;
}

export function iconNumbers(root: Node, visibleOnly = false): IconNumber[] {
  const out: IconNumber[] = [];
  let icon = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      for (const m of (n.textContent ?? "").matchAll(/-?\d+/g)) {
        out.push({ icon: icon || "number", value: Number(m[0]) });
        icon = "";
      }
    } else if (n.nodeType === 1) {
      const el = n as Element;
      if (visibleOnly && isHidden(el)) return;
      if (el.tagName === "IMG") {
        icon = (el.getAttribute("alt") || (el.getAttribute("src") ?? "").split("/").pop() || "").replace(/\.\w+(\?.*)?$/, "");
      } else el.childNodes.forEach(walk);
    }
  };
  walk(root);
  return out;
}

export function scrapePanel(doc: Document, after?: number): PanelSnapshot | undefined {
  const container = doc.querySelector(SEL.playerPanel);
  if (!container) return undefined;
  const players: PanelPlayer[] = [...container.querySelectorAll(SEL.playerBlock)].map((block) => {
    const cardsEl = block.querySelector(SEL.cardCount);
    const n = Number.parseInt(cardsEl?.textContent?.trim() ?? "", 10);
    return {
      color: block.getAttribute("data-player-color") ?? "",
      text: textOf(block).slice(0, 120),
      cards: Number.isNaN(n) ? undefined : n,
      stats: iconNumbers(block).slice(0, 12)
    };
  });
  return players.length ? { after, players } : undefined;
}

export function findRows(root: Element): Element[] {
  const text = textOf(root);
  if (!text) return [];
  const childRows = [...root.children].flatMap((c) => findRows(c));
  if (childRows.length) return childRows;
  return looksLikeRow(text) ? [root] : [];
}

export function previousRowText(row: Element): string {
  let el: Element | null = row;
  while (el && !el.previousElementSibling) el = el.parentElement;
  const prev = el?.previousElementSibling;
  if (!prev) return "";
  const rows = findRows(prev);
  return textOf(rows.at(-1) ?? prev).slice(0, 120);
}
