/**
 * Bundles the offline learner engine and runs it. The Firefox extension does not import it.
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "dist", "ml");
const outFile = path.join(outDir, "engine.mjs");

fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "src", "analyzer", "ml", "cli.ts")],
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
