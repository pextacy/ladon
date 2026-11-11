import { AGENT_CONFIG_TARGETS } from "./patterns.js";

/**
 * Package-wide R15: which AI-tool config files does this code *write* (not merely mention)?
 * We collect the destination expressions of write calls — JS `fs.writeFile*` / `appendFile*` /
 * `createWriteStream` / fs-extra `outputFile`/`writeJson` (first argument), copy / rename / symlink
 * (second argument), Python `open(…, "w"|"a"|"x")`, `Path(…).write_text`, `shutil.copy*`/`move`
 * (destination), shell `>`/`>>`/`tee`/`cp`/`mv` — resolve plain identifiers through their
 * assignments (two levels), and test those expressions against AGENT_CONFIG_TARGETS. Nothing runs.
 */

const MAX_ARG = 600;

/** Split the arguments of a call whose "(" ends right before `start`. Quote/bracket aware, bounded. */
export function callArgs(code: string, start: number, max = 3): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let q: string | null = null;
  const end = Math.min(code.length, start + MAX_ARG);
  for (let i = start; i < end; i++) {
    const c = code[i]!;
    if (q) {
      cur += c;
      if (c === "\\" && i + 1 < end) cur += code[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
      if (args.length >= max) return args;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

/** Right-hand side of an assignment starting at `start`, up to a depth-0 `;`, `,` or newline. */
function rhs(code: string, start: number): string {
  let depth = 0;
  let q: string | null = null;
  const end = Math.min(code.length, start + MAX_ARG);
  let i = start;
  for (; i < end; i++) {
    const c = code[i]!;
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ";" || c === "," || c === "\n")) break;
  }
  return code.slice(start, i);
}

const IDENT = /[A-Za-z_$][\w$]*/g;

function assignments(code: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*[\w.[\]<>| ]+)?=(?![=>])\s*/g)) {
    const expr = rhs(code, m.index! + m[0].length);
    if (!expr) continue;
    const list = out.get(m[1]!) ?? [];
    if (list.length < 8) list.push(expr);
    out.set(m[1]!, list);
  }
  return out;
}

/** Replace identifiers (outside string literals) with what they were assigned, two levels deep. */
function resolve(expr: string, vars: Map<string, string[]>, depth = 2): string {
  if (depth === 0 || vars.size === 0) return expr;
  // split into [code, "string", code, 'string', …]; only code parts are rewritten
  return expr
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(IDENT, (id) => {
            const v = vars.get(id);
            return v ? `(${v.map((e) => resolve(e, vars, depth - 1)).join(" | ")})` : id;
          }),
    )
    .join("");
}

