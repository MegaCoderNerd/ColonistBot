// Recovered from content.js (lines 6188-6540)
import { api } from "./api";
import { SEL } from "./selectors";
import { scrapePanel } from "./logScrape";
import { createLogCapture } from "./logCapture";
import { LiveEngine } from "./liveEngine";
import { DEFAULT_VIEW, mirrorView, normalizeView, turnView } from "../analyzer/geometry";
import { createEndPrompt, createEndScreen } from "./endscreen";
import { createHelper } from "./helper";
import { createOverlay } from "./overlay";
import { BRIDGE_TAG, FORCE_KEY, gameIdFromLocation, HELPER_KEY, MAPVIEW_KEY, ME_KEY, OVERLAY_KEY, WS_KEY } from "./bridge";
import type { FlushMessage, HintEntry, LogEntry, MapView, PanelSnapshot, RecordingMeta, ShotMessage, SocketInfo, WsFrame } from "../shared/schema";

const FLUSH_INTERVAL_MS = 1000;
const PREROLL_MS = 15000;
const PREROLL_MAX = 400;
const NON_GAME_HASHES = new Set(["lobby", "home", "play", "settings", "profile", "store", "leaderboard"]);

const sessionStart = Date.now();
let forceRecord = false;
let me = "";
let overlayEnabled = true;
let recordWs = true;
let helperEnabled = false;
let mapView: MapView = DEFAULT_VIEW;
let overlayHidden = false;
let currentId = "";
let currentGameId = "";
let sockets: SocketInfo[] = [];
const knownSockets: SocketInfo[] = [];
let hook: { at: number; sockets: number; frames: number } | undefined;
let ringFrames: WsFrame[] = [];
let ringLog: LogEntry[] = [];
let pendingFrames: WsFrame[] = [];
let pendingLog: LogEntry[] = [];
let pendingMeta: Partial<RecordingMeta> = {};
let segmentIdx = new Set<number>();

function detectGameId(): string {
  const id = gameIdFromLocation(window.location);
  return NON_GAME_HASHES.has(id.toLowerCase()) ? "" : id;
}

function trimRing() {
  const cutoff = Date.now() - PREROLL_MS;
  ringFrames = ringFrames.filter((f) => f.t >= cutoff).slice(-PREROLL_MAX);
  ringLog = ringLog.filter((l) => l.t >= cutoff).slice(-PREROLL_MAX);
}

function startSegment(id: string, gameId: string) {
  flush();
  currentId = id;
  currentGameId = gameId;
  endHandled = "";
  finalShotTaken = false;
  boardShots = 0;
  lastBoardShot = Date.now();
  lastPanelKey = "";
  overlayHidden = false;
  hints = [];
  hintsDirty = false;
  capture.reset();
  engine.reset();
  endScreen.reset();
  sockets = [...knownSockets];
  pendingFrames = ringFrames.splice(0);
  pendingLog = ringLog.splice(0);
  segmentIdx = new Set(pendingLog.flatMap((l) => (l.idx === undefined ? [] : [l.idx])));
  for (const l of pendingLog) engine.addEntry(l);
  void loadAdjustments(id);
}

function syncSegment() {
  const gameId = detectGameId();
  if (gameId) {
    if (gameId !== currentGameId) startSegment(gameId, gameId);
  } else if (forceRecord && !currentId) {
    startSegment(`session-${sessionStart}`, "");
  }
}

function onFrame(frame: WsFrame) {
  if (helperEnabled || recordWs) helper.feed(frame);
  if (!recordWs) return;
  syncSegment();
  if (currentId) pendingFrames.push(frame);
  else {
    ringFrames.push(frame);
    trimRing();
  }
}

function onLog(entry: LogEntry) {
  syncSegment();
  if (entry.idx !== undefined && currentId) {
    if (segmentIdx.has(entry.idx)) return;
    segmentIdx.add(entry.idx);
  }
  if (END_RE.test(entry.text)) onGameEnd();
  if (currentId) {
    pendingLog.push(entry);
    engine.addEntry(entry);
  } else {
    ringLog.push(entry);
    trimRing();
  }
}

function flush() {
  if (!currentId || (!pendingFrames.length && !pendingLog.length && !sockets.length && !Object.keys(pendingMeta).length && !hintsDirty)) return;
  const message: FlushMessage = {
    kind: "flush",
    id: currentId,
    gameId: currentGameId,
    url: window.location.href,
    sockets,
    frames: pendingFrames,
    log: pendingLog,
    meta: { me: me || undefined, userAgent: navigator.userAgent, ...pendingMeta, ...(hintsDirty ? { hints: hints.slice() } : {}) }
  };
  hintsDirty = false;
  pendingFrames = [];
  pendingLog = [];
  pendingMeta = {};
  sockets = [];
  try {
    void api.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // Ignore extension messaging failure
  }
}

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.origin !== window.location.origin) return;
  const data = ev.data;
  if (!data || data[BRIDGE_TAG] !== true) return;
  if (data.type === "frame") onFrame(data.frame);
  else if (data.type === "hello") hook = { at: Date.now(), sockets: data.sockets, frames: data.frames };
  else if (data.type === "socket") {
    knownSockets.push(data.socket);
    sockets.push(data.socket);
  }
});

