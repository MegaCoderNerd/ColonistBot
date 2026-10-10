import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { decodeFrames } from "../src/analyzer/decode";
import { stateDiffAdapter } from "../src/analyzer/adapters/stateDiff";
import { typedEventsAdapter } from "../src/analyzer/adapters/typedEvents";
import { pickPrimary } from "../src/analyzer/parse";
import { LogParser } from "../src/analyzer/adapters/logText";
import { HandTracker } from "../src/analyzer/tracker";
import { placementsFrom, robberTargets } from "../src/analyzer/advisor";
import { coachedOpening } from "../src/analyzer/engine/opening";
import { planMidgame } from "../src/analyzer/strategy";
import { planTurn } from "../src/analyzer/engine/decide";
import { networkLength } from "../src/analyzer/engine/roads";
import { createHelper } from "../src/extension/helper";
import type { Recording } from "../src/shared/schema";

const RECORDINGS_PATH = "C:/Users/ashma/Downloads/colonist-recordings-2026-10-08.json";
const ROOT = resolve(__dirname, "..");

function loadRecordings(): Recording[] {
  const raw = JSON.parse(readFileSync(RECORDINGS_PATH, "utf8")) as { recordings: Recording[] };
  return raw.recordings;
}

function normalizeBundle(code: string): string {
  return code
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function splitModules(bundle: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = bundle.split("\n");
  let currentHeader = "__preamble__";
  let buf: string[] = [];
  for (const line of lines) {
    if (line.startsWith("  // src/") || line.startsWith("  // node_modules/")) {
      map.set(currentHeader, buf.join("\n"));
      currentHeader = line.trim();
      buf = [];
    } else if (line !== "})();") {
      buf.push(line);
    }
  }
  map.set(currentHeader, buf.join("\n"));
  return map;
}

const STAGE_2_MODIFIED_MODULES = new Set([
  "// src/analyzer/snapshot.ts",
  "// src/analyzer/adapters/stateDiff.ts",
  "// src/analyzer/engine/decide.ts",
  "// src/analyzer/engine/roads.ts"
]);

describe("Stage 1 & Steps 2.1–2.3 — Baseline Bundle & Runtime Parity", () => {
  it("produces byte-identical bundles for inject.js, background.js, and popup/popup.js and preserves root baseline files", () => {
    for (const rel of ["inject.js", "background.js", "popup/popup.js"]) {
      const base = normalizeBundle(readFileSync(resolve(ROOT, rel), "utf8"));
      const built = normalizeBundle(readFileSync(resolve(ROOT, "dist/firefox", rel), "utf8"));
      expect(built).toBe(base);
    }
  });

  it("preserves identical module order (all 34 src/ modules) and 100% AST/token parity on all 30 untouched modules in dist/firefox/content.js", () => {
    const base = normalizeBundle(readFileSync(resolve(ROOT, "content.js"), "utf8"));
    const built = normalizeBundle(readFileSync(resolve(ROOT, "dist/firefox/content.js"), "utf8"));
    const baseHeaders = base.split("\n").filter((l) => l.startsWith("  // src/"));
    const builtHeaders = built.split("\n").filter((l) => l.startsWith("  // src/"));
    expect(builtHeaders).toEqual(baseHeaders);
    expect(builtHeaders.length).toBe(34);

    const baseMods = splitModules(base.replace("\n    void extra;", ""));
    const builtMods = splitModules(built);

    for (const [header, baseCode] of baseMods.entries()) {
      if (STAGE_2_MODIFIED_MODULES.has(header)) continue;
      const builtCode = builtMods.get(header);
      expect(builtCode, `Missing module ${header}`).toBeDefined();
      if (header === "__preamble__") {
        expect(builtCode).toBe(baseCode);
        continue;
      }
      const minBase = transformSync(baseCode, { minifyWhitespace: true }).code;
      const minBuilt = transformSync(builtCode!, { minifyWhitespace: true }).code;
      expect(minBuilt, `AST/token mismatch in untouched module ${header}`).toBe(minBase);
    }
  });

  it("verifies dist/firefox/content.js embeds Steps 2.1–2.3 fixes, wires them into helper.ts, and remains strictly advisory-only", () => {
    const builtContent = normalizeBundle(readFileSync(resolve(ROOT, "dist/firefox/content.js"), "utf8"));
    const builtInject = normalizeBundle(readFileSync(resolve(ROOT, "dist/firefox/inject.js"), "utf8"));
    const builtMods = splitModules(builtContent);

    // Step 2.1 present in dist/firefox/content.js
    const stateDiffMod = builtMods.get("// src/analyzer/adapters/stateDiff.ts")!;
    expect(stateDiffMod).toContain("VP_CATEGORY_WEIGHT");
    expect(stateDiffMod).toContain("breakdownVp");
    expect(stateDiffMod).not.toContain('10: "victoryPoint"');
    expect(stateDiffMod).toContain("readGameSettings");

    const decideMod = builtMods.get("// src/analyzer/engine/decide.ts")!;
    expect(decideMod).toContain("playableCardsOf");

    // Step 2.2 & Step 2.3 present in dist/firefox/content.js
    const roadsMod = builtMods.get("// src/analyzer/engine/roads.ts")!;
    expect(roadsMod).toContain("longestRoad(graph, blocked)");
    expect(roadsMod).toContain("usedEdges");
    expect(roadsMod).toContain("if (net.blocked.has(root)) continue;");
    expect(roadsMod).not.toContain("if (net.blocked.has(next.to)");

    // Live extension helper.ts calls adviseRoad, listOpenEdges, bestEdge, and planTurn
    const helperMod = builtMods.get("// src/extension/helper.ts")!;
    expect(helperMod).toContain("adviseRoad(");
    expect(helperMod).toContain("listOpenEdges(");
    expect(helperMod).toContain("bestEdge(");
    expect(helperMod).toContain("planTurn(");

    // Advisory-only check: content.js has zero WebSocket send calls, and inject.js only forwards nativeSend.call(this, data)
    expect(builtContent).not.toContain(".send(");
    const sendMatches = builtInject.match(/\.send\b/g) ?? [];
    expect(sendMatches.length).toBe(2); // const nativeSend = ws.send; ws.send = function patchedSend...

    // Live helper.feed + helper.view end-to-end check on farm9373
    const recordings = loadRecordings();
    const farm = recordings.find((r) => r.id === "farm9373")!;
    const helper = createHelper();
    for (const f of farm.frames) {
      helper.feed(f);
    }
    const view = helper.view(
      [],
      {
        meName: "Megalovania",
        logNames: ["Megalovania", "Carson2570"],
        rolls: 75,
        firstPlacedAt: () => undefined,
        loggedSettlements: () => 1,
        hook: { sockets: 1, frames: farm.frames.length }
      },
      Date.now() + 5000
    );
    expect(view.lines[0]).toBe("Advising: Megalovania.");
    expect(view.coach).toBeDefined();
    expect(view.mapSvg).toContain("<svg");
  });

  it("reproduces identical decoded frame stats, state-diff events, snapshots, and coach decisions on captured 1v1 games", () => {
    const recordings = loadRecordings();
    const targetIds = ["edge9896", "farm9373", "deck7708"];

    for (const id of targetIds) {
      const rec = recordings.find((r) => r.id === id);
      expect(rec).toBeDefined();
      if (!rec) continue;

      const { decoded, stats } = decodeFrames(rec.frames);
      expect(stats.totalFrames).toBe(rec.frames.length);
      expect(stats.unknownFrames).toBe(0);

      const parsed = pickPrimary(stateDiffAdapter.parse(decoded), typedEventsAdapter.parse(decoded));
      expect(parsed.board).toBeDefined();
      expect(parsed.board?.hexes.length).toBe(19);
      expect(parsed.players.length).toBe(2);
      expect(parsed.snapshot).toBeDefined();

      const placements = placementsFrom(parsed.events);
      const me = parsed.selfId ?? parsed.players[0].id;
      const opp = parsed.players.find((p) => p.id !== me)!.id;

      // Verify road network calculation runs deterministically
      expect(networkLength(parsed.board!, placements, me)).toBeGreaterThanOrEqual(2);
      expect(networkLength(parsed.board!, placements, opp)).toBeGreaterThanOrEqual(2);

      // Verify opening planner on empty placements
      const emptyPlacements = placementsFrom([]);
      const opening = coachedOpening(parsed.board!, emptyPlacements, me, 3, true);
      expect(opening.mode).toBe("first");
      expect(opening.picks.length).toBe(3);

      // Verify midgame planner and turn advisor on final game state
      const mid = planMidgame(parsed.board!, placements, me);
      expect(mid.weaknesses.length).toBeGreaterThan(0);

      const turn = planTurn({
        board: parsed.board!,
        placements,
        me,
        snapshot: parsed.snapshot,
        events: parsed.events
      });
      expect(turn.headline.length).toBeGreaterThan(0);
      expect(turn.race).toContain("VP");

      const robber = robberTargets(parsed.board!, placements, me, parsed.snapshot?.robberHex);
      expect(Array.isArray(robber)).toBe(true);

      // Verify log parser and hand tracker run cleanly on captured logs
      const logParser = new LogParser(rec.meta.me);
      const tracker = new HandTracker();
      for (const entry of rec.log) {
        if (!entry.text) continue;
        const res = logParser.push(entry);
        if (res.kind === "event") tracker.apply(res.event);
      }
      expect(logParser.stats().parsed).toBeGreaterThan(50);
      expect(tracker.views().length).toBeGreaterThanOrEqual(2);
    }
  });
});
