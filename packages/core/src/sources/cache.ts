import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

interface Entry<T> {
  v: T;
  exp: number;
}

export const TTL = {
  metadata: 24 * 3_600_000,
  osv: 3_600_000,
  downloads: 24 * 3_600_000,
  atlas: 3_600_000,
  analysis: 7 * 24 * 3_600_000, // a published tarball never changes
} as const;

export class MemoryCache implements Cache {
  private map = new Map<string, Entry<unknown>>();
  constructor(private readonly now: () => number = Date.now) {}
  async get<T>(key: string): Promise<T | undefined> {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.v as T;
  }
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.map.set(key, { v: value, exp: this.now() + ttlMs });
  }
}

/** JSON-file cache (one file per key) — survives across CLI invocations. */
export class FileCache implements Cache {
  private mem = new MemoryCache();
  constructor(private readonly dir: string) {}
  private path(key: string) {
    return join(this.dir, createHash("sha256").update(key).digest("hex").slice(0, 40) + ".json");
  }
  async get<T>(key: string): Promise<T | undefined> {
    const m = await this.mem.get<T>(key);
    if (m !== undefined) return m;
    try {
      const e = JSON.parse(await readFile(this.path(key), "utf8")) as Entry<T> & { k?: string };
      if (e.k !== key || e.exp < Date.now()) return undefined;
      await this.mem.set(key, e.v, e.exp - Date.now());
      return e.v;
    } catch {
      return undefined;
    }
  }
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.mem.set(key, value, ttlMs);
    try {
      await mkdir(this.dir, { recursive: true });
      const p = this.path(key);
      const tmp = `${p}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ k: key, v: value, exp: Date.now() + ttlMs }));
      await rename(tmp, p);
    } catch {
      // cache is best-effort
    }
  }
}

export async function cached<T>(cache: Cache | undefined, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  if (!cache) return load();
  const hit = await cache.get<{ value: T }>(key);
  if (hit !== undefined) return hit.value;
  const value = await load();
  await cache.set(key, { value }, ttlMs);
  return value;
}
