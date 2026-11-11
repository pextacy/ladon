import semver from "semver";
import { z } from "zod";
import { cached, TTL, type Cache } from "./cache.js";
import { fetchBytes, fetchJson, type HttpOptions } from "./http.js";

const Person = z.union([z.string(), z.object({ name: z.string().optional(), email: z.string().optional() })]);
const Repository = z.union([z.string(), z.object({ url: z.string().optional(), directory: z.string().optional() })]);

const RawVersion = z.object({
  version: z.string(),
  description: z.string().optional().catch(undefined),
  scripts: z.record(z.string(), z.unknown()).optional().catch(undefined),
  maintainers: z.array(Person).optional().catch(undefined),
  _npmUser: Person.optional().catch(undefined),
  repository: Repository.optional().catch(undefined),
  gypfile: z.boolean().optional().catch(undefined),
  deprecated: z.union([z.string(), z.boolean()]).optional().catch(undefined),
  dist: z
    .object({
      tarball: z.string().optional(),
      integrity: z.string().optional(),
      shasum: z.string().optional(),
      unpackedSize: z.number().optional(),
      attestations: z.unknown().optional(),
    })
    .optional()
    .catch(undefined),
});

const RawPackument = z.object({
  name: z.string(),
  "dist-tags": z.record(z.string(), z.string()).optional().catch({}),
  time: z.record(z.string(), z.string()).optional().catch({}),
  versions: z.record(z.string(), z.unknown()).optional().catch({}),
  readme: z.string().optional().catch(undefined),
  repository: Repository.optional().catch(undefined),
  maintainers: z.array(Person).optional().catch(undefined),
});

export interface NpmVersionInfo {
  version: string;
  time?: string;
  description?: string;
  maintainers: string[];
  publisher?: string;
  provenance: boolean;
  scripts: Record<string, string>;
  gypfile: boolean;
  tarball?: string;
  integrity?: string;
  /** legacy sha1 hex digest (old packages have no `integrity`) */
  shasum?: string;
  unpackedSize?: number;
  repositoryUrl?: string;
  repositoryDirectory?: string;
  deprecated?: string;
}

export interface NpmPackageInfo {
  name: string;
  created?: string;
  distTags: Record<string, string>;
  versions: Record<string, NpmVersionInfo>;
  readmeExcerpt?: string;
}

const personName = (p: z.infer<typeof Person> | undefined): string | undefined =>
  p === undefined ? undefined : typeof p === "string" ? p.replace(/\s*<.*$/, "").trim() : p.name;

const repoOf = (r: z.infer<typeof Repository> | undefined): { url?: string; directory?: string } =>
  r === undefined ? {} : typeof r === "string" ? { url: r } : { ...(r.url ? { url: r.url } : {}), ...(r.directory ? { directory: r.directory } : {}) };

export function compactPackument(raw: unknown): NpmPackageInfo | null {
  const p = RawPackument.safeParse(raw);
  if (!p.success) return null;
  const pk = p.data;
  const versions: Record<string, NpmVersionInfo> = {};
  for (const [v, rv] of Object.entries(pk.versions ?? {})) {
    const parsed = RawVersion.safeParse(rv);
    if (!parsed.success) continue;
    const d = parsed.data;
    const scripts: Record<string, string> = {};
    for (const [k, val] of Object.entries(d.scripts ?? {})) if (typeof val === "string") scripts[k] = val;
    const repo = repoOf(d.repository ?? pk.repository);
    const info: NpmVersionInfo = {
      version: v,
      maintainers: (d.maintainers ?? []).map(personName).filter((x): x is string => !!x).sort(),
      provenance: d.dist?.attestations !== undefined && d.dist.attestations !== null,
      scripts,
      gypfile: d.gypfile === true,
    };
    const t = pk.time?.[v];
    if (t) info.time = t;
    if (d.description) info.description = d.description.slice(0, 300);
    const pub = personName(d._npmUser);
    if (pub) info.publisher = pub;
    if (d.dist?.tarball) info.tarball = d.dist.tarball;
    if (d.dist?.integrity) info.integrity = d.dist.integrity;
    if (d.dist?.shasum && /^[0-9a-f]{40}$/i.test(d.dist.shasum)) info.shasum = d.dist.shasum.toLowerCase();
    if (d.dist?.unpackedSize !== undefined) info.unpackedSize = d.dist.unpackedSize;
    if (repo.url) info.repositoryUrl = repo.url;
    if (repo.directory) info.repositoryDirectory = repo.directory;
    if (d.deprecated) info.deprecated = typeof d.deprecated === "string" ? d.deprecated : "deprecated";
    versions[v] = info;
  }
  const out: NpmPackageInfo = { name: pk.name, distTags: pk["dist-tags"] ?? {}, versions };
  const created = pk.time?.created ?? earliest(Object.values(versions).map((v) => v.time));
  if (created) out.created = created;
  if (pk.readme) out.readmeExcerpt = pk.readme.replace(/\s+/g, " ").slice(0, 400);
  return out;
}

