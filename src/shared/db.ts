// Recovered from background.js (L5-L87) and popup/popup.js (L5-L91)
import { RECORDING_SCHEMA_VERSION, type AppendBatchInput, type Recording, type RecordingSummary } from "./schema";

const DB_NAME = "colonist-recorder";
const DB_VERSION = 2;
const MAX_SHOTS_PER_GAME = 14;

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise: Promise<IDBDatabase> | undefined;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const need = (name: string, keyPath: string | string[]) => {
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

export async function appendBatch(batch: AppendBatchInput): Promise<void> {
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
    if (!row.sockets.some((x: { index: number }) => x.index === s.index)) row.sockets.push(s);
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

function toSummary(row: any): RecordingSummary {
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

export async function listRecordings(): Promise<RecordingSummary[]> {
  const db = await openDb();
  const rows = await promisify(db.transaction("recordings").objectStore("recordings").getAll());
  return rows.map(toSummary).sort((a, b) => b.startedAt - a.startedAt);
}

export async function getRecording(id: string): Promise<Recording | undefined> {
  const db = await openDb();
  const tx = db.transaction(["recordings", "frames", "logs", "shots"]);
  const row = await promisify(tx.objectStore("recordings").get(id));
  if (!row) return undefined;
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
    frames: frames.map(({ t, dir, kind, data, socket }: any) => ({ t, dir, kind, data, socket })),
    log: logs.map(({ rid: _rid, seq: _seq, ...entry }: any) => entry),
    shots: shots.map(({ t, label, dataUrl }: any) => ({ t, label, dataUrl }))
  };
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["recordings", "frames", "logs", "shots"], "readwrite");
  const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
  tx.objectStore("recordings").delete(id);
  tx.objectStore("frames").delete(range);
  tx.objectStore("logs").delete(range);
  tx.objectStore("shots").delete(range);
  await txDone(tx);
}
