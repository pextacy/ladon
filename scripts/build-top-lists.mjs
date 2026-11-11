// Builds packages/core/src/data/top-{npm,pypi}.json (top 5,000 by downloads).
// Sources: npm-high-impact (wooorm, MIT) top-download list; hugovk/top-pypi-packages (30-day downloads).
// Usage: node scripts/build-top-lists.mjs <path-to-npm-high-impact/lib/top-download.js> <top-pypi-packages.min.json>
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [npmPath, pypiPath] = process.argv.slice(2);
if (!npmPath || !pypiPath) throw new Error("usage: build-top-lists.mjs <top-download.js> <top-pypi.json>");
const { topDownload: npmTopDownloads } = await import(pathToFileURL(npmPath).href);
const pypi = JSON.parse(readFileSync(pypiPath, "utf8"));
const N = 5000;
const out = (eco, source, names) =>
  writeFileSync(
    new URL(`../packages/core/src/data/top-${eco}.json`, import.meta.url),
    JSON.stringify({ source, generated: new Date().toISOString().slice(0, 10), names: names.slice(0, N) }) + "\n",
  );
out("npm", "npm-high-impact@1.13.0 (top-download)", npmTopDownloads);
out("pypi", `hugovk/top-pypi-packages ${pypi.last_update}`, pypi.rows.map((r) => r.project));
console.log("npm", Math.min(N, npmTopDownloads.length), "pypi", Math.min(N, pypi.rows.length));