const JS_WRITE = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|outputFile|outputFileSync|outputJson|outputJsonSync|writeJson|writeJsonSync|writeJSON|writeJSONSync)\s*\(/g;
const JS_COPY = /\b(?:copyFile|copyFileSync|cp|cpSync|rename|renameSync|symlink|symlinkSync|copy|copySync|move|moveSync|ensureSymlink|ensureSymlinkSync)\s*\(/g;
const PY_OPEN = /\b(?:open|io\.open|codecs\.open)\s*\(/g;
const PY_WRITE_METHOD = /\.write_(?:text|bytes)\s*\(/g;
const PY_COPY = /\bshutil\.(?:copy\w*|move)\s*\(|\bos\.(?:rename|replace|symlink)\s*\(/g;
const SH_TARGET = /(?:>>?\s*|\btee\s+(?:-a\s+)?|\b(?:cp|mv|install)\s+(?:-\S+\s+)*\S+\s+|\bln\s+(?:-\S+\s+)*\S+\s+)(['"]?[^\s'"|;&<>]+)/g;

const writeMode = (args: string[]): boolean => {
  const kw = args.find((a) => /^mode\s*=/.test(a));
  const m = kw ? kw.replace(/^mode\s*=\s*/, "") : args[1] && !/^\w+\s*=/.test(args[1]) ? args[1] : undefined;
  return !!m && /^[rbuf]*['"][^'"]*[wax+][^'"]*['"]$/.test(m.trim());
};

/** Destination expressions of writes in `code`. */
export function writeTargets(code: string, lang: "js" | "py" | "sh"): string[] {
  const out: string[] = [];
  const push = (e: string | undefined) => {
    if (e && out.length < 500) out.push(e);
  };
  if (lang === "js") {
    for (const m of code.matchAll(JS_WRITE)) push(callArgs(code, m.index! + m[0].length, 1)[0]);
    for (const m of code.matchAll(JS_COPY)) push(callArgs(code, m.index! + m[0].length, 2)[1]);
  } else if (lang === "py") {
    for (const m of code.matchAll(PY_OPEN)) {
      const args = callArgs(code, m.index! + m[0].length, 3);
      if (writeMode(args)) push(args[0]);
    }
    for (const m of code.matchAll(PY_WRITE_METHOD)) {
      // the receiver: text before ".write_text(" on the same line
      const lineStart = code.lastIndexOf("\n", m.index!) + 1;
      push(code.slice(Math.max(lineStart, m.index! - 300), m.index!));
    }
    for (const m of code.matchAll(PY_COPY)) push(callArgs(code, m.index! + m[0].length, 2)[1]);
  } else {
    for (const m of code.matchAll(SH_TARGET)) push(m[1]);
  }
  return out;
}

const HINT = /\.claude|claude_desktop|\.cursor|\.vscode|mcp\.json|\.codex|\.gemini|\.windsurf|\.codeium|\.continue|\.clinerules|cline_mcp/;
const COMPILED = AGENT_CONFIG_TARGETS.map((t) => ({ ...t, rx: new RegExp(t.re) }));

/**
 * The destination is in the user's home / app-data directory (where agent CLIs read their global
 * config). Project-relative writes — e.g. `playwright init-agents` creating `.mcp.json` in the repo
 * on the user's request — are not the persistence pattern.
 */
const HOME_ANCHOR =
  /homedir\s*\(|\bos\.homedir\b|process\.env(?:\.|\[\s*['"])(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME)\b|getPath\(\s*['"](?:home|appData|userData)['"]|expanduser\s*\(|Path\.home\s*\(|os\.environ(?:\.get\s*\(|\[)\s*['"](?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME)['"]|getenv\s*\(\s*['"](?:HOME|USERPROFILE|APPDATA)['"]|\$\{?HOME\b|%(?:APPDATA|USERPROFILE|LOCALAPPDATA)%|(?:^|['"\x60\s=(])~[\\/]|\b(?:home|homeDir|homedir|home_dir|userHome|user_home|appData|app_data)\b|Library[\\/]Application Support/;

export interface AgentConfigWriteOptions {
  /** config families the package owns (AGENT_CONFIG_OWNERS) */
  skipFamilies?: string[];
  /** only count destinations inside the home / app-data directory */
  homeOnly?: boolean;
}

/** "writes to <tool> config" labels for the AI-tool config files `code` writes. */
export function agentConfigWrites(code: string, lang: "js" | "py" | "sh", opts: AgentConfigWriteOptions | string[] = {}): string[] {
  const { skipFamilies = [], homeOnly = false } = Array.isArray(opts) ? { skipFamilies: opts } : opts;
  // cheap prefilter: the path may be assembled across statements, so only look for a fragment
  if (!HINT.test(code)) return [];
  const families = COMPILED.filter((t) => !skipFamilies.includes(t.family));
  const targets = writeTargets(code, lang);
  if (targets.length === 0) return [];
  const vars = lang === "sh" ? new Map<string, string[]>() : assignments(code);
  const resolved = targets.map((t) => resolve(t.replace(/^\$\{?(\w+)\}?/, "$1"), vars));
  if (lang === "sh") {
    // shell: VAR=... then > "$VAR"
    for (const m of code.matchAll(/^\s*(?:export\s+)?(\w+)=(\S+)/gm)) {
      for (let i = 0; i < targets.length; i++) if (new RegExp(`^['"]?\\$\\{?${m[1]}\\b`).test(targets[i]!)) resolved[i] += ` ${m[2]}`;
    }
  }
  const dests = homeOnly ? resolved.filter((r) => HOME_ANCHOR.test(r)) : resolved;
  const hit = families.filter((f) => dests.some((r) => f.rx.test(r)));
  // "cursor/mcp.json" is Cursor's MCP config: report the specific tool, not also generic MCP
  const specific = hit.length > 1 ? hit.filter((f) => f.family !== "mcp") : hit;
  return specific.map((f) => `writes to ${f.label}`);
}
