/**
 * Loads the local Colonist recording bundle once per process.
 *
 * The bundle is `{ recordings: Recording[] }`. It is regression input only.
 * Callers must not mutate the returned objects; the array is cached and shared
 * when Vitest isolation is off.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Recording } from "../../shared/schema";

export const RECORDINGS_ENV = "COLONIST_RECORDINGS_PATH";
export const RECORDINGS_STRICT_ENV = "COLONIST_RECORDINGS_STRICT";

const FALLBACKS = ["fixtures/colonist-recordings.json", "colonist-recordings.json"] as const;

export interface RecordingCorpus {
  readonly path?: string;
  readonly recordings: readonly Recording[];
  readonly rejected: readonly string[];
}

let cached: { path: string; mtimeMs: number; corpus: RecordingCorpus } | undefined;

export function recordingsStrict(): boolean {
  return process.env[RECORDINGS_STRICT_ENV] === "1";
}

export function resolveRecordingCorpusPath(rootDir: string): string | undefined {
  const fromEnv = process.env[RECORDINGS_ENV];
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      if (recordingsStrict()) {
        throw new Error(`${RECORDINGS_ENV} does not exist: ${fromEnv}`);
      }
      return undefined;
    }
    return fromEnv;
  }
  for (const candidate of FALLBACKS) {
    const full = resolve(rootDir, candidate);
    if (existsSync(full)) return full;
  }
  if (recordingsStrict()) {
    throw new Error(`${RECORDINGS_ENV} is required in strict recording mode and no fallback bundle was found.`);
  }
  return undefined;
}

function asRecording(value: unknown, index: number): Recording | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `index ${index} is not an object`;
  }
  const record = value as Partial<Recording>;
  if (record.schemaVersion !== 1) return `index ${index} schemaVersion is not 1`;
  if (typeof record.id !== "string" || record.id.length === 0) return `index ${index} has no id`;
  if (typeof record.gameId !== "string" || record.gameId.length === 0) return `index ${index} has no gameId`;
  if (!Array.isArray(record.frames)) return `${record.id} has no frames array`;
  if (!Array.isArray(record.log)) return `${record.id} has no log array`;
  if (!Array.isArray(record.sockets)) return `${record.id} has no sockets array`;
  return record as Recording;
}

export function loadRecordingCorpus(rootDir: string): RecordingCorpus {
  const path = resolveRecordingCorpusPath(rootDir);
  if (!path) return { recordings: [], rejected: [] };
  const mtimeMs = statSync(path).mtimeMs;
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.corpus;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Recording bundle ${path} is unreadable or malformed JSON: ${message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as { recordings?: unknown }).recordings)) {
    throw new Error(`Recording bundle ${path} must be an object with a recordings array.`);
  }
  const accepted: Recording[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (raw as { recordings: unknown[] }).recordings.entries()) {
    const parsed = asRecording(entry, index);
    if (typeof parsed === "string") {
      rejected.push(parsed);
      continue;
    }
    if (seen.has(parsed.id)) {
      rejected.push(`${parsed.id} is a duplicate id`);
      continue;
    }
    seen.add(parsed.id);
    Object.freeze(parsed.frames);
    Object.freeze(parsed.log);
    Object.freeze(parsed);
    accepted.push(parsed);
  }
  const corpus: RecordingCorpus = { path, recordings: Object.freeze(accepted), rejected: Object.freeze(rejected) };
  cached = { path, mtimeMs, corpus };
  return corpus;
}

export function requireRecording(recordings: readonly Recording[], id: string): Recording {
  const found = recordings.find((recording) => recording.id === id);
  if (!found) {
    throw new Error(
      `Uncovered recording scenario: ${id} is not in this corpus (${recordings.length} recordings). The test was not rewritten to use a different game.`
    );
  }
  return found;
}
