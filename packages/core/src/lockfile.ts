import { normalizePypiName } from "./parse/command.js";
import type { Ecosystem } from "./schemas.js";

/**
 * Integrity tokens in a comparable form: npm SRI ("sha512-<base64>", space-separated lists split)
 * and Python hashes ("sha256:<hex>", lowercased). Unknown shapes are dropped.
 */
export function integrityTokens(value: string | string[] | undefined): string[] {
  const out = new Set<string>();
  for (const v of Array.isArray(value) ? value : [value ?? ""]) {
    for (const tok of v.trim().split(/\s+/)) {
      const sri = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(tok);
      if (sri) out.add(`${sri[1]}-${sri[2]}`);
      const hex = /^(sha256|sha384|sha512|md5):([0-9a-fA-F]+)$/.exec(tok);
      if (hex) out.add(`${hex[1]}:${hex[2]!.toLowerCase()}`);
    }
  }
  return [...out];
}

/** Algorithm of an integrity token, e.g. "sha512-…" → "sha512-", "sha256:…" → "sha256:". */
const algOf = (t: string) => /^[a-z0-9]+[-:]/.exec(t)?.[0] ?? "";

/**
 * Compare lockfile hashes with what the registry publishes for the same version. Every locked hash
 * whose algorithm the registry also publishes must be among the registry's values (a PyPI release
 * has one sha256 per file). "unknown" when no algorithm overlaps — nothing is claimed then.
 */
export function compareIntegrity(locked: string[], registry: string[]): "match" | "mismatch" | "unknown" {
  const byAlg = new Map<string, Set<string>>();
  for (const r of registry) {
    const a = algOf(r);
    const set = byAlg.get(a) ?? new Set<string>();
    set.add(r);
    byAlg.set(a, set);
  }
  let matched = false;
  for (const l of locked) {
    const set = byAlg.get(algOf(l));
    if (!set) continue;
    if (!set.has(l)) return "mismatch";
    matched = true;
  }
  return matched ? "match" : "unknown";
}

/** name → locked versions (+ integrity), per ecosystem. Used for the lockfile fast path and R12. */
export class LockfileIndex {
  private map = new Map<string, Set<string>>();
  private hashes = new Map<string, Set<string>>();
  readonly sources: string[] = [];

  private key(eco: Ecosystem, name: string) {
    return `${eco}:${eco === "pypi" ? normalizePypiName(name) : name}`;
  }
  add(eco: Ecosystem, name: string, version: string, integrity?: string | string[]) {
    const k = this.key(eco, name);
    const s = this.map.get(k) ?? new Set<string>();
    s.add(version);
    this.map.set(k, s);
    const toks = integrityTokens(integrity);
    if (toks.length > 0) {
      const hk = `${k}@${version}`;
      const h = this.hashes.get(hk) ?? new Set<string>();
      for (const t of toks) h.add(t);
      this.hashes.set(hk, h);
    }
  }
  versions(eco: Ecosystem, name: string): string[] {
    return [...(this.map.get(this.key(eco, name)) ?? [])];
  }
  /** integrity tokens recorded for this exact version (empty when the lockfile has none) */
  integrity(eco: Ecosystem, name: string, version: string): string[] {
    return [...(this.hashes.get(`${this.key(eco, name)}@${version}`) ?? [])];
  }
  has(eco: Ecosystem, name: string): boolean {
    return this.map.has(this.key(eco, name));
  }
  get size() {
    return this.map.size;
  }
}

export function parsePackageLock(text: string, idx = new LockfileIndex()): LockfileIndex {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return idx;
  }
  type Entry = { version?: unknown; name?: unknown; integrity?: unknown; dependencies?: unknown };
  const obj = (json ?? {}) as { packages?: Record<string, Entry>; dependencies?: Record<string, Entry> };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  for (const [path, info] of Object.entries(obj.packages ?? {})) {
    const version = str(info?.version);
    if (!path || !version) continue;
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path);
    const name = str(info.name) ?? m?.[1];
    if (name) idx.add("npm", name, version, str(info.integrity));
  }
  const walk = (deps: Record<string, Entry> | undefined) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      const version = str(info?.version);
      if (version && !version.includes(":")) idx.add("npm", name, version, str(info.integrity));
      if (info?.dependencies && typeof info.dependencies === "object") walk(info.dependencies as Record<string, Entry>);
    }
  };
  walk(obj.dependencies);
  idx.sources.push("package-lock.json");
  return idx;
}

