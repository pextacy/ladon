import { normalizePypiName } from "./parse/command.js";
import type { Ecosystem } from "./schemas.js";

/** name → locked versions, per ecosystem. Used for the lockfile fast path and R12. */
export class LockfileIndex {
  private map = new Map<string, Set<string>>();
  readonly sources: string[] = [];

  private key(eco: Ecosystem, name: string) {
    return `${eco}:${eco === "pypi" ? normalizePypiName(name) : name}`;
  }
  add(eco: Ecosystem, name: string, version: string) {
    const k = this.key(eco, name);
    const s = this.map.get(k) ?? new Set<string>();
    s.add(version);
    this.map.set(k, s);
  }
  versions(eco: Ecosystem, name: string): string[] {
    return [...(this.map.get(this.key(eco, name)) ?? [])];
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
  const obj = json as { packages?: Record<string, { version?: string; name?: string }>; dependencies?: Record<string, { version?: string }> };
  for (const [path, info] of Object.entries(obj.packages ?? {})) {
    if (!path || !info.version) continue;
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path);
    const name = info.name ?? m?.[1];
    if (name) idx.add("npm", name, info.version);
  }
  const walk = (deps: Record<string, { version?: string; dependencies?: Record<string, unknown> }> | undefined) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (info.version && !info.version.includes(":")) idx.add("npm", name, info.version);
      walk(info.dependencies as typeof deps);
    }
  };
  walk(obj.dependencies as Parameters<typeof walk>[0]);
  idx.sources.push("package-lock.json");
  return idx;
}

export function parsePnpmLock(text: string, idx = new LockfileIndex()): LockfileIndex {
  // v6+: "  /name@1.2.3:" or "  name@1.2.3:" ; v5: "  /name/1.2.3:"; scoped names keep their slash.
  const re = /^ {2}['"]?\/?((?:@[^@/\s'"]+\/)?[^@/\s'"(]+)[@/](\d[^:'"()\s]*)/gm;
  for (const m of text.matchAll(re)) idx.add("npm", m[1]!, m[2]!);
  idx.sources.push("pnpm-lock.yaml");
  return idx;
}

export function parseYarnLock(text: string, idx = new LockfileIndex()): LockfileIndex {
  const blocks = text.split(/\n(?=\S)/);
  for (const b of blocks) {
    const head = /^"?((?:@[^@\s"]+\/)?[^@\s",]+)@/.exec(b);
    const ver = /\n\s+version:? "?([^"\s]+)"?/.exec(b);
    if (head && ver) idx.add("npm", head[1]!, ver[1]!);
  }
  idx.sources.push("yarn.lock");
  return idx;
}

/** poetry.lock / uv.lock / pdm.lock — all use [[package]] name = "..." version = "..." */
export function parseTomlLock(text: string, file: string, idx = new LockfileIndex()): LockfileIndex {
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block);
    const ver = /^version\s*=\s*"([^"]+)"/m.exec(block);
    if (name && ver) idx.add("pypi", name[1]!, ver[1]!);
  }
  idx.sources.push(file);
  return idx;
}

export function parsePinnedRequirements(text: string, file: string, idx = new LockfileIndex()): LockfileIndex {
  let any = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^\s;#]+)/.exec(line);
    if (m) {
      idx.add("pypi", m[1]!, m[2]!);
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
