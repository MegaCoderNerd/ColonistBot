// Recovered from content.js (lines 981-1195)
import { iconNumbers, isHidden, textOf } from "./logScrape";
import { END_TABS, type EndTab } from "./selectors";
import type { EndScreenCapture, EndScreenRow } from "../shared/schema";

const LABELS: readonly string[] = END_TABS;
const WINDOW_HINT = /well played|victory|defeat|game over|won the game|winner/i;
const ACTIVE_CLASS = /(^|[\s_-])(active|selected|current)([\s_-]|$)/i;

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface EndScreenState {
  open: boolean;
  active: EndTab | null;
  activeSource: "aria" | "style" | "click" | "default" | null;
  captured: EndTab[];
  missing: EndTab[];
  next: EndTab | null;
}

export interface EndScreenOptions {
  stableMs?: number;
  names: () => string[];
  onCapture: (end: EndScreenCapture, tab: EndTab, isNew: boolean) => void;
  onClosed: () => void;
}

function findTabs(doc: Document): Map<EndTab, Element> {
  const found = new Map<EndTab, Element>();
  const body = doc.body;
  if (!body) return found;
  const text = body.textContent ?? "";
  if (!text.includes("Dice Stats") || !text.includes("Res Card Stats")) return found;
  for (const el of body.querySelectorAll("*")) {
    if (el.children.length > 1) continue;
    const label = (el.textContent ?? "").trim();
    if (LABELS.includes(label) && !found.has(label as EndTab) && !isHidden(el)) found.set(label as EndTab, el);
  }
  return found;
}

function commonAncestor(els: Element[]): Element | null {
  let node: Element | null = els[0] ?? null;
  while (node && !els.every((e) => node!.contains(e))) node = node.parentElement;
  return node;
}

function windowRoot(doc: Document, tabEls: Element[]): Element | null {
  const bar = commonAncestor(tabEls);
  if (!bar) return null;
  let node: Element | null = bar;
  for (let i = 0; i < 8 && node && node !== doc.body; i++) {
    if (WINDOW_HINT.test(textOf(node, true))) return node;
    node = node.parentElement;
  }
  return bar.parentElement && bar.parentElement !== doc.body ? bar.parentElement : bar;
}

const styleSig = (el: Element): string => {
  const view = el.ownerDocument.defaultView;
  if (!view) return "";
  return [el, el.parentElement]
    .map((e) => {
      if (!e) return "";
      const cs = view.getComputedStyle(e);
      return [cs.color, cs.fontWeight, cs.backgroundColor, cs.borderBottomColor, cs.borderBottomWidth, cs.opacity].join("|");
    })
    .join("//");
};

function activeTab(tabs: Map<EndTab, Element>, clicked: EndTab | null): { name: EndTab | null; source: EndScreenState["activeSource"] } {
  const entries = [...tabs.entries()];
  const els = entries.map(([, e]) => e);
  const flagged = entries.filter(([, el]) => {
    let e: Element | null = el;
    for (let i = 0; i < 3 && e; i++, e = e.parentElement) {
      if (els.some((o) => o !== el && e!.contains(o))) return false;
      if (e.getAttribute("aria-selected") === "true" || e.getAttribute("aria-current") === "true" || e.getAttribute("data-state") === "active") return true;
      if (ACTIVE_CLASS.test(e.getAttribute("class") ?? "")) return true;
    }
    return false;
  });
  if (flagged.length === 1) return { name: flagged[0][0], source: "aria" };
  const groups = new Map<string, EndTab[]>();
  for (const [name, el] of entries) groups.set(styleSig(el), [...(groups.get(styleSig(el)) ?? []), name]);
  if (groups.size === 2) {
    const single = [...groups.values()].filter((g) => g.length === 1);
    if (single.length === 1 && entries.length >= 4) return { name: single[0][0], source: "style" };
  }
  if (clicked && tabs.has(clicked)) return { name: clicked, source: "click" };
  return { name: tabs.has("Overview") ? "Overview" : null, source: tabs.has("Overview") ? "default" : null };
}

function extractRows(root: Element, firstTab: Element, names: string[]): EndScreenRow[] {
  const rows: EndScreenRow[] = [];
  const trs = [...root.querySelectorAll('tr, [role="row"]')].filter((tr) => !isHidden(tr));
  if (trs.length) {
    for (const tr of trs) {
      const text = textOf(tr, true);
      if (!text) continue;
      const player = names.find((n) => text.includes(n)) ?? text.split(" ")[0];
      rows.push({ player, values: iconNumbers(tr, true), text });
    }
    return rows;
  }
  if (names.length < 2) return rows;
  const leaves = [...root.querySelectorAll("*")].filter((el) => el.children.length === 0 && !isHidden(el));
  for (const name of names) {
    const hit = leaves.find((el) => (el.textContent ?? "").includes(name) && Boolean(firstTab.compareDocumentPosition(el) & 4));
    if (!hit) continue;
    let row: Element = hit;
    while (row.parentElement && row.parentElement !== root) {
      const text = row.parentElement.textContent ?? "";
      if (names.some((o) => o !== name && text.includes(o))) break;
      row = row.parentElement;
    }
    rows.push({ player: name, values: iconNumbers(row, true), text: textOf(row, true) });
  }
  return rows;
}

