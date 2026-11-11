// End-to-end test of the passkey approval path: CLI daemon ⇄ web app ⇄ software passkey.
// Needs: the web app on $WEB (pnpm --filter web start), Verdaccio with canaries, built CLI.
//   WEB=http://localhost:3456 node scripts/e2e-passkey.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSoftAuthenticator } from "./soft-authenticator.mjs";

const WEB = process.env.WEB ?? "http://localhost:3456";
const CLI = new URL("../packages/cli/dist/index.js", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "ladon-e2e-"));
const env = { ...process.env, LADON_HOME: home, LADON_WEB_URL: WEB, LADON_DAEMON_PORT: process.env.LADON_DAEMON_PORT ?? "7511", LADON_NO_NOTIFY: "1", LADON_AI: "off" };
const proj = mkdtempSync(join(tmpdir(), "ladon-e2e-proj-"));
writeFileSync(join(proj, ".npmrc"), "registry=http://localhost:4873/\n");
let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failed++;
};
const post = async (p, body) => {
  const r = await fetch(WEB + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(args, stdin) {
  const c = spawn(process.execPath, [CLI, ...args], { env, cwd: proj });
  const p = { out: "", done: null };
  c.stdout.on("data", (d) => (p.out += d));
  c.stderr.on("data", (d) => (p.out += d));
  if (stdin !== undefined) {
    c.stdin.write(stdin);
    c.stdin.end();
  }
  p.done = new Promise((resolve) => c.on("close", (code) => resolve(code)));
  return p;
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  return null;
}

const auth = createSoftAuthenticator({ origin: new URL(WEB).origin, rpId: new URL(WEB).hostname });

// 1. pairing: `ladon passkey pair` registers the device and waits; we act as the phone.
const pair = start(["passkey", "pair"]);
const code = await until(() => /code=([A-Z0-9]{8})/.exec(pair.out)?.[1]);
ok(!!code, `device registered, pair code ${code}`);
const regOpts = await post("/api/passkeys/register/options", { code });
ok(regOpts.status === 200, "registration options issued");
const reg = await post("/api/passkeys/register/verify", { code, response: auth.register(regOpts.body), label: "e2e soft passkey" });
ok(reg.status === 200 && reg.body.ok, `passkey registered (${reg.status} ${JSON.stringify(reg.body).slice(0, 80)})`);
// Run without a terminal (like an agent): the CLI must refuse to pin the new passkey.
ok((await pair.done) !== 0 && /not confirmed on the terminal/.test(pair.out), "without a human at /dev/tty the CLI refuses to pin the passkey");
ok(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).passkeys.length === 0, "nothing was pinned");
// The human confirms (this harness plays the human): pin exactly what the server lists.
{
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const me = await (await fetch(`${WEB}/api/devices/me`, { headers: { authorization: `Bearer ${cfg.device.token}` } })).json();
  cfg.passkeys = me.passkeys.map(({ credentialId, publicKey, counter }) => ({ credentialId, publicKey, counter }));
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
  ok(cfg.passkeys.length === 1, "human pinned the passkey");
}

const hookInput = (cmd) => JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd }, cwd: proj });
const approvalUrl = async () => until(() => {
  try {
    const m = [...readFileSync(join(home, "daemon.log"), "utf8").matchAll(/approve on your phone: (\S+\/approve\/([\w-]+))/g)].pop();
    return m && !seen.has(m[2]) ? m[2] : null;
  } catch {
    return null;
  }
});
const seen = new Set();

async function decideVia(decision, tamper) {
  const id = await approvalUrl();
  ok(!!id, `hold created approval ${id}`);
  seen.add(id);
  const pub = await (await fetch(`${WEB}/api/approvals/${id}`)).json();
  ok(pub.status === "pending" && !("nonce" in pub), "public approval view is pending and hides the nonce");
  const opts = await post(`/api/approvals/${id}/options`, { decision: tamper ? "approve" : decision });
  ok(opts.status === 200, `assertion options for ${decision}`);
  // tamper: sign an "approve" challenge but submit it as "reject" → server must refuse
  const res = await post(`/api/approvals/${id}/decide`, { decision, response: auth.assert(opts.body) });
  return { id, res };
}

