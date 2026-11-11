import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  checkPackage,
  commandHash,
  createDeps,
  explainDeterministic,
  formatReport,
  keyFingerprint,
  LADON_VERSION,
  newNonce,
  newRequestId,
  parseNpmSpec,
  parsePipSpec,
  type InstallTarget,
} from "@ladon/core";
import { keyHello } from "./approve/key.js";
import { requestApproval } from "./approve/index.js";
import { serverPasskeys } from "./approve/passkey.js";
import { newPairCode } from "./web.js";
import { listKeyPorts, openSerial } from "./approve/serial.js";
import { ensureDaemon } from "./client.js";
import { DAEMON_PORT, loadConfig, loadState, PATHS, saveState } from "./config.js";
import { runDaemon } from "./daemon.js";
import { loadLockfiles } from "./gate.js";
import { claudePreToolUse, claudeSessionStart, cursorBeforeShell } from "./hook.js";
import { init, pairKey, registerDevice, waitForPasskey } from "./init.js";
import { defaultApprovers, loadLadonEnv } from "./runtime.js";
import { scanAll } from "./scan.js";
import { installShims, PATH_LINE, shimExec, shimsActive, uninstallShims } from "./shim.js";
import { checkWatched } from "./watch.js";

const HELP = `ladon ${LADON_VERSION} — a firewall between AI coding agents and package registries

  ladon init [--project] [--cursor] [--shell] [--passkey] [--offline] [--atlas-reports]
                             install Claude Code hooks + shims, pair Key / passkey
  ladon check <pkg>[@v] [--pypi] [-v] [--json] [--registry URL]
                             verdict for one package
  ladon scan                 scan instruction files (AGENTS.md, CLAUDE.md, …) here → repo → home
  ladon watch                show new hooks / MCP servers in AI-tool configs since the baseline
  ladon status               what is installed, paired and running
  ladon log [-n 20]          recent decisions
  ladon key pair|status      pair the Ladon Key over USB
  ladon passkey pair|list    pair a phone/laptop passkey via the web app
  ladon allow <pkg>          permanently allow a package — requires Key or passkey approval
  ladon shim install|uninstall|status
  ladon daemon               run the local service (127.0.0.1:${DAEMON_PORT}); started automatically

There is intentionally no command or flag that approves an install. Only the Ladon Key or a passkey can.
`;

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}
function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

export function parseTarget(spec: string, pypi: boolean): InstallTarget | null {
  let s = spec;
  let eco: "npm" | "pypi" = pypi ? "pypi" : "npm";
  const m = /^(npm|pypi):(.+)$/.exec(spec);
  if (m) {
    eco = m[1] as "npm" | "pypi";
    s = m[2]!;
  }
  if (eco === "npm") return parseNpmSpec(s).target ?? null;
  const r = parsePipSpec(s.replace(/@(?=[\w.]+$)/, "=="));
  return r.target ?? null;
}

async function cmdCheck(args: string[]): Promise<number> {
  const pypi = flag(args, "--pypi");
  const verbose = flag(args, "-v") || flag(args, "--verbose");
  const json = flag(args, "--json");
  const registry = opt(args, "--registry");
  const spec = args[0];
  if (!spec) {
    err("usage: ladon check <pkg>[@version] [--pypi]");
    return 2;
  }
  const target = parseTarget(spec, pypi);
  if (!target) {
    err(`ladon: "${spec}" is not a registry package name`);
    return 2;
  }
  const cfg = loadConfig();
  const deps = createDeps({ cacheDir: PATHS.cache, atlasUrl: cfg.webUrl, ...(registry ? (target.ecosystem === "npm" ? { npmRegistry: registry } : { pypiIndex: registry }) : {}) });
  const r = await checkPackage(target, deps, { lockfile: loadLockfiles(process.cwd()), failMode: cfg.failMode });
  if (json) {
    out(JSON.stringify(r, null, 2));
  } else {
    out(formatReport(r, { color: !!process.stdout.isTTY, verbose }));
    if (verbose) {
      out(`\n${explainDeterministic(r)}`);
      for (const e of r.evidence.errors) out(`  source problem: ${e.source}: ${e.message}`);
      out(`  (${r.durationMs} ms)`);
    }
  }
  return r.verdict === "allow" ? 0 : r.verdict === "warn" ? 1 : 2;
}

