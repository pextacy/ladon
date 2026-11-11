#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  checkPackage,
  countedHits,
  createDeps,
  explainDeterministic,
  formatReport,
  keyFingerprint,
  LADON_VERSION,
  newNonce,
  newRequestId,
  parseNpmSpec,
  parsePipSpec,
  pkgLabel,
  type InstallTarget,
  type Report,
} from "@ladon/core";
import { audit, fetchAtlasAlerts } from "./audit.js";
import { allowlistHash, allowTarget, entryLabel, exactVersion, verifiedAllowlist } from "./allowlist.js";
import { keyHello } from "./approve/key.js";
import { requestApproval } from "./approve/index.js";
import { serverPasskeys } from "./approve/passkey.js";
import { newPairCode } from "./web.js";
import { listKeyPorts, openSerial } from "./approve/serial.js";
import { ensureDaemon } from "./client.js";
import { DAEMON_PORT, loadConfig, loadState, PATHS, saveState } from "./config.js";
import { runDaemon } from "./daemon.js";
import { loadLockfiles } from "./gate.js";
import { claudePreToolUse, claudeSessionStart, codexPreToolUse, cursorBeforeShell, cursorBeforeSubmitPrompt } from "./hook.js";
import { init, pairKey, registerDevice, waitForPasskey } from "./init.js";
import { defaultApprovers, loadLadonEnv } from "./runtime.js";
import { scanAll } from "./scan.js";
import { installedShims, installShims, PATH_LINE, PY_SHIMS, shimExec, shimsActive, uninstallShims } from "./shim.js";
import { checkWatched, listWatched } from "./watch.js";

