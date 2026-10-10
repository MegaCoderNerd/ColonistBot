// Recovered from content.js (lines 4880-4948)
import { decode, decodeMulti } from "@msgpack/msgpack";
import type { WsFrame } from "../shared/schema";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface DecodedFrame {
  frame: WsFrame;
  index: number;
  kind: "json" | "msgpack" | "unknown";
  value?: unknown;
  label: string;
}

export interface DecodeStats {
  totalFrames: number;
  jsonFrames: number;
  msgpackFrames: number;
  unknownFrames: number;
  typeCounts: Record<string, number>;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function tryJson(text: string): unknown {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first === "{" || first === "[") return JSON.parse(trimmed);
  const m = /^\d{1,3}(\[.*|\{.*)$/s.exec(trimmed);
  if (m) return JSON.parse(m[1]);
  throw new Error("not json");
}

export function tryMsgpack(bytes: Uint8Array): unknown {
  try {
    return decode(bytes);
  } catch {
    const all = [...decodeMulti(bytes)];
    if (all.length === 0) throw new Error("empty");
    return all.length === 1 ? all[0] : all;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function messageLabel(value: unknown): string {
  if (!isObject(value)) return Array.isArray(value) ? "array" : typeof value;
  const data = isObject(value.data) ? value.data : undefined;
  const parts: string[] = [];
  if (value.id !== undefined) parts.push(String(value.id));
  if (data?.type !== undefined) parts.push(String(data.type));
  else if (value.type !== undefined) parts.push(String(value.type));
  return parts.length ? parts.join("/") : `object{${Object.keys(value).slice(0, 3).join(",")}}`;
}

export function decodeFrame(frame: WsFrame, index: number): DecodedFrame {
  try {
    if (frame.kind === "text") {
      const value = tryJson(frame.data);
      return { frame, index, kind: "json", value, label: messageLabel(value) };
    }
    const bytes = base64ToBytes(frame.data);
    const first = bytes[0];
    if (first === 123 || first === 91) {
      try {
        const value = JSON.parse(new TextDecoder().decode(bytes));
        return { frame, index, kind: "json", value, label: messageLabel(value) };
      } catch {
        // Fall through to MessagePack
      }
    }
    const value = tryMsgpack(bytes);
    return { frame, index, kind: "msgpack", value, label: messageLabel(value) };
  } catch {
    return { frame, index, kind: "unknown", label: "undecodable" };
  }
}

export function decodeFrames(frames: WsFrame[]): { decoded: DecodedFrame[]; stats: DecodeStats } {
  const stats: DecodeStats = { totalFrames: frames.length, jsonFrames: 0, msgpackFrames: 0, unknownFrames: 0, typeCounts: {} };
  const decoded = frames.map((f, i) => {
    const d = decodeFrame(f, i);
    if (d.kind === "json") stats.jsonFrames++;
    else if (d.kind === "msgpack") stats.msgpackFrames++;
    else stats.unknownFrames++;
    stats.typeCounts[d.label] = (stats.typeCounts[d.label] ?? 0) + 1;
    return d;
  });
  return { decoded, stats };
}
