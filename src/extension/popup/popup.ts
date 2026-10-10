// Recovered from popup/popup.js (L103-L220)
import { deleteRecording, getRecording, listRecordings } from "../../shared/db";
import type { RecordingSummary } from "../../shared/schema";
import { api } from "../api";
import { FORCE_KEY, HELPER_KEY, ME_KEY, OVERLAY_KEY, WS_KEY } from "../bridge";

const $ = (id: string) => document.getElementById(id)!;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function download(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportOne(id: string): Promise<void> {
  const rec = await getRecording(id);
  if (rec) download(`colonist-${id}.json`, rec);
}

async function exportAll(): Promise<void> {
  const all = await listRecordings();
  const recordings = (await Promise.all(all.map((r) => getRecording(r.id)))).filter(Boolean);
  download(`colonist-recordings-${new Date().toISOString().slice(0, 10)}.json`, { recordings });
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderItem(r: RecordingSummary): HTMLElement {
  const li = el("li", "item");
  const seconds = Math.max(0, Math.round((r.endedAt - r.startedAt) / 1000));
  const sub = `${new Date(r.startedAt).toLocaleString()} - ${Math.floor(seconds / 60)}m ${seconds % 60}s - ${r.frameCount} frames - ${r.logCount} log rows - ${formatBytes(r.bytes)}`;
  const exportBtn = el("button", undefined, "Export");
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

async function refresh(): Promise<void> {
  const list = await listRecordings();
  const ul = $("list");
  ul.replaceChildren(...list.map(renderItem));
  $("count").textContent = list.length ? `(${list.length})` : "";
  $("empty").hidden = list.length > 0;
}

const COLONIST_ORIGINS = ["*://colonist.io/*", "*://*.colonist.io/*"];

async function showStatus(): Promise<void> {
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

const ALL_SITES = ["<all_urls>"];

async function showShots(): Promise<void> {
  const granted = await api.permissions.contains({ origins: ALL_SITES }).catch(() => false);
  const grant = $("shots-grant");
  $("shots-status").textContent = granted
    ? "Screenshots are on: board snapshots and each Game Over tab are saved with the game."
    : "Screenshots of the board and end screen need an extra permission (the browser can only capture a tab with all-sites access).";
  grant.hidden = granted;
  grant.onclick = async () => {
    const ok = await api.permissions.request({ origins: ALL_SITES }).catch(() => false);
    if (ok) await showShots();
  };
}

async function init(): Promise<void> {
  const stored = await api.storage.local.get([FORCE_KEY, ME_KEY, OVERLAY_KEY, WS_KEY, HELPER_KEY]);
  const force = $("force") as HTMLInputElement;
  const me = $("me") as HTMLInputElement;
  force.checked = Boolean(stored[FORCE_KEY]);
  me.value = typeof stored[ME_KEY] === "string" ? stored[ME_KEY] : "";
  const bind = (id: string, key: string, fallback: boolean) => {
    const box = $(id) as HTMLInputElement;
    box.checked = stored[key] === undefined ? fallback : Boolean(stored[key]);
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
  setInterval(() => void refresh(), 3000);
}

void init();
