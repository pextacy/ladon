// Publishes every package in demo/canaries to the LOCAL Verdaccio registry.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalOnlyPackage, demoRegistry } from "./registry-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = join(here, "..");
const registry = demoRegistry();
const npmrc = join(demoDir, ".npmrc.local");

async function token() {
  const user = "ladon-demo";
  const password = "ladon-demo-local-only"; // local throwaway account, loopback registry only
  const basic = Buffer.from(`${user}:${password}`).toString("base64");
  // Same call as `npm login`: creates the user on first run, logs in (Basic auth) on later runs.
  const res = await fetch(new URL(`-/user/org.couchdb.user:${user}`, registry), {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Basic ${basic}` },
    body: JSON.stringify({ name: user, password }),
  }).catch((e) => {
    throw new Error(`Cannot reach ${registry} — run \`pnpm demo:registry\` first. (${e.message})`);
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(`Registry login failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body.token;
}

const auth = new URL(registry);
writeFileSync(npmrc, `registry=${registry}\n//${auth.host}${auth.pathname}:_authToken=${await token()}\n`, { mode: 0o600 });

const canariesDir = join(demoDir, "canaries");
for (const name of readdirSync(canariesDir)) {
  const dir = join(canariesDir, name);
  if (!existsSync(join(dir, "package.json"))) continue;
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assertLocalOnlyPackage(pkg, dir, { existsSync });
  try {
    execFileSync("npm", ["publish", "--ignore-scripts", "--userconfig", npmrc, "--registry", registry], { cwd: dir, stdio: "pipe" });
    console.log(`published ${pkg.name}@${pkg.version} → ${registry}`);
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    if (/EPUBLISHCONFLICT|cannot publish over|409/.test(out)) {
      console.log(`exists    ${pkg.name}@${pkg.version} (already on ${registry})`);
    } else {
      console.error(out);
      process.exit(1);
    }
  }
}
