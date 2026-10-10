import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function buildTarget(outDir, isChrome = false) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "popup"), { recursive: true });

  const entries = [
    { in: "src/extension/background.ts", out: "background.js" },
    { in: "src/extension/content.ts", out: "content.js" },
    { in: "src/extension/inject.ts", out: "inject.js" },
    { in: "src/extension/popup/popup.ts", out: "popup/popup.js" }
  ];

  for (const entry of entries) {
    await build({
      entryPoints: [path.join(rootDir, entry.in)],
      outfile: path.join(outDir, entry.out),
      bundle: true,
      format: "iife",
      target: "es2022",
      minify: false,
      legalComments: "none"
    });
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
  if (isChrome) {
    manifest.background = { service_worker: "background.js" };
    delete manifest.browser_specific_settings;
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  copyRecursive(path.join(rootDir, "icons"), path.join(outDir, "icons"));
  copyRecursive(path.join(rootDir, "dashboard"), path.join(outDir, "dashboard"));
  copyRecursive(path.join(rootDir, "popup", "popup.html"), path.join(outDir, "popup", "popup.html"));
  copyRecursive(path.join(rootDir, "popup", "popup.css"), path.join(outDir, "popup", "popup.css"));
}

async function main() {
  const firefoxOut = path.join(rootDir, "dist", "firefox");
  const chromeOut = path.join(rootDir, "dist", "extension");
  await buildTarget(firefoxOut, false);
  await buildTarget(chromeOut, true);
  console.log("Built extension to dist/firefox and dist/extension (baseline root files preserved).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