function earliest(times: (string | undefined)[]): string | undefined {
  return times.filter((t): t is string => !!t).sort()[0];
}

/** Resolve a version spec against the packument: exact, dist-tag, or highest satisfying range. */
export function resolveNpmVersion(info: NpmPackageInfo, spec: string | undefined): string | undefined {
  const all = Object.keys(info.versions);
  if (!spec || spec === "" || spec === "*") return info.distTags.latest ?? semver.maxSatisfying(all, "*") ?? undefined;
  if (info.versions[spec]) return spec;
  const tag = info.distTags[spec];
  if (tag) return tag;
  const latest = info.distTags.latest;
  if (latest && semver.validRange(spec) && semver.satisfies(latest, spec)) return latest;
  return semver.maxSatisfying(all, spec) ?? undefined;
}

/** The version published immediately before `version` (by publish time). */
export function previousNpmVersion(info: NpmPackageInfo, version: string): NpmVersionInfo | undefined {
  const cur = info.versions[version];
  if (!cur?.time) return undefined;
  return Object.values(info.versions)
    .filter((v) => v.time && v.time < cur.time! && v.version !== version)
    .sort((a, b) => (a.time! < b.time! ? 1 : -1))[0];
}

/** What the registry publishes as this version's integrity, as SRI tokens (dist.integrity + shasum). */
export function npmRegistryIntegrity(v: NpmVersionInfo | undefined): string[] {
  if (!v) return [];
  const out = v.integrity ? v.integrity.trim().split(/\s+/) : [];
  if (v.shasum) out.push(`sha1-${Buffer.from(v.shasum, "hex").toString("base64")}`);
  return out;
}

export interface NpmSource {
  packument(name: string): Promise<NpmPackageInfo | null>;
  weeklyDownloads(name: string): Promise<number | null>;
  tarball(url: string, maxBytes: number): Promise<Uint8Array | null>;
}

export interface NpmSourceOptions extends HttpOptions {
  registry?: string;
  downloadsApi?: string;
  cache?: Cache;
}

export function npmSource(opts: NpmSourceOptions = {}): NpmSource {
  const registry = (opts.registry ?? "https://registry.npmjs.org/").replace(/\/?$/, "/");
  const downloadsApi = (opts.downloadsApi ?? "https://api.npmjs.org/").replace(/\/?$/, "/");
  const isPublic = /^https:\/\/registry\.npmjs\.org\/$/.test(registry);
  const enc = (name: string) => name.replace("/", "%2f");
  return {
    packument: (name) =>
      cached(opts.cache, `npm:pk:${registry}:${name}`, TTL.metadata, async () => {
        const raw = await fetchJson("npm registry", `${registry}${enc(name)}`, z.unknown(), opts);
        return raw === null ? null : compactPackument(raw);
      }),
    weeklyDownloads: (name) =>
      cached(opts.cache, `npm:dl:${name}`, TTL.downloads, async () => {
        // Packages that only exist on a private/local registry have no public download counts.
        const r = await fetchJson(
          "npm downloads",
          `${downloadsApi}downloads/point/last-week/${name}`,
          z.object({ downloads: z.number() }),
          opts,
        ).catch((e: unknown) => {
          if (!isPublic) return null;
          throw e;
        });
        return r === null ? 0 : r.downloads;
      }),
    tarball: (url) => fetchBytes("npm tarball", url, 8 * 1024 * 1024, opts),
  };
}
