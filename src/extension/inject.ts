// Recovered from inject.js (L5-L79)
import { BRIDGE_TAG } from "./bridge";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

function post(message: Record<string, unknown>): void {
  window.postMessage({ [BRIDGE_TAG]: true, ...message }, window.location.origin);
}

function stripUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return raw;
  }
}

function record(socket: number, dir: "in" | "out", data: unknown): void {
  const t = Date.now();
  if (typeof data === "string") {
    post({ type: "frame", frame: { t, dir, kind: "text", data, socket } });
  } else if (data instanceof ArrayBuffer) {
    post({ type: "frame", frame: { t, dir, kind: "binary", data: toBase64(new Uint8Array(data)), socket } });
  } else if (ArrayBuffer.isView(data)) {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    post({ type: "frame", frame: { t, dir, kind: "binary", data: toBase64(view), socket } });
  } else if (typeof Blob !== "undefined" && data instanceof Blob) {
    void data.arrayBuffer().then((buf) => {
      post({ type: "frame", frame: { t, dir, kind: "binary", data: toBase64(new Uint8Array(buf)), socket } });
    });
  }
}

function install(): void {
  if ((window as any).__colonistRecorderInstalled) return;
  (window as any).__colonistRecorderInstalled = true;
  const NativeWebSocket = window.WebSocket;
  let nextIndex = 0;
  let frameCount = 0;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget) as WebSocket;
      const url = String(args[0]);
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        return ws;
      }
      if (!host.endsWith("colonist.io")) return ws;
      const index = nextIndex++;
      post({ type: "socket", socket: { index, url: stripUrl(url), openedAt: Date.now() } });
      ws.addEventListener("message", (ev) => {
        frameCount++;
        record(index, "in", ev.data);
      });
      const nativeSend = ws.send;
      ws.send = function patchedSend(this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        try {
          record(index, "out", data);
        } catch {
        }
        return nativeSend.call(this, data);
      };
      return ws;
    }
  });
  const hello = () => post({ type: "hello", sockets: nextIndex, frames: frameCount });
  hello();
  window.setInterval(hello, 2000);
}

install();