export function createEndScreen(doc: Document, opts: EndScreenOptions) {
  const stableMs = opts.stableMs ?? 700;
  const end: EndScreenCapture = { header: "", tabs: {} };
  let open = false;
  let wasOpen = false;
  let clicked: EndTab | null = null;
  let state: EndScreenState = { open: false, active: null, activeSource: null, captured: [], missing: [...END_TABS], next: "Overview" };
  let pending = { key: "", since: 0 };
  let lastCheck = 0;

  const onClick = (ev: MouseEvent) => {
    const label = ((ev.target as Element | null)?.textContent ?? "").trim();
    if (LABELS.includes(label)) clicked = label as EndTab;
  };
  doc.addEventListener("click", onClick, true);

  function refreshState(active: EndTab | null, source: EndScreenState["activeSource"]) {
    const captured = END_TABS.filter((t) => end.tabs[t]);
    const missing = END_TABS.filter((t) => !end.tabs[t]);
    const after = active ? missing.filter((t) => END_TABS.indexOf(t) > END_TABS.indexOf(active)) : [];
    state = { open, active, activeSource: source, captured, missing, next: after[0] ?? missing[0] ?? null };
  }

  function tick(now = Date.now()): EndScreenState {
    if (now - lastCheck < (open ? 250 : 600)) return state;
    lastCheck = now;
    const tabs = findTabs(doc);
    if (tabs.size < 4) {
      open = false;
      if (wasOpen) {
        wasOpen = false;
        refreshState(null, null);
        opts.onClosed();
      }
      return state;
    }
    open = true;
    wasOpen = true;
    const tabEls = [...tabs.values()];
    const root = windowRoot(doc, tabEls);
    const { name, source } = activeTab(tabs, clicked);
    refreshState(name, source);
    if (!root || !name) return state;
    const full = textOf(root, true);
    const firstLabel = [...tabs.values()].map((e) => textOf(e, true))[0];
    const cut = full.indexOf(firstLabel);
    const header = cut > 0 ? full.slice(0, cut).trim() : "";
    let content = cut >= 0 ? full.slice(cut) : full;
    for (const label of tabs.keys()) content = content.replace(label, " ");
    content = content.replace(/\s+/g, " ").trim();
    const key = `${name}|${content}`;
    if (key !== pending.key) {
      pending = { key, since: now };
      return state;
    }
    if (now - pending.since < stableMs || !content) return state;
    const existing = end.tabs[name];
    if (existing && existing.text === content) return state;
    const firstTab = tabEls.reduce((a, b) => (a.compareDocumentPosition(b) & 4 ? a : b));
    const names = opts.names();
    end.tabs[name] = { text: content, rows: extractRows(root, firstTab, names), t: Date.now() };
    if (header) end.header = header;
    refreshState(name, source);
    opts.onCapture(end, name, !existing);
    return state;
  }

  return {
    tick,
    state: () => state,
    capture: () => end,
    reset() {
      for (const k of Object.keys(end.tabs)) delete end.tabs[k];
      end.header = "";
      open = false;
      wasOpen = false;
      clicked = null;
      pending = { key: "", since: 0 };
      refreshState(null, null);
    },
    stop: () => doc.removeEventListener("click", onClick, true)
  };
}

const PROMPT_CSS = `
:host { all: initial }
.box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646; max-width: min(92vw, 560px);
  font: 13px/1.4 system-ui, sans-serif; color: #f4f1e8; background: #20262eef; border: 1px solid #c9a227; border-radius: 10px;
  padding: 10px 14px; box-shadow: 0 8px 30px #0008 }
.title { font-weight: 700; margin-bottom: 6px }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px }
.chip { padding: 2px 8px; border-radius: 999px; border: 1px solid #5a6572; font-size: 12px }
.chip.done { background: #2e7d4f; border-color: #2e7d4f }
.chip.next { border-color: #c9a227; color: #ffd75e; font-weight: 700 }
.chip.here { outline: 1px dashed #9ec1ff }
`;

export function createEndPrompt(doc: Document) {
  const host = doc.createElement("div");
  host.setAttribute("data-colonist-recorder", "end-prompt");
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = PROMPT_CSS;
  const box = doc.createElement("div");
  box.className = "box";
  root.append(style, box);
  host.style.display = "none";
  return {
    host,
    setVisible(on: boolean) {
      host.style.display = on ? "" : "none";
    },
    render(s: EndScreenState, extra?: { done?: string }) {
      const title = doc.createElement("div");
      title.className = "title";
      if (extra?.done) title.textContent = extra.done;
      else if (!s.open) title.textContent = "";
      else if (s.next) title.textContent = `Game over: ${s.captured.length} of ${END_TABS.length} stats tabs saved. Next, click ${s.next}.`;
      else title.textContent = "All six stats tabs saved. Close this window to save the final board.";
      const chips = doc.createElement("div");
      chips.className = "tabs";
      for (const t of END_TABS) {
        const chip = doc.createElement("span");
        chip.className = `chip${s.captured.includes(t) ? " done" : ""}${s.next === t ? " next" : ""}${s.active === t ? " here" : ""}`;
        chip.textContent = `${s.captured.includes(t) ? "\u2713 " : ""}${t}`;
        chips.append(chip);
      }
      box.replaceChildren(title, ...(extra?.done ? [] : [chips]));
    }
  };
}
