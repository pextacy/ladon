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

/** VS Code user-settings folders (macOS, Linux, Windows) — only the ones that exist are read. */
export function vscodeUserDirs(env: Record<string, string | undefined> = process.env, h = home): string[] {
  return [
    join(h, "Library", "Application Support", "Code", "User"),
    join(h, ".config", "Code", "User"),
    join(env.APPDATA ?? join(h, "AppData", "Roaming"), "Code", "User"),
  ];
}

export const GLOBAL_WATCHED = [
  join(home, ".claude", "settings.json"),
  join(home, ".claude", "settings.local.json"),
  join(home, ".claude.json"),
  join(home, ".cursor", "mcp.json"),
  join(home, ".cursor", "hooks.json"),
  join(home, ".codeium", "windsurf", "mcp_config.json"),
  join(home, ".codex", "config.toml"),
  join(home, ".codex", "hooks.json"),
  join(home, ".gemini", "settings.json"),
  join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  ...vscodeUserDirs().flatMap((d) => [join(d, "mcp.json"), join(d, "tasks.json"), join(d, "settings.json")]),
];
const PROJECT_WATCHED = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
  ".cursor/mcp.json",
  ".cursor/hooks.json",
  ".vscode/tasks.json",
  ".vscode/mcp.json",
  ".vscode/settings.json",
  ".gemini/settings.json",
  ".codex/config.toml",
  ".codex/hooks.json",
];

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

/** JSON with comments and trailing commas (VS Code's settings/tasks/mcp files) → plain JSON text. */
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

type Item = { kind: WatchAlert["kind"]; item: string };

/** Quoted strings in a TOML value (`"a"`, `'b'`, arrays of them). */
const tomlStrings = (v: string) => [...v.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "");

/** Codex config.toml: MCP servers, `notify` (runs a program on agent events) and `[hooks.*]` commands. */
function tomlItems(text: string): Item[] {
  const items: Item[] = [];
  for (const m of text.matchAll(/^\[mcp_servers\.([^\]]+)\][\s\S]*?command\s*=\s*"([^"]*)"/gm)) items.push({ kind: "mcp", item: `${m[1]}: ${m[2]}` });
  // split into [table] sections; "" = top level
  const sections: { name: string; body: string }[] = [{ name: "", body: "" }];
  for (const line of text.split(/\r?\n/)) {
    const hdr = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (hdr) sections.push({ name: hdr[1]!.replace(/["'\s]/g, ""), body: "" });
    else sections[sections.length - 1]!.body += line.replace(/(^|\s)#.*$/, "") + "\n";
  }
  for (const { name, body } of sections) {
    if (name === "") {
      const n = /^\s*notify\s*=\s*(\[[^\]]*\])/m.exec(body);
      if (n) items.push({ kind: "hook", item: `notify: ${tomlStrings(n[1]!).join(" ")}` });
    }
    if (name !== "hooks" && !name.startsWith("hooks.")) continue;
    const event = name === "hooks" ? "" : name.slice(6);
    // `command = "..."` / `command = [..]`, also inside inline tables of `Event = [{ command = ... }]`
    for (const kv of body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*([\s\S]*?)(?=^\s*[A-Za-z0-9_-]+\s*=|(?![\s\S]))/gm)) {
      const key = kv[1]!;
      const val = kv[2]!;
      const ev = event || key;
      if (key === "command") items.push({ kind: "hook", item: `${ev}: ${tomlStrings(val).join(" ")}` });
      else for (const c of val.matchAll(/command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|\[[^\]]*\])/g)) items.push({ kind: "hook", item: `${ev}: ${tomlStrings(c[1]!).join(" ")}` });
    }
  }
  return items;
}

/** VS Code settings that make an agent or the editor run commands without asking. */
function vscodeSettingItems(obj: Record<string, unknown>): Item[] {
  const items: Item[] = [];
  const auto = obj["task.allowAutomaticTasks"];
  if (auto === "on" || auto === true) items.push({ kind: "task", item: "task.allowAutomaticTasks = on (folder-open tasks run without asking)" });
  for (const k of ["chat.tools.autoApprove", "chat.tools.global.autoApprove", "chat.agent.autoApprove", "github.copilot.chat.agent.autoApprove"]) {
    if (obj[k] === true) items.push({ kind: "task", item: `${k} = true (agent tools run without asking)` });
  }
  for (const k of ["chat.tools.terminal.autoApprove", "chat.agent.terminal.autoApprove", "github.copilot.chat.agent.terminal.allowList"]) {
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [pattern, ok] of Object.entries(v as Record<string, unknown>)) {
        if (ok === true || (typeof ok === "object" && ok !== null && (ok as { approve?: unknown }).approve === true)) items.push({ kind: "task", item: `${k}: ${pattern} (terminal command auto-approved)` });
      }
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (/^terminal\.integrated\.automationProfile\./.test(k) && v && typeof v === "object") {
      const p = v as { path?: unknown; args?: unknown };
      items.push({ kind: "task", item: `${k}: ${[p.path, ...(Array.isArray(p.args) ? p.args : [])].filter((x) => typeof x === "string").join(" ")}` });
    }
  }
  return items;
}

