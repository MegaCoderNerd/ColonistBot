/**
 * Stage 3.5 — `npm run benchmark:policy` entry point.
 *
 * Bundles the TypeScript benchmark CLI with esbuild (the same bundler already used by
 * `npm run build:ext`) into a temporary ESM file, then executes it with Node. This keeps the
 * project free of an extra TS runtime dependency.
 *
 * Runs fully offline: it never loads the browser extension and never contacts a live game.
 */

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "dist", "benchmark");
const outFile = path.join(outDir, "benchmark-policy.mjs");

fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "src", "analyzer", "benchmark", "cli.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  legalComments: "none",
  logLevel: "warning"
});

await import(pathToFileURL(outFile).href);

