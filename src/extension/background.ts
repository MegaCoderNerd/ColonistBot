// Recovered from background.js (L89-L111)
import { api } from "./api";
import { appendBatch } from "../shared/db";

let queue: Promise<unknown> = Promise.resolve();

function enqueue(job: () => Promise<unknown>): void {
  queue = queue.then(job).catch((err) => console.error("[colonist-recorder]", err));
}

async function takeShot(message: any, windowId: number | undefined): Promise<void> {
  const base = { id: message.id, gameId: message.gameId, url: message.url, sockets: [], frames: [], log: [] };
  try {
    if (typeof api.tabs.captureVisibleTab !== "function") {
      throw new Error('screenshots are not enabled: open the popup and press "Allow screenshots"');
    }
    const dataUrl = await api.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 55 });
    await appendBatch({ ...base, shots: [{ t: message.t, label: message.label, dataUrl }] });
  } catch (err: any) {
    await appendBatch({ ...base, meta: { shotError: String(err?.message ?? err) } });
  }
}

api.runtime.onMessage.addListener((message: any, sender: any) => {
  if (message?.kind === "flush") enqueue(() => appendBatch(message));
  else if (message?.kind === "shot" && sender.tab?.active !== false) enqueue(() => takeShot(message, sender.tab?.windowId));
  return false;
});
