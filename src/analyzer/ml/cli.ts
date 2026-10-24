/**
 * Offline engine for the learner. Not imported by the Firefox extension.
 *
 *   node scripts/ml-engine.mjs export --out data/ml/generated/heuristic.jsonl
 *   node scripts/ml-engine.mjs bridge
 *
 * The bridge speaks one JSON object per line on stdin/stdout.
 */

import { mkdirSync, writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { POLICY_POOL, exportHeuristicGame, ExternalLearnerSession, type SessionStart } from "./games";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function exportGames(): void {
  const seeds = arg("--seeds", "ml-synth-0,ml-synth-1").split(",").filter(Boolean);
  const pairs = arg(
    "--pairs",
    "baseline_heuristic_v1:baseline_distance_only_v1,baseline_heuristic_v1:aggressive_dev_heuristic_v1,baseline_heuristic_v1:longest_road_heuristic_v1,baseline_heuristic_v1:settlement_racer_v1,baseline_heuristic_v1:random_legal_diagnostic_v1"
  )
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split(":") as [string, string]);
  const limits = {
    victoryPointsToWin: Number(arg("--vp", "3")),
    maxTurns: Number(arg("--max-turns", "20")),
    maxActions: Number(arg("--max-actions", "120"))
  };
  const outPath = arg("--out", "data/ml/generated/heuristic_demonstrations.jsonl");
  const lines: string[] = [];
  let completed = 0;
  let incomplete = 0;
  for (const seed of seeds) {
    for (const pair of pairs) {
      const examples = exportHeuristicGame({ seed, ...limits }, pair);
      if (examples[0]?.completion_status === "completed") completed += 1;
      else incomplete += 1;
      for (const example of examples) lines.push(JSON.stringify(example));
    }
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  process.stderr.write(
    `Wrote ${lines.length} heuristic demonstrations from ${completed + incomplete} games (${completed} completed, ${incomplete} incomplete) to ${outPath}\n`
  );
  process.stderr.write(`Policies: ${Object.keys(POLICY_POOL).join(", ")}\n`);
}

async function bridge(): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let session: ExternalLearnerSession | null = null;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let reply;
    try {
      const command = JSON.parse(trimmed) as { cmd?: string; action_id?: string } & Partial<SessionStart>;
      if (command.cmd === "close") break;
      if (command.cmd === "start") {
        const started = ExternalLearnerSession.start({
          seed: String(command.seed ?? "ml-synth-0"),
          learner: command.learner === "c2" || command.learner === "both" ? command.learner : "c1",
          opponent: String(command.opponent ?? "baseline_heuristic_v1"),
          victoryPointsToWin: Number(command.victoryPointsToWin ?? 3),
          maxTurns: Number(command.maxTurns ?? 20),
          maxActions: Number(command.maxActions ?? 120),
          checkpoint: command.checkpoint ?? null,
          detail: command.detail === "summary" ? "summary" : "full",
          teacher: typeof command.teacher === "string" ? command.teacher : null
        });
        session = started.reply.type === "error" ? null : started.session;
        reply = started.reply;
      } else if (command.cmd === "act") {
        reply = session ? session.act(String(command.action_id ?? "")) : { type: "error", message: "No game is open." };
      } else {
        reply = { type: "error", message: "Expected cmd start, act, or close." };
      }
    } catch (error) {
      reply = { type: "error", message: error instanceof Error ? error.message : String(error) };
    }
    writeSync(1, JSON.stringify(reply) + "\n");
  }
  rl.close();
  process.exit(0);
}

const CORPUS_POLICIES = [
  "baseline_heuristic_v1",
  "baseline_distance_only_v1",
  "aggressive_dev_heuristic_v1",
  "longest_road_heuristic_v1",
  "settlement_racer_v1",
  "random_legal_diagnostic_v1"
];

/** Benchmark profile only. Stops at the completed-game target or the seed cap, whichever comes first. */
function exportCorpus(): void {
  const split = arg("--split", "train");
  const target = Number(arg("--completed", "100"));
  const maxSeeds = Number(arg("--max-seeds", "400"));
  const outPath = arg("--out", `data/ml/generated/phase6_${split}.jsonl`);
  const limits = {
    victoryPointsToWin: Number(arg("--vp", "10")),
    maxTurns: Number(arg("--max-turns", "70")),
    maxActions: Number(arg("--max-actions", "450"))
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, "", "utf8");
  let completed = 0;
  let incomplete = 0;
  let decisions = 0;
  const started = Date.now();
  for (let index = 0; index < maxSeeds && completed < target; index++) {
    const seed = `ml-phase6-${split}-${index}`;
    const visitor = CORPUS_POLICIES[index % CORPUS_POLICIES.length];
    const pair: [string, string] = index % 2 === 0 ? ["baseline_heuristic_v1", visitor] : [visitor, "baseline_heuristic_v1"];
    const examples = exportHeuristicGame({ seed, ...limits }, pair, "baseline_heuristic_v1");
    if (examples[0]?.completion_status === "completed") completed += 1;
    else incomplete += 1;
    decisions += examples.length;
    writeFileSync(outPath, examples.map((example) => JSON.stringify(example)).join("\n") + (examples.length ? "\n" : ""), { flag: "a" });
    process.stderr.write(
      `${split} seed ${index} ${pair.join(" vs ")} ${examples[0]?.completion_status ?? "empty"} ` +
        `completed ${completed}/${target} games ${completed + incomplete} decisions ${decisions} ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s\n`
    );
  }
  process.stderr.write(
    `Corpus ${split}: ${completed} completed, ${incomplete} incomplete, ${decisions} decisions, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s, ${outPath}\n`
  );
}

const command = process.argv[2];
if (command === "export") exportGames();
else if (command === "corpus") exportCorpus();
else if (command === "bridge") await bridge();
else {
  process.stderr.write("Usage: ml-engine.mjs export | corpus | bridge\n");
  process.exitCode = 1;
}
