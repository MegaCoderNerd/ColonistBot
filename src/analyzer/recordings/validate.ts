/**
 * Corpus check for the local recording bundle. Prints a summary and writes a
 * coverage file with no frame bodies and no player names.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decodeFrames } from "../decode";
import { stateDiffAdapter } from "../adapters/stateDiff";
import { KNOWN_RECORDING_IDS } from "../benchmark/corpus";
import { loadRecordingCorpus } from "./load";

const REQUIRED_TESTS: ReadonlyArray<{ test: string; file: string; recordings: readonly string[] | "all-valid" }> = [
  { file: "tests/parity.test.ts", test: "helper.feed on farm9373", recordings: ["farm9373"] },
  { file: "tests/parity.test.ts", test: "1v1 decode and coach parity", recordings: ["edge9896", "farm9373", "deck7708"] },
  { file: "tests/correctness.test.ts", test: "visible VP reconciliation", recordings: ["edge9896", "farm9373", "deck7708"] },
  { file: "tests/correctness.test.ts", test: "longest-road mechanic lengths", recordings: ["edge9896", "farm9373", "deck7708"] },
  { file: "tests/correctness.test.ts", test: "farm9373 dice and log checks", recordings: ["farm9373"] },
  { file: "tests/spatial-sim.test.ts", test: "observed-state reconstruction expects 53 valid games", recordings: "all-valid" },
  { file: "tests/spatial-sim.test.ts", test: "dice partition expects 51 standard 1v1 and 2 rush games", recordings: "all-valid" },
  { file: "tests/benchmark.test.ts", test: "recording-backed rollout positions", recordings: "all-valid" }
];

function main(): void {
  const root = process.cwd();
  const corpus = loadRecordingCorpus(root);
  const playerCounts: Record<string, number> = {};
  const rules: Record<string, number> = {};
  const eventTypes: Record<string, number> = {};
  const phases = new Set<string>();
  const decodedIds: string[] = [];
  const rejected: Array<{ id: string; where: string; message: string }> = [];
  for (const reason of corpus.rejected) rejected.push({ id: "", where: "bundle", message: reason });

  for (const recording of corpus.recordings) {
    try {
      const { decoded, stats } = decodeFrames(recording.frames);
      if (stats.unknownFrames > 0) {
        rejected.push({
          id: recording.id,
          where: "decode",
          message: `${stats.unknownFrames} undecodable frames`
        });
      }
      const parsed = stateDiffAdapter.parse(decoded);
      if (!parsed.board) {
        rejected.push({ id: recording.id, where: "state-diff", message: "no board" });
        continue;
      }
      decodedIds.push(recording.id);
      const players = String(parsed.players.length);
      playerCounts[players] = (playerCounts[players] ?? 0) + 1;
      const settings = parsed.snapshot?.gameSettings;
      const ruleKey = settings
        ? `players=${settings.maxPlayers ?? "unknown"};mode=${settings.modeSetting ?? "unknown"};dice=${settings.diceSetting ?? "unknown"};vp=${settings.victoryPointsToWin ?? "unknown"}`
        : "settings=missing";
      rules[ruleKey] = (rules[ruleKey] ?? 0) + 1;
      for (const event of parsed.events) {
        eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
      }
      if (parsed.warnings.some((warning) => /mid-game/i.test(warning))) phases.add("starts-mid-game");
      const actionState = parsed.snapshot?.actionState;
      const turnState = parsed.snapshot?.turnState;
      if (turnState !== undefined || actionState !== undefined) {
        phases.add(`terminal turnState=${turnState ?? "unknown"} actionState=${actionState ?? "unknown"}`);
      }
    } catch (error) {
      rejected.push({
        id: recording.id,
        where: "state-diff",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const present = new Set(corpus.recordings.map((recording) => recording.id));
  const coverage = REQUIRED_TESTS.map((entry) => {
    if (entry.recordings === "all-valid") {
      return { ...entry, covered: decodedIds.length > 0, missing: [] as string[] };
    }
    const missing = entry.recordings.filter((id) => !present.has(id));
    return { ...entry, covered: missing.length === 0, missing };
  });

  const report = {
    path: corpus.path,
    discovered: corpus.recordings.length + corpus.rejected.length,
    accepted: corpus.recordings.length,
    uniqueIds: corpus.recordings.length,
    decodedWithBoard: decodedIds.length,
    structuralRejections: corpus.rejected.length,
    decodeOrStateRejections: rejected.length,
    rejections: rejected,
    playerCounts,
    rules,
    eventTypes,
    phases: [...phases].sort(),
    knownIds: Object.fromEntries(KNOWN_RECORDING_IDS.map((id) => [id, present.has(id)])),
    tests: coverage
  };
  const out = resolve(root, "data/external/recording-coverage.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  const summary = {
    path: report.path,
    discovered: report.discovered,
    accepted: report.accepted,
    decodedWithBoard: report.decodedWithBoard,
    structuralRejections: report.structuralRejections,
    decodeOrStateRejections: report.decodeOrStateRejections,
    playerCounts: report.playerCounts,
    rules: report.rules,
    phases: report.phases,
    eventTypes: report.eventTypes,
    knownIds: report.knownIds,
    uncoveredTests: coverage.filter((entry) => !entry.covered).map((entry) => entry.test)
  };
  console.log(JSON.stringify(summary, null, 2));
  if (corpus.recordings.length === 0 || rejected.some((item) => item.where !== "decode")) {
    process.exitCode = 1;
  }
}

main();
