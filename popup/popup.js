(() => {
  // src/shared/schema.ts
  var RECORDING_SCHEMA_VERSION = 1;

  // src/shared/db.ts
  var DB_NAME = "colonist-recorder";
  var DB_VERSION = 2;
  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  var dbPromise;
  function openDb() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const need = (name, keyPath) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
        };
        need("recordings", "id");
        need("frames", ["rid", "seq"]);
        need("logs", ["rid", "seq"]);
        need("shots", ["rid", "seq"]);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  function toSummary(row) {
    return {
      id: row.id,
      gameId: row.gameId,
      url: row.url,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      frameCount: row.frameCount,
      logCount: row.logCount,
      bytes: row.bytes
    };
  }
  async function listRecordings() {
    const db = await openDb();
    const rows = await promisify(db.transaction("recordings").objectStore("recordings").getAll());
    return rows.map(toSummary).sort((a, b) => b.startedAt - a.startedAt);
  }
  async function getRecording(id) {
    const db = await openDb();
    const tx = db.transaction(["recordings", "frames", "logs", "shots"]);
    const row = await promisify(tx.objectStore("recordings").get(id));
    if (!row) return void 0;
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    const [frames, logs, shots] = await Promise.all([
      promisify(tx.objectStore("frames").getAll(range)),
      promisify(tx.objectStore("logs").getAll(range)),
      promisify(tx.objectStore("shots").getAll(range))
    ]);
    return {
      schemaVersion: RECORDING_SCHEMA_VERSION,
      id: row.id,
      gameId: row.gameId,
      url: row.url,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      sockets: row.sockets,
      meta: row.meta,
      frames: frames.map(({ t, dir, kind, data, socket }) => ({ t, dir, kind, data, socket })),
      log: logs.map(({ rid: _rid, seq: _seq, ...entry }) => entry),
      shots: shots.map(({ t, label, dataUrl }) => ({ t, label, dataUrl }))
    };
  }
  async function deleteRecording(id) {
    const db = await openDb();
    const tx = db.transaction(["recordings", "frames", "logs", "shots"], "readwrite");
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    tx.objectStore("recordings").delete(id);
    tx.objectStore("frames").delete(range);
    tx.objectStore("logs").delete(range);
    tx.objectStore("shots").delete(range);
    await txDone(tx);
  }

  // src/extension/api.ts
  var api = globalThis.browser ?? chrome;

  // src/extension/bridge.ts
  var FORCE_KEY = "forceRecord";
  var ME_KEY = "me";
  var OVERLAY_KEY = "overlay";
  var WS_KEY = "recordWs";
  var HELPER_KEY = "helper";

  // src/extension/popup/popup.ts
  var $ = (id) => document.getElementById(id);
  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  function download(filename, data) {
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  async function exportOne(id) {
    const rec = await getRecording(id);
    if (rec) download(`colonist-${id}.json`, rec);
  }
  async function exportAll() {
    const all = await listRecordings();
    const recordings = (await Promise.all(all.map((r) => getRecording(r.id)))).filter(Boolean);
    download(`colonist-recordings-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`, { recordings });
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== void 0) node.textContent = text;
    return node;
  }
  function renderItem(r) {
    const li = el("li", "item");
    const seconds = Math.max(0, Math.round((r.endedAt - r.startedAt) / 1e3));
    const sub = `${new Date(r.startedAt).toLocaleString()} - ${Math.floor(seconds / 60)}m ${seconds % 60}s - ${r.frameCount} frames - ${r.logCount} log rows - ${formatBytes(r.bytes)}`;
    const exportBtn = el("button", void 0, "Export");
    exportBtn.addEventListener("click", () => void exportOne(r.id));
    const deleteBtn = el("button", "danger", "Delete");
    deleteBtn.addEventListener("click", async () => {
      if (confirm("Delete this recording?")) {
        await deleteRecording(r.id);
        void refresh();
      }
    });
    const actions = el("span", "actions");
    actions.append(exportBtn, deleteBtn);
    li.append(el("span", "name", r.gameId ? `Game ${r.gameId}` : "Session (no game id)"), el("span", "sub", sub), actions);
    return li;
  }
  async function refresh() {
    const list = await listRecordings();
    const ul = $("list");
    ul.replaceChildren(...list.map(renderItem));
    $("count").textContent = list.length ? `(${list.length})` : "";
    $("empty").hidden = list.length > 0;
  }
  var COLONIST_ORIGINS = ["*://colonist.io/*", "*://*.colonist.io/*"];
  async function showStatus() {
    const el2 = $("status");
    const grant = $("grant");
    const allowed = await api.permissions.contains({ origins: COLONIST_ORIGINS }).catch(() => true);
    if (!allowed) {
      el2.classList.remove("live");
      el2.textContent = "Not recording: Firefox has not given this add-on access to colonist.io yet.";
      grant.hidden = false;
      grant.onclick = async () => {
        const ok = await api.permissions.request({ origins: COLONIST_ORIGINS }).catch(() => false);
        if (ok) await showStatus();
      };
      return;
    }
    grant.hidden = true;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const onColonist = Boolean(tab?.url && /^https?:\/\/([^/]+\.)?colonist\.io\//.test(tab.url));
    if (!onColonist) {
      el2.classList.remove("live");
      el2.textContent = "Open a colonist.io tab to record. Recording is automatic.";
      return;
    }
    el2.classList.add("live");
    el2.textContent = "Recording this tab. If no game appears below, reload the colonist.io tab once.";
  }
  var ALL_SITES = ["<all_urls>"];
  async function showShots() {
    const granted = await api.permissions.contains({ origins: ALL_SITES }).catch(() => false);
    const grant = $("shots-grant");
    $("shots-status").textContent = granted ? "Screenshots are on: board snapshots and each Game Over tab are saved with the game." : "Screenshots of the board and end screen need an extra permission (the browser can only capture a tab with all-sites access).";
    grant.hidden = granted;
    grant.onclick = async () => {
      const ok = await api.permissions.request({ origins: ALL_SITES }).catch(() => false);
      if (ok) await showShots();
    };
  }
  async function init() {
    const stored = await api.storage.local.get([FORCE_KEY, ME_KEY, OVERLAY_KEY, WS_KEY, HELPER_KEY]);
    const force = $("force");
    const me = $("me");
    force.checked = Boolean(stored[FORCE_KEY]);
    me.value = typeof stored[ME_KEY] === "string" ? stored[ME_KEY] : "";
    const bind = (id, key, fallback) => {
      const box = $(id);
      box.checked = stored[key] === void 0 ? fallback : Boolean(stored[key]);
      box.addEventListener("change", () => void api.storage.local.set({ [key]: box.checked }));
    };
    bind("overlay", OVERLAY_KEY, true);
    bind("ws", WS_KEY, true);
    bind("helper", HELPER_KEY, false);
    force.addEventListener("change", () => void api.storage.local.set({ [FORCE_KEY]: force.checked }));
    me.addEventListener("change", () => void api.storage.local.set({ [ME_KEY]: me.value.trim() }));
    $("export-all").addEventListener("click", () => void exportAll());
    $("dashboard").addEventListener("click", () => {
      void api.tabs.create({ url: api.runtime.getURL("dashboard/index.html") });
    });
    await Promise.all([showStatus(), showShots(), refresh()]);
    setInterval(() => void refresh(), 3e3);
  }
  void init();
})();
