import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { keyFingerprint } from "@ladon/core";
import { keyHello } from "./approve/key.js";
import { pinPasskey, serverPasskeys } from "./approve/passkey.js";
import { humanApprovesApproverChange } from "./confirm.js";
import { listKeyPorts, openSerial } from "./approve/serial.js";
import { CLI_ENTRY } from "./client.js";
import { loadConfig, loadState, saveConfig, saveState } from "./config.js";
import { installShims, PATH_LINE, shimsActive, shq } from "./shim.js";
import { createDevice } from "./web.js";
import { checkWatched } from "./watch.js";

const cli = (sub: string) => `${shq(process.execPath)} ${shq(CLI_ENTRY)} ${sub}`;

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };

const PRE_MATCHER = "Bash|Edit|Write|MultiEdit|NotebookEdit";
const OUR_HOOKS = [
  { event: "PreToolUse", sub: "hook claude-pre-tool-use", timeout: 150, matcher: PRE_MATCHER },
  { event: "SessionStart", sub: "hook claude-session-start", timeout: 20 },
] as const;

/**
 * Add Ladon's PreToolUse + SessionStart hooks to a Claude Code settings file. Idempotent; existing Ladon
 * entries are refreshed (a hook pointing at a moved/old CLI path would just fail — and a failing hook
 * lets the tool call through). Other settings and hooks are left untouched; a backup is written only
 * when the file actually changes.
 */
export function installClaudeHooks(settingsPath: string, cliCmd: (sub: string) => string = cli): "added" | "present" {
  let settings: { hooks?: Record<string, HookEntry[]> } & Record<string, unknown> = {};
  const before = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  if (before !== null && before.trim() !== "") settings = JSON.parse(before) as typeof settings;
  if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) settings.hooks = {};
  const hooks = settings.hooks;
  let changed = false;
  for (const o of OUR_HOOKS) {
    const list = Array.isArray(hooks[o.event]) ? hooks[o.event]! : (hooks[o.event] = []);
    const want = cliCmd(o.sub);
    let found = false;
    for (const e of list) {
      for (const h of Array.isArray(e?.hooks) ? e.hooks : []) {
        if (typeof h?.command !== "string" || !h.command.includes(o.sub)) continue;
        found = true;
        if (h.command !== want || h.timeout !== o.timeout || h.type !== "command") {
          h.type = "command";
          h.command = want;
          h.timeout = o.timeout;
          changed = true;
        }
        if ("matcher" in o && e.matcher !== o.matcher) {
          e.matcher = o.matcher; // upgrade older installs (Bash-only matcher)
          changed = true;
        }
      }
    }
    if (!found) {
      list.push({ ...("matcher" in o ? { matcher: o.matcher } : {}), hooks: [{ type: "command", command: want, timeout: o.timeout }] });
      changed = true;
    }
  }
  if (!changed) return "present";
  mkdirSync(dirname(settingsPath), { recursive: true });
  if (before !== null) writeFileSync(`${settingsPath}.ladon-backup`, before);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return "added";
}

/** Cursor hooks.json (beforeShellExecution). */
export function installCursorHooks(path = join(homedir(), ".cursor", "hooks.json"), cliCmd: (sub: string) => string = cli): "added" | "present" {
  let cfg: { version?: number; hooks?: Record<string, { command?: string }[]> } = { version: 1, hooks: {} };
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (before !== null && before.trim() !== "") cfg = JSON.parse(before) as typeof cfg;
  cfg.version ??= 1;
  if (typeof cfg.hooks !== "object" || cfg.hooks === null || Array.isArray(cfg.hooks)) cfg.hooks = {};
  const list = Array.isArray(cfg.hooks.beforeShellExecution) ? cfg.hooks.beforeShellExecution : (cfg.hooks.beforeShellExecution = []);
  const want = cliCmd("hook cursor");
  const ours = list.filter((h) => typeof h?.command === "string" && h.command.includes("hook cursor"));
  if (ours.length > 0 && ours.every((h) => h.command === want)) return "present";
  for (const h of ours) h.command = want;
  if (ours.length === 0) list.push({ command: want });
  mkdirSync(dirname(path), { recursive: true });
  if (before !== null) writeFileSync(`${path}.ladon-backup`, before);
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return "added";
}

