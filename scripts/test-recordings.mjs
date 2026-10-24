import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = process.env.COLONIST_RECORDINGS_PATH ?? path.join(rootDir, "colonist-recordings-v1.json");

if (!fs.existsSync(corpusPath)) {
  console.error(`Recording corpus is missing: ${corpusPath}`);
  console.error("Set COLONIST_RECORDINGS_PATH to the colonist-recordings-v1.json bundle.");
  process.exit(1);
}

const env = {
  ...process.env,
  COLONIST_RECORDINGS_PATH: corpusPath,
  COLONIST_RECORDINGS_STRICT: "1"
};

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: rootDir, env, stdio: "inherit", shell: false });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const validateCode = await run(["scripts/validate-recordings.mjs"]);
const vitestCode = await run(["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.recordings.config.ts"]);
if (validateCode !== 0 || vitestCode !== 0) {
  process.exit(validateCode !== 0 ? validateCode : vitestCode);
}