/** Security-relevant items in a config file, as stable strings. */
export function extractItems(path: string, text: string): Item[] {
  const items: Item[] = [];
  if (path.endsWith(".toml")) return tomlItems(text);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    try {
      json = JSON.parse(stripJsonc(text));
    } catch {
      return [{ kind: "hook", item: `unparseable file ${h(text)}` }];
    }
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return items;
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
  // VS Code settings.json can define MCP servers under "mcp": { "servers": … }
  const mcp = obj.mcp as { servers?: unknown } | undefined;
  if (mcp && typeof mcp === "object") walkMcp(mcp.servers);
  if (obj.projects && typeof obj.projects === "object") {
    for (const p of Object.values(obj.projects as Record<string, { mcpServers?: unknown }>)) walkMcp(p?.mcpServers);
  }
  if (Array.isArray(obj.tasks)) {
    for (const t of obj.tasks as { label?: string; command?: string; runOptions?: { runOn?: string } }[]) {
      if (t.runOptions?.runOn === "folderOpen") items.push({ kind: "task", item: `${t.label ?? "task"} (runs on folder open): ${t.command ?? ""}` });
    }
  }
  items.push(...vscodeSettingItems(obj));
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
/** One line, no credentials: URL userinfo and query strings (MCP URLs often carry tokens) are dropped. */
export function redactItem(item: string, max = 140): string {
  const one = item.replace(/\s*\n\s*/g, " ⏎ ").replace(/(\w+:\/\/)[^/\s@]+@/g, "$1…@").replace(/(\w+:\/\/[^\s?#]+)[?#]\S*/g, "$1?…");
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Exactly how init.ts writes a path: bare when safe, else single-quoted. */
const quotedForms = (p: string) => [p, `'${p.replace(/'/g, `'\\''`)}'`];
/** Every hook subcommand init.ts installs (Claude Code, Cursor, Codex). */
const OWN_HOOKS = "claude-pre-tool-use|claude-session-start|cursor|cursor-before-shell|cursor-before-submit-prompt|codex-pre-tool-use";
export function isOwnHook(item: string, cliPath = CLI_PATH, nodePath = process.execPath): boolean {
  const m = /^hook\|[A-Za-z]+(?:\([^)]*\))?: (.*)$/.exec(item);
  if (!m) return false;
  const cmd = m[1]!.trim();
  // The interpreter must be exactly this Node binary (or a bare `node` from PATH) — not any file whose
  // name merely ends in "node" (`/tmp/evilnode /…/index.js hook cursor` would otherwise be exempt).
  const nodes = ["node", ...quotedForms(nodePath)].map(esc).join("|");
  const clis = quotedForms(cliPath).map(esc).join("|");
  return new RegExp(`^(?:${nodes}) (?:${clis}) hook (?:${OWN_HOOKS})$`).test(cmd);
}

/** Compare watched files with the baseline. First sight of a global file sets the baseline silently; project files with hooks/MCP alert on first sight (cloned-repo attack). */
function watchedFiles(cwd?: string): { p: string; global: boolean }[] {
  return [...GLOBAL_WATCHED.map((p) => ({ p, global: true })), ...(cwd ? projectFiles(cwd).map((p) => ({ p, global: false })) : [])];
}

/** All items in a watched file, Ladon's own hooks included; null when missing / unreadable. */
function readAllItems(p: string): Item[] | null {
  if (!existsSync(p)) return null;
  try {
    return extractItems(p, readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readItems(p: string): Item[] | null {
  return readAllItems(p)?.filter((i) => !isOwnHook(`${i.kind}|${i.item}`)) ?? null;
}

export interface WatchedFile {
  path: string;
  items: { kind: WatchAlert["kind"]; item: string; isNew: boolean }[];
}

/**
 * Current hooks / MCP servers / auto-run settings in every watched file for `cwd` (global + project),
 * marked new when not in the baseline. Read-only: the baseline is not updated (used by `ladon scan`).
 */
export function listWatched(cwd: string): WatchedFile[] {
  const snap = loadSnap();
  const out: WatchedFile[] = [];
  for (const { p, global } of watchedFiles(cwd)) {
    const items = readItems(p);
    if (!items || items.length === 0) continue;
    const before = snap[p];
    const prev = new Set(before ?? []);
    out.push({ path: p, items: items.map((i) => ({ ...i, isNew: before === undefined ? !global : !prev.has(`${i.kind}|${i.item}`) })) });
  }
  return out;
}

export function checkWatched(opts: { cwd?: string; update?: boolean } = {}): WatchAlert[] {
  const snap = loadSnap();
  const alerts: WatchAlert[] = [];
  for (const { p, global } of watchedFiles(opts.cwd)) {
    const ownKey = `${p}#ladon`;
    // Ladon's own hook disappearing (an agent or tool "cleaning up" the config) silently turns the gate
    // off, so it is an alert too.
    const ownRemoved = () => {
      if (!snap[ownKey]) return;
      delete snap[ownKey];
      alerts.push({ path: p, kind: "hook", item: "ladon", detail: `Ladon's own hook was removed from ${p.replace(home, "~")} — installs are no longer gated there. Run \`ladon init\` to restore it.` });
    };
    const all = readAllItems(p);
    if (!all) {
      if (!existsSync(p)) ownRemoved();
      continue;
    }
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
      alerts.push({ path: p, kind: i.kind, item: i.item, detail: `${what} in ${p.replace(home, "~")}: ${redactItem(i.item)}` });
    }
    snap[p] = keys;
  }
  if (opts.update !== false) {
    mkdirSync(LADON_HOME, { recursive: true, mode: 0o700 });
    writeFileSync(PATHS.watch, JSON.stringify(snap, null, 2), { mode: 0o600 });
  }
  return alerts;
}