function cmdScan(): number {
  const scans = scanAll(process.cwd());
  if (scans.length === 0) {
    out("✓ no agent instruction files found here, in the repo, or in your home directory");
    return 0;
  }
  let worst = 0;
  for (const s of scans) {
    const shape = s.risk === "high" ? "■" : s.risk === "medium" ? "▲" : "✓";
    out(`${shape} ${s.risk.toUpperCase().padEnd(6)} ${s.path.replace(homedir(), "~")}`);
    for (const f of s.findings) out(`    ${f.line ? `line ${f.line}: ` : ""}${f.detail}${f.excerpt ? `\n      ${f.excerpt}` : ""}`);
    worst = Math.max(worst, s.risk === "high" ? 2 : s.risk === "medium" ? 1 : 0);
  }
  return worst;
}

function cmdWatch(): number {
  const alerts = checkWatched({ cwd: process.cwd(), update: true });
  if (alerts.length === 0) {
    out("✓ no new hooks, MCP servers or auto-run tasks in AI-tool configs since the last check");
    return 0;
  }
  for (const a of alerts) out(`▲ ${a.detail}`);
  return 1;
}

async function cmdStatus(): Promise<number> {
  const cfg = loadConfig();
  const st = loadState();
  let settings = "";
  try {
    settings = readFileSync(`${homedir()}/.claude/settings.json`, "utf8");
  } catch {
    /* none */
  }
  let daemon = "not running";
  try {
    const r = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, { signal: AbortSignal.timeout(500) });
    const h = (await r.json()) as { pid: number; ai: boolean };
    daemon = `running (pid ${h.pid}, AI intent ${h.ai ? "on" : "off"})`;
  } catch {
    /* down */
  }
  out(`ladon ${LADON_VERSION}`);
  out(`  Claude Code hook   ${settings.includes("hook claude-pre-tool-use") ? "✓ installed (user settings)" : "✗ not in ~/.claude/settings.json (ladon init)"}`);
  out(`  shims              ${shimsActive() ? "✓ first on PATH" : `✗ not on PATH — ${PATH_LINE}`}`);
  out(`  daemon             ${daemon}`);
  out(`  Ladon Key          ${cfg.key ? `✓ ${keyFingerprint(cfg.key.publicKey)} (counter ${st.keyCounter})` : "✗ not paired"}`);
  out(`  passkeys           ${cfg.passkeys.length ? `✓ ${cfg.passkeys.length} pinned` : "✗ none"}`);
  out(`  web                ${cfg.webUrl}${cfg.device ? ` (device ${cfg.device.label})` : " (not registered)"}`);
  out(`  fail mode          ${cfg.failMode}; warn → ${cfg.onWarn}; atlas reports ${cfg.atlasReports ? "on" : "off"}`);
  out(`  allowlist          ${st.allowlist.length} package(s)`);
  return 0;
}

function cmdLog(args: string[]): number {
  const n = Number(opt(args, "-n") ?? 20);
  let lines: string[] = [];
  try {
    lines = readFileSync(PATHS.log, "utf8").trim().split("\n").slice(-n);
  } catch {
    out("no decisions yet");
    return 0;
  }
  const shape: Record<string, string> = { allow: "✓", warn: "▲", hold: "■" };
  for (const l of lines) {
    try {
      const d = JSON.parse(l) as { ts: string; verdict: string; ecosystem: string; package: string; version?: string; score: number; outcome: string; agent?: string; reasons: string[] };
      out(`${d.ts.slice(0, 19).replace("T", " ")}  ${shape[d.verdict] ?? "?"} ${d.outcome.padEnd(8)} ${d.ecosystem}:${d.package}${d.version ? "@" + d.version : ""}  ${d.score}  ${d.agent ?? ""}${d.reasons[0] ? `\n                     ${d.reasons[0]}` : ""}`);
    } catch {
      /* skip */
    }
  }
  return 0;
}

async function cmdKey(args: string[]): Promise<number> {
  const sub = args[0] ?? "status";
  if (sub === "pair") return (await pairKey(out)) ? 0 : 1;
  if (sub === "status") {
    const cfg = loadConfig();
    const ports = await listKeyPorts();
    out(cfg.key ? `paired: ${keyFingerprint(cfg.key.publicKey)} (${cfg.key.path ?? "auto"})` : "no Key paired");
    out(ports.length ? `connected: ${ports.map((p) => p.path).join(", ")}` : "no Key connected");
    if (ports[0] && cfg.key) {
      const link = await openSerial(ports[0].path);
      try {
        const h = await keyHello(link);
        out(h.pk === cfg.key.publicKey ? `✓ connected Key matches (counter ${h.ctr})` : "■ connected Key is NOT the paired one");
      } finally {
        await link.close();
      }
    }
    return 0;
  }
  err("usage: ladon key pair|status");
  return 2;
}