// 2. HOLD → human rejects with passkey → agent is denied.
rmMarker();
let hook = start(["hook", "claude-pre-tool-use"], hookInput("npm i color-fn-utils"));
let d = await decideVia("reject");
ok(d.res.status === 200 && d.res.body.status === "rejected", "server accepted the passkey rejection");
await hook.done;
let out = JSON.parse(hook.out);
ok(out.hookSpecificOutput?.permissionDecision === "deny" && /rejected with passkey/.test(out.hookSpecificOutput.permissionDecisionReason), "hook denied: rejected with passkey (verified locally)");

// 3. A challenge signed for "approve" can't be submitted as "reject" (decision is bound into the challenge).
hook = start(["hook", "claude-pre-tool-use"], hookInput("npm i ladon-canary-worm"));
d = await decideVia("reject", true);
ok(d.res.status >= 400, `server refused a decision that doesn't match the signed challenge (${d.res.status})`);
// now approve properly
const opts = await post(`/api/approvals/${d.id}/options`, { decision: "approve" });
const appr = await post(`/api/approvals/${d.id}/decide`, { decision: "approve", response: auth.assert(opts.body) });
ok(appr.status === 200 && appr.body.status === "approved", "passkey approval accepted");
await hook.done;
out = hook.out.trim() ? JSON.parse(hook.out) : {};
ok(!out.hookSpecificOutput && /approved by a human/.test(out.systemMessage ?? ""), "hook allowed after a verified passkey approval");

// 4. Replay: the old assertion for a decided request can't decide again.
const replay = await post(`/api/approvals/${d.id}/decide`, { decision: "approve", response: auth.assert(opts.body) });
ok(replay.status >= 400, `re-deciding a closed request is refused (${replay.status})`);

// 5. Signed allowlist: `ladon allow` needs a passkey approval; the stored proof is re-verified on load,
//    and an entry an agent writes into state.json by hand is ignored.
{
  const allow = start(["allow", "ladon-canary-worm@1.0.0"]);
  const id = await until(() => [...allow.out.matchAll(/approve on your phone: \S+\/approve\/([\w-]+)/g)].pop()?.[1]);
  ok(!!id, `ladon allow created approval ${id}`);
  const o = await post(`/api/approvals/${id}/options`, { decision: "approve" });
  const a = await post(`/api/approvals/${id}/decide`, { decision: "approve", response: auth.assert(o.body) });
  ok(a.status === 200 && a.body.status === "approved", "allowlist approval accepted by the server");
  ok((await allow.done) === 0, "ladon allow finished after a verified passkey approval");
  const st = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  ok(st.allowlist.length === 1 && st.allowlist[0].proof, "entry stored with its approval proof");
  // forge: an agent appends an unsigned entry and a copy of the real proof bound to another package
  st.allowlist.push({ target: "npm:color-fn-utils", approvedAt: new Date().toISOString(), via: "passkey" });
  st.allowlist.push({ ...st.allowlist[0], target: "npm:ladon-canary-curl" });
  writeFileSync(join(home, "state.json"), JSON.stringify(st));
  const list = start(["allow", "--list"]);
  await list.done;
  ok(/✓ npm:ladon-canary-worm@1\.0\.0/.test(list.out), "the signed entry verifies");
  ok((list.out.match(/IGNORED/g) ?? []).length === 2, "the forged entries are ignored");
  rmMarker();
  const h = start(["hook", "claude-pre-tool-use"], hookInput("npm i color-fn-utils"));
  const hid = await approvalUrl();
  ok(!!hid, "forged allowlist entry did not let color-fn-utils through (still held)");
  if (hid) {
    seen.add(hid);
    const ro = await post(`/api/approvals/${hid}/options`, { decision: "reject" });
    await post(`/api/approvals/${hid}/decide`, { decision: "reject", response: auth.assert(ro.body) });
  }
  await h.done;
}

ok(!existsSync("/tmp/ladon-canary-pwned"), "no canary payload ever ran");
await fetch(`http://127.0.0.1:${env.LADON_DAEMON_PORT}/shutdown`, { method: "POST", headers: { "x-ladon-token": readFileSync(join(home, "daemon.token"), "utf8") } }).catch(() => {});
console.log(failed ? `\n${failed} check(s) failed` : "\nall passkey e2e checks passed");
process.exit(failed ? 1 : 0);

function rmMarker() {
  rmSync("/tmp/ladon-canary-pwned", { force: true });
}
