// Recovered from content.js (lines 5863-6169)
import type { PlayerHandView } from "../analyzer/tracker";
import { RESOURCES, type Resource } from "../analyzer/types";
import type { HelperView } from "./helper";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface OverlayState {
  views: PlayerHandView[];
  me?: string;
  log: { rows: number; missing: number; sweeping: boolean };
  settled: boolean;
  adjustments: number;
  helper?: HelperView;
  notice?: string;
}

export interface OverlayActions {
  adjust: (name: string, resource: Resource, delta: number) => void;
  sweep: () => void;
  clearAdjustments: () => void;
  hide: () => void;
  pickMe?: (name: string) => void;
  turnMap?: (steps: number) => void;
  flipMap?: (vertical?: boolean) => void;
}

const LABEL: Record<Resource, string> = { lumber: "Lumber", brick: "Brick", wool: "Wool", grain: "Grain", ore: "Ore" };
const COLOR: Record<Resource, string> = { lumber: "#2f7d32", brick: "#b5532f", wool: "#8bc34a", grain: "#e0b400", ore: "#78909c" };
const AFFORD_LABEL: Record<"road" | "settlement" | "city" | "dev", string> = { road: "Road", settlement: "Settle", city: "City", dev: "Dev" };

const CSS = `
:host { all: initial; }
.panel { position: fixed; top: 84px; right: 10px; width: 268px; z-index: 2147483647; font: 12px/1.35 system-ui, sans-serif; color: #e9edf1;
  background: rgba(24, 28, 34, 0.94); border: 1px solid #3a424d; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.45); user-select: none; }
.head { display: flex; align-items: center; gap: 6px; padding: 7px 9px; cursor: move; border-bottom: 1px solid #2d343d; }
.head b { flex: 1; font-size: 12px; letter-spacing: .02em; }
.iconbtn { all: unset; cursor: pointer; padding: 0 5px; border-radius: 4px; color: #aab4bf; }
.iconbtn:hover { background: #2d343d; color: #fff; }
.body { padding: 6px 9px 8px; max-height: 70vh; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
.player { padding: 6px 0; border-bottom: 1px solid #2d343d; }
.player:last-child { border-bottom: 0; }
.name { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.name .total { margin-left: auto; font-variant-numeric: tabular-nums; }
.badge { font-size: 10px; padding: 1px 5px; border-radius: 8px; background: #2d343d; color: #aab4bf; font-weight: 500; }
.badge.ok { background: #1e4d2b; color: #9be3ae; }
.badge.bad { background: #5a2323; color: #ffb4b4; }
.badge.warn { background: #5a4a14; color: #ffe08a; }
.res { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin: 6px 0 4px; }
.cell { text-align: center; border-radius: 6px; padding: 3px 0 2px; background: #20262d; position: relative; }
.cell .dot { display: block; height: 3px; border-radius: 2px; margin: 0 6px 2px; }
.cell .n { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.cell .l { font-size: 9px; color: #8b97a4; }
.cell .pm { display: none; position: absolute; inset: 0; }
.cell:hover .pm { display: flex; }
.pm button { all: unset; flex: 1; text-align: center; cursor: pointer; background: rgba(0,0,0,.55); color: #fff; font-weight: 700; font-size: 14px; }
.pm button:first-child { border-radius: 6px 0 0 6px; } .pm button:last-child { border-radius: 0 6px 6px 0; }
.pm button:hover { background: rgba(255,255,255,.25); }
.chips { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.chip { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #2d343d; color: #8b97a4; }
.chip.yes { background: #1e4d2b; color: #9be3ae; } .chip.maybe { background: #5a4a14; color: #ffe08a; }
.sub { color: #8b97a4; font-size: 11px; margin-top: 3px; }
.warn { color: #ffd37a; font-size: 11px; margin-top: 3px; }
.foot { display: flex; gap: 6px; align-items: center; padding: 6px 9px; border-top: 1px solid #2d343d; color: #8b97a4; font-size: 11px; }
.foot button { all: unset; cursor: pointer; padding: 1px 6px; border-radius: 4px; background: #2d343d; color: #dbe2e8; }
.foot button:hover { background: #3a424d; }
.notice { padding: 6px 9px; background: #3a2f12; color: #ffe08a; font-size: 11px; }
.helper { margin-top: 6px; padding-top: 6px; border-top: 1px solid #2d343d; }
.helper h4 { margin: 0 0 4px; font-size: 11px; color: #aab4bf; font-weight: 600; }
.coach { margin: 0 0 6px; padding: 6px 7px; border-radius: 8px; background: #17202a; border: 1px solid #314255; }
.coach .headline { font-weight: 700; color: #fff; font-size: 12px; }
.coach .why, .coach .tip span { color: #c5d0da; font-size: 11px; }
.coach .race { color: #9be3ae; font-size: 10px; margin-top: 3px; }
.coach .tip { margin-top: 5px; }
.coach .tip b { display: block; color: #ffd37a; font-size: 10px; letter-spacing: .03em; text-transform: uppercase; }
.helper ul { margin: 6px 0 0; padding: 0 0 0 16px; }
.helper h5 { margin: 8px 0 2px; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: #ffd37a; font-weight: 700; }
.helper li { margin: 0 0 4px; padding: 0; font-size: 11px; line-height: 1.35; }
.helper svg { display: block; width: 100%; height: auto; margin: 2px 0; border-radius: 6px; background: #12161b; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 4px 0 0; font-size: 10px; color: #8b97a4; }
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; vertical-align: -1px; }
.legend button, .debugbtn { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 8px; background: #2d343d; color: #dbe2e8; font-size: 10px; }
.legend button:hover, .debugbtn:hover { background: #3a424d; }
.pick { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 8px; background: #3a424d; color: #fff; font-size: 11px; }
.pick:hover { background: #55606e; }
.collapsed .body, .collapsed .foot, .collapsed .notice { display: none; }
`;