const HELP = `ladon ${LADON_VERSION} — a firewall between AI coding agents and package registries

  ladon init [--project] [--cursor] [--codex] [--shell] [--passkey] [--offline] [--atlas-reports]
                             install Claude Code (+ Cursor / Codex) hooks + shims, pair Key / passkey
  ladon check <pkg>[@v] [--pypi] [-v] [--json] [--registry URL]
                             verdict for one package
  ladon scan                 scan instruction files (AGENTS.md, CLAUDE.md, …) here → repo → home,
                             then list agent hooks / MCP servers / auto-run tasks (read-only)
  ladon audit [--json]       check every lockfile dependency against Atlas alerts (hallucinated,
                             then registered) and OSV malicious-package advisories; exit 1 on findings
  ladon watch                show new hooks / MCP servers in AI-tool configs since the baseline
  ladon status               what is installed, paired and running
  ladon log [-n 20]          recent decisions
  ladon key pair|status      pair the Ladon Key over USB
  ladon passkey pair|list    pair a phone/laptop passkey via the web app
  ladon allow <pkg>[@1.2.3]  permanently allow a package (or one exact version) — requires Key or passkey approval
  ladon allow --remove <pkg>[@v] | --list
                             remove an entry (no approval needed — it only tightens) / show entries
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

/** One-paragraph LLM explanation (same as the web checker) when LADON_AI=on and a key is set; else null. */
async function explainWithAi(r: Report): Promise<string | null> {
  loadLadonEnv();
  const ai = await import("@ladon/core/ai").catch(() => null);
  if (!ai || !ai.aiEnabled()) return null;
  try {
    const text = await ai.anthropicProvider({ timeoutMs: 8000 }).explain({
      package: pkgLabel(r),
      verdict: r.verdict,
      score: r.score,
      reasons: countedHits(r.hits).slice(0, 5).map((h) => h.detail),
    });
    return text || null;
  } catch {
    return null;
  }
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
      const ai = await explainWithAi(r);
      out(`\n${ai ? `${ai}\n  (explanation written by AI from the evidence above; the verdict comes from the rules)` : explainDeterministic(r)}`);
      for (const e of r.evidence.errors) out(`  source problem: ${e.source}: ${e.message}`);
      out(`  (${r.durationMs} ms)`);
    }
  }
  return r.verdict === "allow" ? 0 : r.verdict === "warn" ? 1 : 2;
}

function cmdScan(): number {
  const cwd = process.cwd();
  const scans = scanAll(cwd);
  let worst = 0;
  if (scans.length === 0) out("✓ no agent instruction files found here, in the repo, or in your home directory");
  for (const s of scans) {
    const shape = s.risk === "high" ? "■" : s.risk === "medium" ? "▲" : "✓";
    out(`${shape} ${s.risk.toUpperCase().padEnd(6)} ${s.path.replace(homedir(), "~")}`);
    for (const f of s.findings) out(`    ${f.line ? `line ${f.line}: ` : ""}${f.detail}${f.excerpt ? `\n      ${f.excerpt}` : ""}`);
    worst = Math.max(worst, s.risk === "high" ? 2 : s.risk === "medium" ? 1 : 0);
  }
  // Agent configs (read-only: the watch baseline is not updated — `ladon watch` does that).
  const configs = listWatched(cwd);
  out("\nAgent configs (hooks, MCP servers, auto-run tasks):");
  if (configs.length === 0) out("  ✓ none found");
  const kind = { hook: "hook", mcp: "MCP ", task: "auto" } as const;
  for (const c of configs) {
    const fresh = c.items.filter((i) => i.isNew).length;
    out(`${fresh ? "▲" : "✓"} ${c.path.replace(homedir(), "~")}${fresh ? `  (${fresh} new since the last \`ladon watch\`)` : ""}`);
    for (const i of c.items) out(`    ${i.isNew ? "NEW " : "    "}${kind[i.kind]}  ${i.item.slice(0, 160)}`);
    if (fresh) worst = Math.max(worst, 1);
  }
  return worst;
}

async function cmdAudit(args: string[]): Promise<number> {
  const json = flag(args, "--json");
  const cfg = loadConfig();
  const deps = createDeps({ cacheDir: PATHS.cache, atlasUrl: cfg.webUrl });
  const r = await audit(process.cwd(), { alerts: () => fetchAtlasAlerts(cfg.webUrl), osv: deps.osv });
  if (json) {
    out(JSON.stringify(r, null, 2));
  } else if (r.files.length === 0) {
    out("no lockfile here or up to the repo root (package-lock.json, pnpm-lock.yaml, yarn.lock, uv.lock, poetry.lock, pdm.lock, requirements.txt)");
  } else {
    out(`audited ${r.deps} locked dependencies in ${r.files.map((f) => f.replace(process.cwd() + "/", "")).join(", ")}`);
    for (const f of r.findings) out(`■ ${f.ecosystem}:${f.name}${f.versions.length ? `@${f.versions.join(",")}` : ""}\n    ${f.detail}`);
    for (const e of r.errors) out(`▲ incomplete: ${e}`);
    if (r.findings.length === 0) out(r.errors.length ? "no findings in what could be checked" : "✓ no hallucinated-then-registered names and no known-malicious packages");
  }
  if (r.findings.length > 0) return 1;
  return r.errors.length > 0 ? 2 : 0;
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
  const allow = await verifiedAllowlist(cfg, st);
  const ignored = allow.rejected.filter((r) => r.entry.proof);
  out(`  allowlist          ${allow.entries.length} verified entr${allow.entries.length === 1 ? "y" : "ies"}${ignored.length ? ` · ■ ${ignored.length} IGNORED (signature does not verify — ladon allow --list)` : ""}`);
  // One-time migration: entries from before signed allowlists carry no proof. They are ignored by the
  // gate; tell the human once and drop them so they can re-add them with an approval.
  const legacy = allow.rejected.filter((r) => !r.entry.proof);
  if (legacy.length > 0) {
    out(`\n▲ ${legacy.length} allowlist entr${legacy.length === 1 ? "y was" : "ies were"} added before allowlists were signed and ${legacy.length === 1 ? "is" : "are"} no longer honoured:`);
    for (const r of legacy) {
      const [eco, ...rest] = r.entry.target.split(":");
      out(`    ${entryLabel(r.entry)}  →  re-add with: ladon allow ${rest.join(":")}${r.entry.version ? `@${r.entry.version}` : ""}${eco === "pypi" ? " --pypi" : ""}`);
    }
    const fresh = loadState();
    fresh.allowlist = fresh.allowlist.filter((e) => e.proof);
    saveState(fresh);
    out("  (removed from state.json; this notice is shown once)");
  }
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
  const pypi = flag(args, "--pypi");
  const list = flag(args, "--list");
  const remove = flag(args, "--remove");
  if (list) {
    const cfg = loadConfig();
    const v = await verifiedAllowlist(cfg, loadState());
    if (v.entries.length + v.rejected.length === 0) out("allowlist is empty");
    for (const e of v.entries) out(`  ✓ ${entryLabel(e).padEnd(40)} approved ${e.approvedAt.slice(0, 10)} via ${e.via === "key" ? "Ladon Key" : "passkey"}`);
    for (const r of v.rejected) out(`  ■ ${entryLabel(r.entry).padEnd(40)} IGNORED — ${r.reason}`);
    return 0;
  }
  const target = args[0] ? parseTarget(args[0], pypi) : null;
  if (!target) {
    err("usage: ladon allow <pkg>[@exact-version] [--pypi]\n       ladon allow --remove <pkg>[@version]\n       ladon allow --list");
    return 2;
  }
  const key = allowTarget(target.ecosystem, target.name);
  const version = exactVersion(target.versionSpec);
  if (target.versionSpec && !version) {
    err(`ladon: "${target.versionSpec}" is not an exact version — allow a single version like ${target.name}@1.2.3, or the name alone for every version`);
    return 2;
  }
  if (remove) {
    // Removing only tightens the gate, so it needs no approval.
    const st = loadState();
    const before = st.allowlist.length;
    st.allowlist = st.allowlist.filter((a) => !(a.target === key && (!version || a.version === version)));
    const n = before - st.allowlist.length;
    if (n === 0) {
      out(`${key}${version ? `@${version}` : ""} is not on the allowlist`);
      return 1;
    }
    saveState(st);
    out(`✓ removed ${n} allowlist entr${n === 1 ? "y" : "ies"} for ${key}${version ? `@${version}` : ""}`);
    return 0;
  }
  loadLadonEnv();
  const entry = { target: key, ...(version ? { version } : {}) };
  const label = entryLabel(entry);
  out(`Adding ${label} to the allowlist needs a human: approve on your Ladon Key or passkey.`);
  const req = {
    id: newRequestId(),
    h: allowlistHash(entry), // binds the exact entry; re-verified every time the allowlist is loaded
    n: newNonce(),
    exp: Math.floor(Date.now() / 1000) + 120,
    pkg: `allowlist ${label}`,
    ecosystem: target.ecosystem,
    name: target.name,
    ...(version ? { version } : {}),
    score: 0,
    why: [version ? `allow only version ${version}` : "allow every version", "future installs skip checks"],
  };
  const o = await requestApproval(defaultApprovers(), req, out);
  if (o.kind !== "approved") {
    err(`■ not allowlisted: ${o.detail}`);
    return 1;
  }
  if (!o.proof) {
    err("■ not allowlisted: the approval carried no verifiable proof");
    return 1;
  }
  const st = loadState();
  st.allowlist = st.allowlist.filter((a) => !(a.target === key && a.version === entry.version));
  st.allowlist.push({ ...entry, approvedAt: new Date().toISOString(), via: o.via, proof: o.proof });
  saveState(st);
  out(`✓ ${label} allowlisted (${o.detail})`);
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
      await init({ project: flag(args, "--project"), cursor: flag(args, "--cursor"), codex: flag(args, "--codex"), shell: flag(args, "--shell"), offline: flag(args, "--offline"), passkey: flag(args, "--passkey"), atlasReports: flag(args, "--atlas-reports") });
      return 0;
    case "check":
      return cmdCheck(args);
    case "scan":
      return cmdScan();
    case "watch":
      return cmdWatch();
    case "audit":
      return cmdAudit(args);
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
      if (kind === "cursor" || kind === "cursor-before-shell") return cursorBeforeShell();
      if (kind === "cursor-before-submit-prompt") return cursorBeforeSubmitPrompt();
      if (kind === "codex-pre-tool-use") return codexPreToolUse();
      err("usage: ladon hook claude-pre-tool-use|claude-session-start|cursor-before-shell|cursor-before-submit-prompt|codex-pre-tool-use");
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
      const have = installedShims();
      out(`  installed: ${have.length ? have.join(" ") : "none (ladon shim install)"}`);
      const py = PY_SHIMS.filter((t) => have.includes(t));
      out(py.length === PY_SHIMS.length ? "  ✓ python -m pip / -m uv gated (python shims)" : "  ✗ python shims missing — ladon shim install");
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

// Allow importing main() in tests without running.
const isEntry = process.argv[1] && /(?:^|[\\/])(index\.js|ladon)$/.test(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      err(`ladon: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