export function parsePnpmLock(text: string, idx = new LockfileIndex()): LockfileIndex {
  // v6+: "  /name@1.2.3:" or "  name@1.2.3:" ; v5: "  /name/1.2.3:"; scoped names keep their slash.
  // The entry's `resolution: {integrity: …}` sits on a deeper-indented line below it.
  const re = /^ {2}['"]?\/?((?:@[^@/\s'"]+\/)?[^@/\s'"(]+)[@/](\d[^:'"()\s]*)/;
  let cur: [string, string] | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) {
      cur = [m[1]!, m[2]!];
      idx.add("npm", cur[0], cur[1]);
      continue;
    }
    if (!/^ {3,}/.test(line)) {
      cur = undefined;
      continue;
    }
    const integ = cur && /\bintegrity:\s*['"]?([A-Za-z0-9+/=-]+)/.exec(line);
    if (cur && integ) idx.add("npm", cur[0], cur[1], integ[1]);
  }
  idx.sources.push("pnpm-lock.yaml");
  return idx;
}

export function parseYarnLock(text: string, idx = new LockfileIndex()): LockfileIndex {
  const blocks = text.split(/\n(?=\S)/);
  for (const b of blocks) {
    const head = /^"?((?:@[^@\s"]+\/)?[^@\s",]+)@/.exec(b);
    const ver = /\n\s+version:? "?([^"\s]+)"?/.exec(b);
    // yarn v1 `integrity sha512-…`; berry's `checksum:` is a different hash and is not compared
    const integ = /\n\s+integrity:? "?([^"\s]+)"?/.exec(b);
    if (head && ver) idx.add("npm", head[1]!, ver[1]!, integ?.[1]);
  }
  idx.sources.push("yarn.lock");
  return idx;
}

const PY_HASH = /\bhash\s*=\s*"((?:sha256|sha384|sha512|md5):[0-9a-fA-F]+)"/g;

/**
 * poetry.lock / uv.lock / pdm.lock — all use [[package]] name = "..." version = "...". File hashes:
 * uv `sdist`/`wheels = [{ hash = "sha256:…" }]`, poetry/pdm `files = [{ hash = "sha256:…" }]`, and
 * the older poetry `[metadata.files]` table.
 */
export function parseTomlLock(text: string, file: string, idx = new LockfileIndex()): LockfileIndex {
  const versionsOf = new Map<string, string[]>();
  for (const raw of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    // a package block ends at the first table that is not one of its own sub-tables
    const block = raw.split(/^\[{1,2}(?!\[|package[.\]])/m)[0]!;
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block);
    const ver = /^version\s*=\s*"([^"]+)"/m.exec(block);
    if (!name || !ver) continue;
    idx.add("pypi", name[1]!, ver[1]!, [...block.matchAll(PY_HASH)].map((m) => m[1]!));
    versionsOf.set(normalizePypiName(name[1]!), [...(versionsOf.get(normalizePypiName(name[1]!)) ?? []), ver[1]!]);
  }
  const meta = /^\[metadata\.files\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
  if (meta) {
    for (const m of meta[1]!.matchAll(/^"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=\s*\[([\s\S]*?)^\]/gm)) {
      const vs = versionsOf.get(normalizePypiName(m[1]!)) ?? [];
      if (vs.length === 1) idx.add("pypi", m[1]!, vs[0]!, [...m[2]!.matchAll(PY_HASH)].map((h) => h[1]!));
    }
  }
  idx.sources.push(file);
  return idx;
}

export function parsePinnedRequirements(text: string, file: string, idx = new LockfileIndex()): LockfileIndex {
  let any = false;
  // join backslash continuations so `--hash=sha256:…` lines stay with their requirement
  for (const line of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^\s;#]+)/.exec(line);
    if (m) {
      const hashes = [...line.matchAll(/--hash[=\s]+((?:sha256|sha384|sha512):[0-9a-fA-F]+)/g)].map((h) => h[1]!);
      idx.add("pypi", m[1]!, m[2]!, hashes);
      any = true;
    }
  }
  if (any) idx.sources.push(file);
  return idx;
}

export const LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock", "pdm.lock", "requirements.txt"] as const;

export function parseLockfile(file: string, text: string, idx = new LockfileIndex()): LockfileIndex {
  const base = file.split(/[\\/]/).pop() ?? file;
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return parsePackageLock(text, idx);
  if (base === "pnpm-lock.yaml") return parsePnpmLock(text, idx);
  if (base === "yarn.lock") return parseYarnLock(text, idx);
  if (base.endsWith(".lock")) return parseTomlLock(text, base, idx);
  if (base.endsWith(".txt")) return parsePinnedRequirements(text, base, idx);
  return idx;
}
