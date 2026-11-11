import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { LOCKFILE_NAMES, LockfileIndex, normalizePypiName, parseLockfile, type Ecosystem, type OsvSource } from "@ladon/core";

/**
 * `ladon audit`: every dependency in the project's lockfiles against
 *  - Atlas alerts (names models hallucinated that someone registered afterwards), and
 *  - OSV MAL-* advisories (known-malicious packages).
 * Only package names (and versions, for OSV) leave the machine — never paths or code (CLAUDE.md #5).
 */

export interface LockedDep {
  ecosystem: Ecosystem;
  name: string;
  versions: string[];
}

/** LockfileIndex that also remembers what was added, so we can list every locked dependency. */
class ListingIndex extends LockfileIndex {
  readonly all = new Map<string, LockedDep>();
  override add(eco: Ecosystem, name: string, version: string) {
    super.add(eco, name, version);
    const k = `${eco}:${eco === "pypi" ? normalizePypiName(name) : name}`;
    const d = this.all.get(k) ?? { ecosystem: eco, name: eco === "pypi" ? normalizePypiName(name) : name, versions: [] };
    if (version && !d.versions.includes(version)) d.versions.push(version);
    this.all.set(k, d);
  }
}

/** Lockfiles in the nearest directory (cwd → repo root) that has any. */
export function findLockfiles(cwd: string): string[] {
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const found = LOCKFILE_NAMES.map((n) => join(dir, n)).filter((p) => existsSync(p));
    if (found.length > 0 || existsSync(join(dir, ".git"))) return found;
    const up = dirname(dir);
    if (up === dir) return [];
    dir = up;
  }
  return [];
}

export function lockedDeps(files: string[]): { deps: LockedDep[]; unreadable: string[] } {
  const idx = new ListingIndex();
  const unreadable: string[] = [];
  for (const f of files) {
    try {
      if (statSync(f).size > 30 * 1024 * 1024) throw new Error("too large");
      parseLockfile(f, readFileSync(f, "utf8"), idx);
    } catch {
      unreadable.push(f);
    }
  }
  return { deps: [...idx.all.values()], unreadable };
}

export const AtlasAlert = z.object({
  ecosystem: z.enum(["npm", "pypi"]),
  name: z.string(),
  registeredAt: z.string(),
  firstSeen: z.string(),
  models: z.array(z.string()),
  seenCount: z.number(),
});
export type AtlasAlert = z.infer<typeof AtlasAlert>;
const AlertsResponse = z.object({ alerts: z.array(AtlasAlert), generatedAt: z.string() });

/** GET {webUrl}/api/atlas/alerts (docs/API.md). */
export async function fetchAtlasAlerts(webUrl: string, fetchImpl: typeof fetch = fetch): Promise<AtlasAlert[]> {
  const url = new URL("/api/atlas/alerts?limit=500", webUrl);
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "ladon-cli" }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error(`cannot reach ${url.host}`);
  }
  if (!res.ok) throw new Error(`${url.host} answered HTTP ${res.status}`);
  const parsed = AlertsResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error(`${url.host} returned unexpected data`);
  return parsed.data.alerts;
}

export interface AuditFinding {
  ecosystem: Ecosystem;
  name: string;
  versions: string[];
  kind: "atlas" | "malicious";
  detail: string;
}

export interface AuditResult {
  files: string[];
  deps: number;
  findings: AuditFinding[];
  /** sources that could not be checked (the audit is incomplete) */
  errors: string[];
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

export async function audit(cwd: string, src: { alerts: () => Promise<AtlasAlert[]>; osv: OsvSource; concurrency?: number }): Promise<AuditResult> {
  const files = findLockfiles(cwd);
  if (files.length === 0) return { files, deps: 0, findings: [], errors: [] }; // nothing to audit: no network calls, exit 0
  const { deps, unreadable } = lockedDeps(files);
  const errors = unreadable.map((f) => `could not read ${f.split(/[\\/]/).pop()}`);
  const findings: AuditFinding[] = [];

  try {
    const alerts = await src.alerts();
    const byName = new Map(alerts.map((a) => [`${a.ecosystem}:${a.ecosystem === "pypi" ? normalizePypiName(a.name) : a.name}`, a]));
    for (const d of deps) {
      const a = byName.get(`${d.ecosystem}:${d.name}`);
      if (!a) continue;
      const by = a.models.length ? `hallucinated by ${a.models.join(", ")}` : "a known hallucinated name";
      findings.push({ ecosystem: d.ecosystem, name: d.name, versions: d.versions, kind: "atlas", detail: `${by}, registered ${a.registeredAt.slice(0, 10)} after it was first seen ${a.firstSeen.slice(0, 10)} — likely a slopsquat` });
    }
  } catch (e) {
    errors.push(`Atlas alerts: ${e instanceof Error ? e.message : String(e)}`);
  }

  // OSV: one query per locked version (or per name when no version is known); MAL-* only.
  const queries = deps.flatMap((d) => (d.versions.length ? d.versions.slice(0, 5).map((v) => ({ d, v })) : [{ d, v: undefined as string | undefined }]));
  const mal = new Map<string, { d: LockedDep; ids: Set<string>; versions: Set<string> }>();
  let osvFailures = 0;
  await pool(queries, src.concurrency ?? 12, async ({ d, v }) => {
    try {
      const r = await src.osv.query(d.ecosystem, d.name, v);
      if (r.malicious.length === 0) return;
      const k = `${d.ecosystem}:${d.name}`;
      const m = mal.get(k) ?? { d, ids: new Set<string>(), versions: new Set<string>() };
      r.malicious.forEach((id) => m.ids.add(id));
      if (v) m.versions.add(v);
      mal.set(k, m);
    } catch {
      osvFailures++;
    }
  });
  for (const m of mal.values()) findings.push({ ecosystem: m.d.ecosystem, name: m.d.name, versions: [...m.versions], kind: "malicious", detail: `known malicious (OSV ${[...m.ids].sort().join(", ")})` });
  if (osvFailures > 0) errors.push(`OSV: ${osvFailures} of ${queries.length} lookups failed`);

  findings.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "malicious" ? -1 : 1) || a.name.localeCompare(b.name));
  return { files, deps: deps.length, findings, errors };
}
