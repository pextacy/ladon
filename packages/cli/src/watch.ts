import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LADON_HOME, PATHS } from "./config.js";

/**
 * Guard-the-guards (PRD §3): the Aug 2026 worm persisted by planting hooks in AI coding tools.
 * We snapshot the security-relevant parts of agent configs (hooks, MCP servers, auto-run tasks)
 * and alert on anything new that isn't Ladon itself.
 */

export interface WatchAlert {
  path: string;
  kind: "hook" | "mcp" | "task";
  item: string;
  detail: string;
}

type Snapshot = Record<string, string[]>;

const home = homedir();
export const GLOBAL_WATCHED = [
  join(home, ".claude", "settings.json"),
  join(home, ".claude", "settings.local.json"),
  join(home, ".claude.json"),
  join(home, ".cursor", "mcp.json"),
  join(home, ".cursor", "hooks.json"),
  join(home, ".codeium", "windsurf", "mcp_config.json"),
  join(home, ".codex", "config.toml"),
  join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
];
const PROJECT_WATCHED = [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", ".cursor/mcp.json", ".cursor/hooks.json", ".vscode/tasks.json", ".vscode/mcp.json"];

function projectFiles(cwd: string): string[] {
  const out: string[] = [];
  let d = resolve(cwd);
  for (let i = 0; i < 6; i++) {
    for (const f of PROJECT_WATCHED) out.push(join(d, f));
    if (existsSync(join(d, ".git")) || d === home) break;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Security-relevant items in a config file, as stable strings. */
export function extractItems(path: string, text: string): { kind: WatchAlert["kind"]; item: string }[] {
  const items: { kind: WatchAlert["kind"]; item: string }[] = [];
  if (path.endsWith(".toml")) {
    for (const m of text.matchAll(/^\[mcp_servers\.([^\]]+)\][\s\S]*?command\s*=\s*"([^"]*)"/gm)) items.push({ kind: "mcp", item: `${m[1]}: ${m[2]}` });
    return items;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [{ kind: "hook", item: `unparseable file ${h(text)}` }];
  }
  const walkHooks = (hooks: unknown) => {
    if (!hooks || typeof hooks !== "object") return;
    for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) {
      for (const entry of Array.isArray(list) ? list : []) {
        const e = entry as { matcher?: string; hooks?: { command?: string }[]; command?: string };
        const cmds = e.hooks?.map((x) => x.command ?? "") ?? (e.command ? [e.command] : []);
        for (const c of cmds) items.push({ kind: "hook", item: `${event}${e.matcher ? `(${e.matcher})` : ""}: ${c}` });
      }
    }
  };
  const walkMcp = (servers: unknown) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
      const d = def as { command?: string; args?: string[]; url?: string };
      items.push({ kind: "mcp", item: `${name}: ${d.url ?? [d.command, ...(d.args ?? [])].filter(Boolean).join(" ")}` });
    }
  };
  const obj = json as Record<string, unknown>;
  walkHooks(obj.hooks);
  walkMcp(obj.mcpServers ?? obj.servers);
  if (obj.projects && typeof obj.projects === "object") {
    for (const p of Object.values(obj.projects as Record<string, { mcpServers?: unknown }>)) walkMcp(p?.mcpServers);
  }
  if (Array.isArray(obj.tasks)) {
    for (const t of obj.tasks as { label?: string; command?: string; runOptions?: { runOn?: string } }[]) {
      if (t.runOptions?.runOn === "folderOpen") items.push({ kind: "task", item: `${t.label ?? "task"} (runs on folder open): ${t.command ?? ""}` });
    }
  }
  return items;
}

function loadSnap(): Snapshot {
  try {
    return JSON.parse(readFileSync(PATHS.watch, "utf8")) as Snapshot;
  } catch {
    return {};
  }
}

/**
 * Only Ladon's own hooks are exempt — matched exactly (this install's CLI path + a hook subcommand),
 * so a malicious hook can't hide by mentioning "ladon".
 */
const CLI_PATH = fileURLToPath(new URL("./index.js", import.meta.url));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Exactly how init.ts writes a path: bare when safe, else single-quoted. */
const quotedForms = (p: string) => [p, `'${p.replace(/'/g, `'\\''`)}'`];
export function isOwnHook(item: string, cliPath = CLI_PATH, nodePath = process.execPath): boolean {
  const m = /^hook\|[A-Za-z]+(?:\([^)]*\))?: (.*)$/.exec(item);
  if (!m) return false;
  const cmd = m[1]!.trim();
  // The interpreter must be exactly this Node binary (or a bare `node` from PATH) — not any file whose
  // name merely ends in "node" (`/tmp/evilnode /…/index.js hook cursor` would otherwise be exempt).
  const nodes = ["node", ...quotedForms(nodePath)].map(esc).join("|");
  const clis = quotedForms(cliPath).map(esc).join("|");
  return new RegExp(`^(?:${nodes}) (?:${clis}) hook (?:claude-pre-tool-use|claude-session-start|cursor)$`).test(cmd);
}

/** Compare watched files with the baseline. First sight of a global file sets the baseline silently; project files with hooks/MCP alert on first sight (cloned-repo attack). */
export function checkWatched(opts: { cwd?: string; update?: boolean } = {}): WatchAlert[] {
  const snap = loadSnap();
  const alerts: WatchAlert[] = [];
  const files = [...GLOBAL_WATCHED.map((p) => ({ p, global: true })), ...(opts.cwd ? projectFiles(opts.cwd).map((p) => ({ p, global: false })) : [])];
  for (const { p, global } of files) {
    const ownKey = `${p}#ladon`;
    // Ladon's own hook disappearing (an agent or tool "cleaning up" the config) silently turns the gate
    // off, so it is an alert too.
    const ownRemoved = () => {
      if (!snap[ownKey]) return;
      delete snap[ownKey];
      alerts.push({ path: p, kind: "hook", item: "ladon", detail: `Ladon's own hook was removed from ${p.replace(home, "~")} — installs are no longer gated there. Run \`ladon init\` to restore it.` });
    };
    if (!existsSync(p)) {
      ownRemoved();
      continue;
    }
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const all = extractItems(p, text);
    if (all.some((i) => isOwnHook(`${i.kind}|${i.item}`))) snap[ownKey] = ["present"];
    else ownRemoved();
    const items = all.filter((i) => !isOwnHook(`${i.kind}|${i.item}`));
    const keys = items.map((i) => `${i.kind}|${i.item}`);
    const before = snap[p];
    if (before === undefined && global) {
      snap[p] = keys;
      continue;
    }
    const prev = new Set(before ?? []);
    for (const i of items) {
      if (prev.has(`${i.kind}|${i.item}`)) continue;
      const what = i.kind === "hook" ? "new hook" : i.kind === "mcp" ? "new MCP server" : "new auto-run task";
      alerts.push({ path: p, kind: i.kind, item: i.item, detail: `${what} in ${p.replace(home, "~")}: ${i.item.slice(0, 140)}` });
    }
    snap[p] = keys;
  }
  if (opts.update !== false) {
    mkdirSync(LADON_HOME, { recursive: true, mode: 0o700 });
    writeFileSync(PATHS.watch, JSON.stringify(snap, null, 2), { mode: 0o600 });
  }
  return alerts;
}
