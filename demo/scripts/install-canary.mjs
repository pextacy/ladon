// Phase 0 exit check: a canary installs from the local registry and its payload fires.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoRegistry } from "./registry-guard.mjs";

const registry = demoRegistry();
const marker = process.platform === "win32" ? join(tmpdir(), "ladon-canary-pwned") : "/tmp/ladon-canary-pwned";
const pkg = process.argv[2] ?? "color-fn-utils";

rmSync(marker, { force: true });
const dir = mkdtempSync(join(tmpdir(), "ladon-demo-"));
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ladon-demo-victim", private: true }));
execFileSync("npm", ["install", pkg, "--registry", registry, "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });

if (!existsSync(marker)) {
  console.error(`FAIL: ${pkg} installed but canary marker ${marker} was not written`);
  process.exit(1);
}
console.log(`\ncanary fired (this is what Ladon will block):\n${readFileSync(marker, "utf8")}`);
rmSync(dir, { recursive: true, force: true });