const END_RE = /\bwon the game\b/i;
let endHandled = "";
let lastPanelKey = "";
const capture = createLogCapture(document, (entry) => onLog(entry));

function onGameEnd() {
  const id = currentId;
  if (!id || endHandled === id) return;
  endHandled = id;
  setTimeout(() => {
    void capture.sweep("game end").then(() => {
      if (id === currentId) pendingMeta = { ...pendingMeta, logGaps: capture.status().missing };
    });
  }, 1200);
}

function snapshotPanel(): PanelSnapshot | undefined {
  const snap = scrapePanel(document, capture.status().maxIdx);
  if (!snap) return undefined;
  const key = JSON.stringify(snap.players.map((p) => [p.color, p.cards, p.stats.map((s) => s.value)]));
  if (key !== lastPanelKey) {
    lastPanelKey = key;
    onLog({ t: Date.now(), text: "", panel: snap });
  }
  return snap;
}

const engine = new LiveEngine();
const helper = createHelper();
const BOARD_SHOT_EVERY_MS = 4 * 60000;
const MAX_BOARD_SHOTS = 6;
let finalShotTaken = false;
let boardShots = 0;
let lastBoardShot = Date.now();
let promptUntil = 0;
let promptNote = "";

function requestShot(label: string) {
  if (!currentId) return;
  const message: ShotMessage = { kind: "shot", id: currentId, gameId: currentGameId, url: window.location.href, label, t: Date.now() };
  try {
    void api.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // Ignore extension messaging failure
  }
}

const endScreen = createEndScreen(document, {
  names: () => engine.views().map((v) => v.name),
  onCapture(end, tab, isNew) {
    if (!currentId) return;
    pendingMeta = { ...pendingMeta, endScreen: JSON.parse(JSON.stringify(end)), endScreenText: Object.values(end.tabs).map((t) => t.text).join("\n") };
    if (isNew) setTimeout(() => requestShot(`Game over: ${tab}`), 150);
  },
  onClosed() {
    if (!currentId || finalShotTaken) return;
    finalShotTaken = true;
    const missing = endScreen.state().missing;
    promptNote = missing.length ? `Window closed with ${missing.length} tabs unsaved (${missing.join(", ")}). Final board saved.` : "All stats saved. Final board saved.";
    promptUntil = Date.now() + 8000;
    setTimeout(() => requestShot("Final board"), 900);
  }
});

const endPrompt = createEndPrompt(document);

function renderPrompt() {
  const s = endScreen.state();
  const note = Date.now() < promptUntil ? promptNote : "";
  const show = overlayEnabled && Boolean(currentId) && (s.open || Boolean(note));
  if (show && !endPrompt.host.isConnected) document.documentElement.append(endPrompt.host);
  endPrompt.setVisible(show);
  if (show) endPrompt.render(s, note ? { done: note } : undefined);
}

function maybeBoardShot() {
  if (!currentId || endScreen.state().open || boardShots >= MAX_BOARD_SHOTS) return;
  if (engine.rowCount() < 10 || Date.now() - lastBoardShot < BOARD_SHOT_EVERY_MS) return;
  lastBoardShot = Date.now();
  boardShots++;
  requestShot(`Board after ${engine.rowCount()} log rows`);
}

const overlay = createOverlay(document, {
  adjust(name, resource, delta) {
    engine.adjust(name, resource, delta);
    saveAdjustments();
    renderOverlay();
  },
  sweep() {
    void capture.sweep("manual").then(renderOverlay);
    renderOverlay();
  },
  clearAdjustments() {
    engine.clearAdjustments();
    saveAdjustments();
    renderOverlay();
  },
  hide() {
    overlayHidden = true;
    renderOverlay();
  },
  pickMe(name) {
    me = name;
    void api.storage.local.set({ [ME_KEY]: name }).catch(() => undefined);
    renderOverlay();
  },
  turnMap(steps) {
    setMapView(turnView(mapView, steps));
  },
  flipMap(vertical) {
    setMapView(mirrorView(mapView, vertical));
  }
});

function setMapView(next: MapView) {
  mapView = normalizeView(next);
  void api.storage.local.set({ [MAPVIEW_KEY]: mapView }).catch(() => undefined);
  renderOverlay();
}

const sameNameLoose = (a: string, b: string) => {
  const norm = (n: string) => n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return norm(a).length > 0 && norm(a) === norm(b);
};

function liveViews() {
  const views = engine.views();
  const own = helper.selfHand();
  const sizes = helper.handSizes();
  const name = viewerName();
  return views.map((v) => {
    const isOwn = Boolean(own && ((own.name && sameNameLoose(v.name, own.name)) || (name && sameNameLoose(v.name, name)) || v.name === "You"));
    const size = sizes.find((s) => sameNameLoose(s.name, v.name))?.size;
    let next = v;
    if (isOwn && own) {
      const total = Object.values(own.hand).reduce((a, b) => a + b, 0);
      next = { ...next, hand: own.hand, unknown: 0, total, warnings: [], exact: true };
    }
    const cards = size ?? next.panelCards;
    if (cards !== undefined) next = { ...next, panelCards: cards, delta: cards - next.total, synced: cards === next.total };
    return next;
  });
}