export async function pairKey(log: (s: string) => void): Promise<boolean> {
  const ports = await listKeyPorts();
  const path = process.env.LADON_KEY_PORT ?? ports[0]?.path;
  if (!path) {
    log("  no Ladon Key found on USB (plug it in and run `ladon key pair`)");
    return false;
  }
  const link = await openSerial(path);
  try {
    const hello = await keyHello(link);
    const before = loadConfig();
    if (before.key?.publicKey === hello.pk) {
      log(`  ✓ Ladon Key ${keyFingerprint(hello.pk)} already paired`);
      return true;
    }
    if (before.key) log(`  replacing previously paired Key ${keyFingerprint(before.key.publicKey)}`);
    await link.close(); // the existing Key (if any) may need the port for the approval below
    if (!(await humanApprovesApproverChange(`Ladon Key ${keyFingerprint(hello.pk)} (check the Key's screen shows this code)`, log))) return false;
    const cfg = loadConfig();
    cfg.key = { publicKey: hello.pk, path, pairedAt: new Date().toISOString(), ...(hello.name ? { name: hello.name } : {}) };
    saveConfig(cfg);
    const st = loadState();
    st.keyCounter = Math.max(st.keyCounter, hello.ctr);
    saveState(st);
    log(`  ✓ paired Ladon Key ${keyFingerprint(hello.pk)} on ${path} — check that the Key's screen shows the same code`);
    return true;
  } finally {
    await link.close();
  }
}

export async function registerDevice(log: (s: string) => void): Promise<string | undefined> {
  const cfg = loadConfig();
  if (cfg.device) return undefined;
  const label = `${process.env.USER ?? "user"}@${hostname()}`.slice(0, 60);
  const d = await createDevice(cfg, label);
  cfg.device = { id: d.deviceId, token: d.deviceToken, label };
  saveConfig(cfg);
  log(`  ✓ registered this machine with ${new URL(cfg.webUrl).host}`);
  return d.pairUrl;
}

/** Wait for a passkey registered after `since`, then pin it only once a human confirms. */
export async function waitForPasskey(log: (s: string) => void, timeoutMs = 5 * 60_000, since = Date.now() - 60_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const list = await serverPasskeys().catch(() => []);
    const pinned = new Set(loadConfig().passkeys.map((p) => p.credentialId));
    const fresh = list.find((p) => !pinned.has(p.credentialId) && (!p.createdAt || Date.parse(p.createdAt) >= since));
    if (fresh) {
      const what = `passkey "${fresh.label ?? "passkey"}" (${fresh.credentialId.slice(0, 8)}…, created ${fresh.createdAt?.slice(11, 19) ?? "just now"})`;
      if (!(await humanApprovesApproverChange(what, log))) return false;
      pinPasskey(fresh);
      log(`  ✓ pinned ${what} — approvals from it are verified on this machine`);
      return true;
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
  return false;
}

export interface InitOptions {
  project: boolean;
  cursor: boolean;
  shell: boolean;
  offline: boolean;
  passkey: boolean;
  atlasReports: boolean;
}

export async function init(o: InitOptions, log: (s: string) => void = (s) => process.stdout.write(s + "\n")) {
  const cfg = loadConfig();
  cfg.atlasReports = o.atlasReports || cfg.atlasReports;
  saveConfig(cfg);
  log("Ladon setup");
  const settings = o.project ? join(process.cwd(), ".claude", "settings.json") : join(homedir(), ".claude", "settings.json");
  log(`  ${installClaudeHooks(settings) === "added" ? "✓ added" : "✓ already has"} Claude Code hooks in ${settings.replace(homedir(), "~")}`);
  if (o.cursor) log(`  ${installCursorHooks() === "added" ? "✓ added" : "✓ already has"} Cursor beforeShellExecution hook`);
  installShims();
  if (shimsActive()) log("  ✓ package-manager shims active");
  else if (o.shell) {
    const rc = join(homedir(), process.env.SHELL?.endsWith("bash") ? ".bashrc" : ".zshrc");
    const cur = existsSync(rc) ? readFileSync(rc, "utf8") : "";
    if (!cur.includes("ladon shims")) appendFileSync(rc, `\n${PATH_LINE}\n`);
    log(`  ✓ shims added to PATH in ${rc.replace(homedir(), "~")} (open a new terminal)`);
  } else log(`  ▲ shims installed; add them to PATH so every install is gated:\n      ${PATH_LINE}`);
  checkWatched({ cwd: process.cwd(), update: true });
  log("  ✓ recorded a baseline of AI-tool hooks and MCP servers (guard-the-guards)");

  await pairKey(log).catch((e: unknown) => log(`  ▲ Key pairing failed: ${e instanceof Error ? e.message : String(e)}`));
  if (!o.offline) {
    try {
      const pairUrl = await registerDevice(log);
      if (o.passkey) {
        const url = pairUrl ?? `${loadConfig().webUrl.replace(/\/$/, "")}/pair`;
        log(`\n  Pair a passkey (phone or laptop) — open:\n      ${url}\n  waiting up to 5 minutes…`);
        if (!(await waitForPasskey(log))) log("  ▲ no passkey paired yet — run `ladon passkey pair` later");
      }
    } catch (e) {
      log(`  ▲ web registration skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const c = loadConfig();
  log(`\nApprovals: ${c.key ? "Ladon Key" : ""}${c.key && c.passkeys.length ? " + " : ""}${c.passkeys.length ? `${c.passkeys.length} passkey(s)` : ""}${!c.key && !c.passkeys.length ? "none paired — risky installs will be blocked until you pair a Key or passkey" : ""}`);
}