async function cmdPasskey(args: string[]): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub === "pair") {
    const since = Date.now() - 5000;
    const pairUrl = (await registerDevice(out)) ?? (await newPairCode(loadConfig())).pairUrl;
    out(`Open on your phone or laptop and create a passkey:\n  ${pairUrl}\nwaiting up to 5 minutes…`);
    return (await waitForPasskey(out, 5 * 60_000, since)) ? 0 : 1;
  }
  if (sub === "list") {
    const pinned = loadConfig().passkeys;
    for (const p of pinned) out(`  ✓ pinned  ${p.label ?? "passkey"}  ${p.credentialId.slice(0, 12)}…  counter ${p.counter}`);
    const server = await serverPasskeys().catch(() => []);
    for (const p of server.filter((x) => !pinned.some((y) => y.credentialId === x.credentialId))) out(`  ✗ NOT pinned (approvals from it are ignored)  ${p.label ?? "passkey"}  ${p.credentialId.slice(0, 12)}…`);
    if (pinned.length === 0 && server.length === 0) out("no passkeys — ladon passkey pair");
    return 0;
  }
  err("usage: ladon passkey pair|list");
  return 2;
}

async function cmdAllow(args: string[]): Promise<number> {
  const target = args[0] ? parseTarget(args[0], flag(args, "--pypi")) : null;
  if (!target) {
    err("usage: ladon allow <pkg> [--pypi]");
    return 2;
  }
  loadLadonEnv();
  const key = `${target.ecosystem}:${target.name}`;
  out(`Adding ${key} to the allowlist needs a human: approve on your Ladon Key or passkey.`);
  const req = {
    id: newRequestId(),
    h: commandHash(`ladon allow ${key}`, process.cwd()),
    n: newNonce(),
    exp: Math.floor(Date.now() / 1000) + 120,
    pkg: `allowlist ${key}`,
    ecosystem: target.ecosystem,
    name: target.name,
    score: 0,
    why: ["add to the permanent allowlist", "future installs skip checks"],
  };
  const o = await requestApproval(defaultApprovers(), req, out);
  if (o.kind !== "approved") {
    err(`■ not allowlisted: ${o.detail}`);
    return 1;
  }
  const st = loadState();
  st.allowlist = st.allowlist.filter((a) => a.target !== key);
  st.allowlist.push({ target: key, approvedAt: new Date().toISOString(), via: o.via });
  saveState(st);
  out(`✓ ${key} allowlisted (${o.detail})`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return 0;
    case "-v":
    case "--version":
      out(LADON_VERSION);
      return 0;
    case "init":
      await init({ project: flag(args, "--project"), cursor: flag(args, "--cursor"), shell: flag(args, "--shell"), offline: flag(args, "--offline"), passkey: flag(args, "--passkey"), atlasReports: flag(args, "--atlas-reports") });
      return 0;
    case "check":
      return cmdCheck(args);
    case "scan":
      return cmdScan();
    case "watch":
      return cmdWatch();
    case "status":
      return cmdStatus();
    case "log":
      return cmdLog(args);
    case "key":
      return cmdKey(args);
    case "passkey":
      return cmdPasskey(args);
    case "allow":
      return cmdAllow(args);
    case "daemon":
      await runDaemon();
      return new Promise<number>(() => {}); // run until signalled
    case "hook": {
      const kind = args[0];
      if (kind === "claude-pre-tool-use") return claudePreToolUse();
      if (kind === "claude-session-start") return claudeSessionStart();
      if (kind === "cursor") return cursorBeforeShell();
      err("usage: ladon hook claude-pre-tool-use|claude-session-start|cursor");
      return 2;
    }
    case "shim": {
      const sub = args[0] ?? "status";
      if (sub === "install") {
        installShims();
        out(`✓ shims in ${PATHS.shims}\n${shimsActive() ? "✓ active" : `add to your shell rc:\n  ${PATH_LINE}`}`);
        return 0;
      }
      if (sub === "uninstall") {
        out(`removed ${uninstallShims()} shims`);
        return 0;
      }
      out(shimsActive() ? "✓ shims are first on PATH" : `✗ shims not on PATH\n  ${PATH_LINE}`);
      return 0;
    }
    case "shim-exec": {
      const [tool, ...rest] = args;
      if (!tool) return 2;
      return shimExec(tool, rest);
    }
    case "daemon-start":
      return (await ensureDaemon()) ? 0 : 1;
    case "config": {
      // read-only view; security settings are edited by hand in ~/.ladon/config.json on purpose
      const c = loadConfig();
      out(JSON.stringify({ ...c, device: c.device ? { ...c.device, token: "…" } : undefined }, null, 2));
      return 0;
    }
    default:
      err(`ladon: unknown command '${cmd}'\n`);
      process.stderr.write(HELP);
      return 2;
  }
}