const adjKey = (id: string) => `adj:${id}`;

function saveAdjustments() {
  if (!currentId) return;
  void api.storage.local.set({ [adjKey(currentId)]: engine.adjustmentsJSON() }).catch(() => undefined);
}

async function loadAdjustments(id: string) {
  try {
    const stored = await api.storage.local.get(adjKey(id));
    const saved = stored[adjKey(id)] as Record<string, number> | undefined;
    if (saved && id === currentId) engine.loadAdjustments(saved);
  } catch {
    // Ignore storage read errors
  }
}

function viewerName(): string {
  if (me) return me;
  return (document.querySelector(SEL.headerUsername)?.textContent ?? "").trim();
}

let hints: HintEntry[] = [];
let hintsDirty = false;

function noteAdvice(advice?: { phase: "opening" | "midgame"; text: string; at?: string }) {
  if (!advice || !currentId) return;
  const last = hints[hints.length - 1];
  if (last && last.text === advice.text && last.at === advice.at) return;
  hints.push({ t: Date.now(), phase: advice.phase, text: advice.text, at: advice.at });
  if (hints.length > 60) hints.splice(0, hints.length - 60);
  hintsDirty = true;
}

function renderOverlay() {
  const show = overlayEnabled && !overlayHidden && Boolean(currentId) && engine.rowCount() > 0;
  if (!show) {
    overlay.setVisible(false);
    return;
  }
  if (!overlay.host.isConnected) document.documentElement.append(overlay.host);
  overlay.setVisible(true);
  const status = capture.status();
  const views = liveViews();
  const helperView = helperEnabled
    ? helper.view(views, {
        meName: viewerName() || undefined,
        logNames: views.map((v) => v.name),
        rolls: engine.rolls(),
        firstPlacedAt: (n) => engine.firstPlacedAt(n),
        loggedSettlements: (n) => engine.loggedSettlements(n),
        mapView,
        hook: hook && Date.now() - hook.at < 6000 ? { sockets: hook.sockets, frames: hook.frames } : undefined
      })
    : undefined;
  noteAdvice(helperView?.advice);
  overlay.render({
    views,
    me: viewerName() || undefined,
    log: { rows: engine.rowCount(), missing: status.missing, sweeping: status.sweeping },
    settled: Date.now() - engine.lastRowAt > 1500,
    adjustments: engine.adjustmentCount(),
    helper: helperView,
    notice: status.missing > 0 && !status.sweeping ? `${status.missing} log rows have not been read yet. Counts may be off until they are (press rebuild).` : undefined
  });
}

void api.storage.local.get([FORCE_KEY, ME_KEY, OVERLAY_KEY, WS_KEY, HELPER_KEY, MAPVIEW_KEY]).then((v) => {
  mapView = normalizeView(v[MAPVIEW_KEY]);
  forceRecord = Boolean(v[FORCE_KEY]);
  me = typeof v[ME_KEY] === "string" ? v[ME_KEY] : "";
  overlayEnabled = v[OVERLAY_KEY] !== false;
  recordWs = v[WS_KEY] !== false;
  helperEnabled = v[HELPER_KEY] === true;
});

api.storage.onChanged.addListener((changes) => {
  if (changes[FORCE_KEY]) forceRecord = Boolean(changes[FORCE_KEY].newValue);
  if (changes[ME_KEY]) me = String(changes[ME_KEY].newValue ?? "");
  if (changes[OVERLAY_KEY]) {
    overlayEnabled = changes[OVERLAY_KEY].newValue !== false;
    if (overlayEnabled) overlayHidden = false;
  }
  if (changes[WS_KEY]) recordWs = changes[WS_KEY].newValue !== false;
  if (changes[HELPER_KEY]) helperEnabled = changes[HELPER_KEY].newValue === true;
  if (changes[MAPVIEW_KEY]) mapView = normalizeView(changes[MAPVIEW_KEY].newValue);
});

window.addEventListener("hashchange", syncSegment);
window.addEventListener("popstate", syncSegment);
window.addEventListener("pagehide", flush);

setInterval(() => {
  syncSegment();
  capture.tick();
  if (currentId) {
    maybeBoardShot();
    const snap = snapshotPanel();
    engine.setMe(viewerName() || undefined);
    engine.setPanel(snap);
  }
  const gaps = capture.status();
  if (currentId && gaps.maxIdx >= 0) pendingMeta = { ...pendingMeta, logGaps: gaps.missing };
  renderOverlay();
  renderPrompt();
  flush();
}, FLUSH_INTERVAL_MS);

setInterval(() => {
  if (!currentId) return;
  endScreen.tick();
  renderPrompt();
}, 300);

capture.start();
