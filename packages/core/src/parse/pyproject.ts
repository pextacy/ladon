import type { InstallTarget } from "../schemas.js";
import { parsePipSpec } from "./command.js";

/**
 * Dependencies from Python project manifests (pyproject.toml, Pipfile) without a TOML dependency.
 * Supports the subset these files use in practice: [tables], `key = "string"`, `key = { inline }`,
 * and (multi-line) arrays of strings. Anything else is skipped, never executed.
 */

export interface PyManifestDeps {
  targets: InstallTarget[];
  nonRegistry: string[];
}

type TomlValue = string | string[] | Record<string, string> | boolean | number | null;

/** Strip a trailing `# comment` that is not inside a string. */
function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

const STR = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

function strings(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(STR)) out.push((m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1"));
  return out;
}

function parseValue(raw: string): TomlValue {
  const v = raw.trim();
  if (v.startsWith("[")) return strings(v);
  if (v.startsWith("{")) {
    const obj: Record<string, string> = {};
    const body = v.replace(/^\{|\}$/g, "");
    for (const m of body.matchAll(/([A-Za-z0-9_.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|true|false|[\d.]+)/g)) obj[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    return obj;
  }
  const s = strings(v);
  if (s.length > 0 && /^["']/.test(v)) return s[0]!;
  if (v === "true" || v === "false") return v === "true";
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Minimal TOML: returns table path → key → value. Bare `key = value` before any table goes under "". */
export function parseTomlSubset(text: string): Map<string, Map<string, TomlValue>> {
  const tables = new Map<string, Map<string, TomlValue>>();
  let current = "";
  tables.set(current, new Map());
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]!).trim();
    if (!line) continue;
    const t = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (t) {
      current = t[1]!.replace(/\s*\.\s*/g, ".").replace(/["']/g, "");
      if (!tables.has(current)) tables.set(current, new Map());
      continue;
    }
    const kv = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.replace(/^["']|["']$/g, "");
    let value = kv[2]!;
    // multi-line array or inline table
    const open = value.trim()[0];
    if (open === "[" || open === "{") {
      const close = open === "[" ? "]" : "}";
      let depth = 0;
      const count = (s: string) => {
        for (const m of s.replace(STR, "").split("")) {
          if (m === open) depth++;
          else if (m === close) depth--;
        }
      };
      count(value);
      while (depth > 0 && i + 1 < lines.length) {
        line = stripComment(lines[++i]!);
        value += "\n" + line;
        count(line);
      }
    }
    tables.get(current)!.set(key, parseValue(value));
  }
  return tables;
}

function addSpec(out: PyManifestDeps, spec: string) {
  const r = parsePipSpec(spec);
  if (r.target) out.targets.push(r.target);
  if (r.nonRegistry) out.nonRegistry.push(r.nonRegistry);
}

/** Poetry / Pipfile style `name = "^1.2"` or `name = { version = "1.2", git = ... }`. */
function addKeyed(out: PyManifestDeps, name: string, v: TomlValue) {
  if (name.toLowerCase() === "python") return;
  if (typeof v === "string") {
    const spec = v.trim();
    if (spec === "*" || spec === "") out.targets.push({ ecosystem: "pypi", name });
    else {
      // poetry caret/tilde ranges are not PEP 440 — keep the name, drop the range
      const pep = /^[\^~](?!=)/.test(spec) ? "" : /^[\d]/.test(spec) ? `==${spec}` : spec;
      addSpec(out, `${name}${pep}`);
    }
    return;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (v.git || v.path || v.url || v.file) {
      out.nonRegistry.push(`${name} (${v.git ?? v.path ?? v.url ?? v.file})`);
      return;
    }
    addKeyed(out, name, v.version ?? "*");
  }
}

export function parsePyprojectDeps(text: string): PyManifestDeps {
  const out: PyManifestDeps = { targets: [], nonRegistry: [] };
  const toml = parseTomlSubset(text);
  for (const [table, entries] of toml) {
    if (table === "project") {
      const d = entries.get("dependencies");
      if (Array.isArray(d)) d.forEach((s) => addSpec(out, s));
    } else if (table === "project.optional-dependencies" || table === "dependency-groups") {
      for (const v of entries.values()) if (Array.isArray(v)) v.forEach((s) => addSpec(out, s));
    } else if (table === "tool.uv") {
      const d = entries.get("dev-dependencies");
      if (Array.isArray(d)) d.forEach((s) => addSpec(out, s));
    } else if (table === "build-system") {
      const d = entries.get("requires");
      if (Array.isArray(d)) d.forEach((s) => addSpec(out, s));
    } else if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(table)) {
      for (const [k, v] of entries) addKeyed(out, k, v);
    }
  }
  return dedupe(out);
}

export function parsePipfileDeps(text: string): PyManifestDeps {
  const out: PyManifestDeps = { targets: [], nonRegistry: [] };
  const toml = parseTomlSubset(text);
  for (const t of ["packages", "dev-packages"]) for (const [k, v] of toml.get(t) ?? []) addKeyed(out, k, v);
  return dedupe(out);
}

function dedupe(d: PyManifestDeps): PyManifestDeps {
  const seen = new Set<string>();
  d.targets = d.targets.filter((t) => {
    const k = t.name.toLowerCase().replace(/[-_.]+/g, "-");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return d;
}
