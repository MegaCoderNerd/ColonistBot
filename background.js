(() => {
  // src/extension/api.ts
  var api = globalThis.browser ?? chrome;

  // src/shared/db.ts
  var DB_NAME = "colonist-recorder";
  var DB_VERSION = 2;
  var MAX_SHOTS_PER_GAME = 14;
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
  async function appendBatch(batch) {
    const db = await openDb();
    const tx = db.transaction(["recordings", "frames", "logs", "shots"], "readwrite");
    const recordings = tx.objectStore("recordings");
    const existing = await promisify(recordings.get(batch.id));
    const row = existing ?? {
      id: batch.id,
      gameId: batch.gameId,
      url: batch.url,
      startedAt: Math.min(batch.frames[0]?.t ?? Infinity, batch.log[0]?.t ?? Infinity, Date.now()),
      endedAt: 0,
      sockets: [],
      meta: {},
      frameCount: 0,
      logCount: 0,
      bytes: 0
    };
    row.url = batch.url || row.url;
    row.gameId = batch.gameId || row.gameId;
    row.meta = { ...row.meta, ...batch.meta };
    for (const s of batch.sockets) {
      if (!row.sockets.some((x) => x.index === s.index)) row.sockets.push(s);
    }
    const frames = tx.objectStore("frames");
    for (const f of batch.frames) {
      const seq = row.frameCount++;
      row.bytes += f.data.length;
      row.endedAt = Math.max(row.endedAt, f.t);
      row.startedAt = Math.min(row.startedAt, f.t);
      frames.put({ ...f, rid: batch.id, seq });
    }
    const logs = tx.objectStore("logs");
    for (const l of batch.log) {
      const seq = row.logCount++;
      row.endedAt = Math.max(row.endedAt, l.t);
      logs.put({ ...l, rid: batch.id, seq });
    }
    if (batch.shots?.length) {
      const shots = tx.objectStore("shots");
      const have = await promisify(shots.count(IDBKeyRange.bound([batch.id, 0], [batch.id, Number.MAX_SAFE_INTEGER])));
      batch.shots.slice(0, Math.max(0, MAX_SHOTS_PER_GAME - have)).forEach((shot, i) => {
        shots.put({ ...shot, rid: batch.id, seq: have + i });
      });
    }
    recordings.put(row);
    await txDone(tx);
  }

  // src/extension/background.ts
  var queue = Promise.resolve();
  function enqueue(job) {
    queue = queue.then(job).catch((err) => console.error("[colonist-recorder]", err));
  }
  async function takeShot(message, windowId) {
    const base = { id: message.id, gameId: message.gameId, url: message.url, sockets: [], frames: [], log: [] };
    try {
      if (typeof api.tabs.captureVisibleTab !== "function") {
        throw new Error('screenshots are not enabled: open the popup and press "Allow screenshots"');
      }
      const dataUrl = await api.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 55 });
      await appendBatch({ ...base, shots: [{ t: message.t, label: message.label, dataUrl }] });
    } catch (err) {
      await appendBatch({ ...base, meta: { shotError: String(err?.message ?? err) } });
    }
  }
  api.runtime.onMessage.addListener((message, sender) => {
    if (message?.kind === "flush") enqueue(() => appendBatch(message));
    else if (message?.kind === "shot" && sender.tab?.active !== false) enqueue(() => takeShot(message, sender.tab?.windowId));
    return false;
  });
})();