function h(doc: Document, tag: string, attrs: Record<string, unknown> = {}, ...kids: Array<Node | string | undefined>): HTMLElement {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== undefined) el.append(kid);
  return el;
}

async function copyText(doc: Document, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = doc.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;left:-9999px;top:0";
    doc.body.append(area);
    area.select();
    const ok = doc.execCommand("copy");
    area.remove();
    return ok;
  }
}

function playerBlock(doc: Document, v: PlayerHandView, state: OverlayState, actions: OverlayActions): HTMLElement {
  const isMe = v.name === state.me || v.exact === true;
  let badge: HTMLElement;
  if (v.synced === undefined) badge = h(doc, "span", { class: "badge", title: "Colonist's own card counter could not be read" }, "unverified");
  else if (v.synced)
    badge = h(
      doc,
      "span",
      { class: "badge ok", title: v.exact ? "Read from the game state and matches Colonist's own card counter" : "Matches Colonist's own card counter" },
      v.exact ? "exact" : "in sync"
    );
  else if (!state.settled) badge = h(doc, "span", { class: "badge", title: "Waiting for the counter to catch up" }, "checking");
  else badge = h(doc, "span", { class: "badge bad", title: `Colonist shows ${v.panelCards}, the log adds up to ${v.total}` }, `off by ${v.delta > 0 ? "+" : ""}${v.delta}`);
  const cells = RESOURCES.map((r) =>
    h(
      doc,
      "div",
      { class: "cell" },
      h(doc, "span", { class: "dot", style: `background:${COLOR[r]}` }),
      h(doc, "span", { class: "n" }, String(v.hand[r])),
      h(doc, "span", { class: "l" }, LABEL[r]),
      h(
        doc,
        "div",
        { class: "pm" },
        h(doc, "button", { title: `Remove one ${LABEL[r]}`, onclick: () => actions.adjust(v.name, r, -1) }, "-"),
        h(doc, "button", { title: `Add one ${LABEL[r]}`, onclick: () => actions.adjust(v.name, r, 1) }, "+")
      )
    )
  );
  const block = h(doc, "div", { class: "player" });
  block.append(
    h(
      doc,
      "div",
      { class: "name" },
      isMe ? `${v.name} (you)` : v.name,
      badge,
      h(doc, "span", { class: "total", title: "Cards in hand" }, `${v.total}${v.unknown ? ` (${v.unknown}?)` : ""}`)
    ),
    h(doc, "div", { class: "res" }, ...cells)
  );
  if (!isMe) {
    const chips = (Object.keys(AFFORD_LABEL) as Array<keyof typeof AFFORD_LABEL>).map((k) =>
      h(
        doc,
        "span",
        { class: `chip ${v.afford[k] === "no" ? "" : v.afford[k]}`, title: v.afford[k] === "maybe" ? "Possible if the unknown card is right" : "" },
        `${AFFORD_LABEL[k]}${v.afford[k] === "yes" ? " ok" : v.afford[k] === "maybe" ? " ?" : ""}`
      )
    );
    block.append(h(doc, "div", { class: "chips", title: "What they can pay for right now" }, ...chips));
    const odds = RESOURCES.filter((r) => v.hand[r] > 0)
      .map((r) => `${LABEL[r]} ${Math.round(v.stealOdds[r] * 100)}%`)
      .join(" \xB7 ");
    if (odds) block.append(h(doc, "div", { class: "sub" }, `Steal odds: ${odds}`));
  }
  if (v.discardOnSeven > 0) block.append(h(doc, "div", { class: "sub" }, `Discards ${v.discardOnSeven} on a 7`));
  block.append(
    h(
      doc,
      "div",
      { class: "sub" },
      `Dev cards: ${v.devBought} bought, ${v.devPlayed} played${v.knights ? ` (${v.knights} knights)` : ""}${v.devUnplayed ? ` \xB7 ${v.devUnplayed} in hand (may be VP)` : ""}`
    )
  );
  for (const w of v.warnings.slice(-2)) block.append(h(doc, "div", { class: "warn" }, w));
  return block;
}

