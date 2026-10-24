import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "dist", "recordings");
const outFile = path.join(outDir, "validate.mjs");
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "src", "analyzer", "recordings", "validate.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  legalComments: "none",
  logLevel: "warning"
});

await import(pathToFileURL(outFile).href + `?t=${Date.now()}`);