export function createOverlay(doc: Document, actions: OverlayActions) {
  const host = doc.createElement("div");
  host.id = "colonist-recorder-overlay";
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = CSS;
  const panel = h(doc, "div", { class: "panel" });
  root.append(style, panel);
  let collapsed = false;
  let lastKey = "";
  let state: OverlayState | undefined;
  let busyUntil = 0;
  let deferred: ReturnType<typeof setTimeout> | undefined;
  let scrollTop = 0;
  let pressed = false;

  const draw = () => {
    if (!state) return;
    const s = state;
    const oldBody = panel.querySelector(".body");
    if (oldBody) scrollTop = oldBody.scrollTop;
    panel.className = `panel${collapsed ? " collapsed" : ""}`;
    const head = h(
      doc,
      "div",
      { class: "head" },
      h(doc, "b", {}, "Card counter"),
      h(
        doc,
        "button",
        {
          class: "iconbtn",
          title: collapsed ? "Expand" : "Collapse",
          onclick: () => {
            collapsed = !collapsed;
            lastKey = "";
            draw();
          }
        },
        collapsed ? "+" : "-"
      ),
      h(doc, "button", { class: "iconbtn", title: "Hide for this game", onclick: () => actions.hide() }, "x")
    );
    enableDrag(head, panel);
    const body = h(doc, "div", { class: "body" }, ...s.views.map((v) => playerBlock(doc, v, s, actions)));
    if (!s.views.length) body.append(h(doc, "div", { class: "sub" }, "Waiting for the game log. Play on; counts appear with the first rows."));
    if (s.helper) {
      const helper = h(doc, "div", { class: "helper" }, h(doc, "h4", {}, s.helper.title));
      const coach = s.helper.coach;
      if (coach) {
        helper.append(
          h(
            doc,
            "div",
            { class: "coach" },
            h(doc, "div", { class: "headline" }, coach.headline),
            h(doc, "div", { class: "why" }, coach.why),
            coach.race ? h(doc, "div", { class: "race" }, coach.race) : undefined,
            ...coach.tips.map((t) => h(doc, "div", { class: "tip" }, h(doc, "b", {}, t.title), h(doc, "span", {}, t.why)))
          )
        );
      }
      if (s.helper.mapSvg) {
        const parsed = new DOMParser().parseFromString(s.helper.mapSvg, "image/svg+xml").documentElement;
        if (parsed.localName === "svg") helper.append(doc.importNode(parsed, true));
        if (s.helper.mapLegend) {
          helper.append(
            h(
              doc,
              "div",
              { class: "legend" },
              h(doc, "span", {}, h(doc, "i", { style: "background:#2563eb" }), "you"),
              h(doc, "span", {}, h(doc, "i", { style: "background:#e11d48" }), "opponent"),
              ...(s.helper.mapPicks ? [h(doc, "span", {}, h(doc, "i", { style: "background:#ffd54a" }), "suggested")] : []),
              ...(s.helper.mapMarks ? [h(doc, "span", {}, h(doc, "i", { style: "background:transparent;border:1.5px dashed #e11d48" }), "he wants")] : []),
              ...(s.helper.mapRoads ? [h(doc, "span", {}, h(doc, "i", { style: "background:#ffd54a" }), "place this road")] : []),
              ...(s.helper.mapRoadLater ? [h(doc, "span", {}, h(doc, "i", { style: "background:transparent;border:1.5px dashed #ffd54a" }), "then this road")] : []),
              h(doc, "span", {}, h(doc, "i", { style: "background:#10151a;border:1px solid #8b97a4" }), "robber"),
              h(doc, "button", { title: "Turn the map by 60 degrees until it looks like Colonist's board", onclick: () => actions.turnMap?.(2) }, "rotate"),
              h(doc, "button", { title: "Turn the map by 30 degrees", onclick: () => actions.turnMap?.(1) }, "30\xB0"),
              h(doc, "button", { title: "Mirror left to right", onclick: () => actions.flipMap?.() }, "flip \u2194"),
              h(doc, "button", { title: "Mirror top to bottom", onclick: () => actions.flipMap?.(true) }, "flip \u2195")
            )
          );
        }
      }
      helper.append(h(doc, "ul", {}, ...s.helper.lines.map((l) => h(doc, "li", {}, l))));
      for (const section of s.helper.sections ?? []) {
        helper.append(h(doc, "h5", {}, section.title), h(doc, "ul", {}, ...section.lines.map((l) => h(doc, "li", {}, l))));
      }
      if (s.helper.choose?.length) {
        helper.append(
          h(doc, "div", { class: "chips" }, h(doc, "span", { class: "sub" }, "I am:"), ...s.helper.choose.map((n) => h(doc, "button", { class: "pick", onclick: () => actions.pickMe?.(n) }, n)))
        );
      }
      const debug = s.helper.debug;
      if (debug) {
        const btn = h(doc, "button", { class: "debugbtn", title: "Copy what the helper read, to report a problem" }, "copy debug info");
        btn.addEventListener("click", () => {
          void copyText(doc, debug).then((ok) => {
            btn.textContent = ok ? "copied" : "copy failed";
          });
        });
        helper.append(h(doc, "div", { class: "legend" }, btn));
      }
      body.append(helper);
    }
    const foot = h(
      doc,
      "div",
      { class: "foot" },
      h(doc, "span", {}, `${s.log.rows} rows${s.log.missing ? ` \xB7 ${s.log.missing} missing` : ""}`),
      h(doc, "button", { title: "Scroll the game log once to re-read every row", onclick: () => actions.sweep() }, s.log.sweeping ? "reading..." : "rebuild"),
      s.adjustments ? h(doc, "button", { title: "Undo manual +/- corrections", onclick: () => actions.clearAdjustments() }, "undo edits") : undefined
    );
    panel.replaceChildren(head, ...(s.notice ? [h(doc, "div", { class: "notice" }, s.notice)] : []), body, foot);
    body.scrollTop = scrollTop;
    body.addEventListener(
      "scroll",
      () => {
        scrollTop = body.scrollTop;
      },
      { passive: true }
    );
  };

  const touch = (ms: number) => {
    busyUntil = Math.max(busyUntil, Date.now() + ms);
  };
  panel.addEventListener("wheel", () => touch(700), { passive: true });
  panel.addEventListener("touchmove", () => touch(700), { passive: true });
  panel.addEventListener("scroll", () => touch(700), { capture: true, passive: true });
  panel.addEventListener("pointerdown", () => {
    pressed = true;
  });
  const release = () => {
    if (!pressed) return;
    pressed = false;
    touch(150);
  };
  doc.addEventListener("pointerup", release);
  doc.addEventListener("pointercancel", release);

  const flush = () => {
    deferred = undefined;
    if (pressed || Date.now() < busyUntil) {
      deferred = setTimeout(flush, 200);
      return;
    }
    lastKey = "";
    const next = state;
    if (next) api.render(next);
  };

  const enableDrag = (handle: HTMLElement, target: HTMLElement) => {
    handle.addEventListener("pointerdown", (ev: PointerEvent) => {
      if ((ev.target as HTMLElement).closest("button")) return;
      const rect = target.getBoundingClientRect();
      const dx = ev.clientX - rect.left;
      const dy = ev.clientY - rect.top;
      const move = (e: PointerEvent) => {
        target.style.left = `${Math.max(0, e.clientX - dx)}px`;
        target.style.top = `${Math.max(0, e.clientY - dy)}px`;
        target.style.right = "auto";
      };
      const up = () => {
        doc.removeEventListener("pointermove", move);
        doc.removeEventListener("pointerup", up);
      };
      doc.addEventListener("pointermove", move);
      doc.addEventListener("pointerup", up);
    });
  };

  const api = {
    host,
    render(next: OverlayState) {
      state = next;
      const key = JSON.stringify([next.views, next.log, next.settled, next.adjustments, next.notice, next.helper, collapsed]);
      if (key === lastKey) return;
      if (pressed || Date.now() < busyUntil) {
        deferred ??= setTimeout(flush, 200);
        return;
      }
      lastKey = key;
      draw();
    },
    setVisible(visible: boolean) {
      host.style.display = visible ? "" : "none";
    },
    destroy() {
      if (deferred) clearTimeout(deferred);
      host.remove();
    }
  };
  return api;
}
