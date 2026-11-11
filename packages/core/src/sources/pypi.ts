import { z } from "zod";
import { normalizePypiName } from "../parse/command.js";
import { maxSatisfyingPep440, parsePep440Specifier } from "../parse/pep440.js";
import { cached, TTL, type Cache } from "./cache.js";
import { fetchBytes, fetchJson, type HttpOptions } from "./http.js";

const File = z.object({
  filename: z.string(),
  packagetype: z.string(),
  upload_time_iso_8601: z.string().optional().catch(undefined),
  url: z.string(),
  yanked: z.boolean().optional().catch(false),
  digests: z.object({ sha256: z.string().optional() }).optional().catch(undefined),
});

const Info = z.object({
  name: z.string(),
  version: z.string(),
  summary: z.string().nullish().catch(null),
  description: z.string().nullish().catch(null),
  author: z.string().nullish().catch(null),
  author_email: z.string().nullish().catch(null),
  maintainer: z.string().nullish().catch(null),
  maintainer_email: z.string().nullish().catch(null),
  home_page: z.string().nullish().catch(null),
  project_urls: z.record(z.string(), z.string()).nullish().catch(null),
});

const Raw = z.object({
  info: Info,
  releases: z.record(z.string(), z.array(File)).optional().catch({}),
  urls: z.array(File).optional().catch([]),
});

export interface PypiFileInfo {
  filename: string;
  packagetype: string;
  sha256?: string;
}

export interface PypiReleaseInfo {
  version: string;
  time?: string;
  hasWheel: boolean;
  sdistUrl?: string;
  /** non-yanked distribution files (for lockfile hash checks and PEP 740 provenance) */
  files?: PypiFileInfo[];
}

/** Per-version metadata from /pypi/<name>/<version>/json. */
export interface PypiVersionMeta {
  version: string;
  /** author/maintainer identities: e-mail addresses when given, else names (lowercased) */
  people: string[];
}

/** PEP 740 provenance of one distribution file. */
export interface PypiProvenance {
  /** Trusted Publisher identity, e.g. "GitHub:pypa/sampleproject" */
  publisher?: string;
}

export interface PypiPackageInfo {
  name: string;
  latest: string;
  summary?: string;
  readmeExcerpt?: string;
  author?: string;
  /** identities (see PypiVersionMeta.people) of the latest version */
  people?: string[];
  repositoryUrl?: string;
  created?: string;
  releases: Record<string, PypiReleaseInfo>;
}

export function compactPypi(raw: unknown): PypiPackageInfo | null {
  const p = Raw.safeParse(raw);
  if (!p.success) return null;
  const { info, releases } = p.data;
  const out: PypiPackageInfo = { name: info.name, latest: info.version, releases: {} };
  for (const [v, files] of Object.entries(releases ?? {})) {
    const live = files.filter((f) => !f.yanked);
    if (live.length === 0) continue;
    const times = live.map((f) => f.upload_time_iso_8601).filter((t): t is string => !!t).sort();
    const sdist = live.find((f) => f.packagetype === "sdist" && /\.tar\.gz$/.test(f.filename));
    const rel: PypiReleaseInfo = {
      version: v,
      hasWheel: live.some((f) => f.packagetype === "bdist_wheel"),
      files: live.map((f) => ({ filename: f.filename, packagetype: f.packagetype, ...(f.digests?.sha256 ? { sha256: f.digests.sha256.toLowerCase() } : {}) })),
    };
    if (times[0]) rel.time = times[0];
    if (sdist) rel.sdistUrl = sdist.url;
    out.releases[v] = rel;
  }
  const created = Object.values(out.releases).map((r) => r.time).filter((t): t is string => !!t).sort()[0];
  if (created) out.created = created;
  if (info.summary) out.summary = info.summary.slice(0, 300);
  if (info.description) out.readmeExcerpt = info.description.replace(/\s+/g, " ").slice(0, 400);
  const author = info.maintainer || info.author;
  if (author) out.author = author;
  out.people = pypiPeople(info);
  const urls = info.project_urls ?? {};
  const repo =
    Object.entries(urls).find(([k, u]) => /source|repo|code|github/i.test(k) || /github\.com|gitlab\.com/.test(u))?.[1] ??
    (info.home_page && /github\.com|gitlab\.com/.test(info.home_page) ? info.home_page : undefined);
  if (repo) out.repositoryUrl = repo;
  return out;
}

/**
 * Resolve a PEP 440 specifier the way pip does: highest matching non-yanked release, pre-releases
 * only when the spec names one. Returns undefined when nothing matches; an unparseable spec (e.g.
 * a Poetry caret range) falls back to the latest release.
 */
/**
 * Who a version's metadata names as author/maintainer. PyPI's JSON API has no per-file uploader, so
 * this is what R07 compares across versions. E-mails are the stable identity; names only count
 * when no e-mail is given at all (names are reformatted far more often than addresses change).
 */
export function pypiPeople(info: { author?: string | null | undefined; author_email?: string | null | undefined; maintainer?: string | null | undefined; maintainer_email?: string | null | undefined }): string[] {
  const emails = new Set<string>();
  const names = new Set<string>();
  for (const field of [info.author_email, info.maintainer_email, info.author, info.maintainer]) {
    for (const part of (field ?? "").split(/,(?![^<]*>)/)) {
      const p = part.trim();
      if (!p) continue;
      const email = /<([^>]+@[^>]+)>/.exec(p)?.[1] ?? (/^[^\s<>]+@[^\s<>]+$/.test(p) ? p : undefined);
      if (email) emails.add(email.trim().toLowerCase());
      else names.add(p.replace(/\s+/g, " ").replace(/^"|"$/g, "").toLowerCase());
    }
  }
  return [...(emails.size > 0 ? emails : names)].sort();
}

/** The release uploaded immediately before `version` (by upload time). */
export function previousPypiVersion(info: PypiPackageInfo, version: string): PypiReleaseInfo | undefined {
  const cur = info.releases[version];
  if (!cur?.time) return undefined;
  return Object.values(info.releases)
    .filter((r) => r.time && r.time < cur.time! && r.version !== version)
    .sort((a, b) => (a.time! < b.time! ? 1 : -1))[0];
}

/** Which file of a release to compare provenance on: the sdist, else the first wheel (stable choice). */
export function provenanceFile(rel: PypiReleaseInfo | undefined, prefer?: string): PypiFileInfo | undefined {
  const files = [...(rel?.files ?? [])].sort((a, b) => (a.filename < b.filename ? -1 : 1));
  const of = (t: string) => files.find((f) => f.packagetype === t);
  return (prefer ? of(prefer) : undefined) ?? of("sdist") ?? of("bdist_wheel") ?? files[0];
}

export function resolvePypiVersion(info: PypiPackageInfo, spec: string | undefined): string | undefined {
  if (!spec || spec.trim() === "" || spec.trim() === "*") return info.latest;
  if (info.releases[spec]) return spec;
  if (!parsePep440Specifier(spec)) return info.latest;
  return maxSatisfyingPep440(Object.keys(info.releases), spec);
}

export interface PypiSource {
  project(name: string): Promise<PypiPackageInfo | null>;
  weeklyDownloads(name: string): Promise<number | null>;
  sdist(url: string, maxBytes: number): Promise<Uint8Array | null>;
  /** metadata of one version (R07); optional so simple fakes keep working */
  release?(name: string, version: string): Promise<PypiVersionMeta | null>;
  /** PEP 740 provenance of one file; null = none published (R14) */
  provenance?(name: string, version: string, filename: string): Promise<PypiProvenance | null>;
}

const Provenance = z.object({
  attestation_bundles: z
    .array(
      z.object({
        publisher: z.object({ kind: z.string().optional(), repository: z.string().optional() }).passthrough().optional().catch(undefined),
      }),
    )
    .optional()
    .catch([]),
});

export interface PypiSourceOptions extends HttpOptions {
  index?: string;
  statsApi?: string;
  cache?: Cache;
}

export function pypiSource(opts: PypiSourceOptions = {}): PypiSource {
  const index = (opts.index ?? "https://pypi.org/").replace(/\/?$/, "/");
  const stats = (opts.statsApi ?? "https://pypistats.org/").replace(/\/?$/, "/");
  return {
    project: (name) =>
      cached(opts.cache, `pypi:pj2:${index}:${normalizePypiName(name)}`, TTL.metadata, async () => {
        const raw = await fetchJson("PyPI", `${index}pypi/${normalizePypiName(name)}/json`, z.unknown(), opts);
        return raw === null ? null : compactPypi(raw);
      }),
    weeklyDownloads: (name) =>
      cached(opts.cache, `pypi:dl:${normalizePypiName(name)}`, TTL.downloads, async () => {
        const r = await fetchJson(
          "pypistats",
          `${stats}api/packages/${normalizePypiName(name)}/recent`,
          z.object({ data: z.object({ last_week: z.number() }) }),
          { ...opts, timeoutMs: opts.timeoutMs ?? 2000 },
        );
        return r === null ? 0 : r.data.last_week;
      }),
    sdist: (url, maxBytes) => fetchBytes("PyPI sdist", url, maxBytes, opts),
    release: (name, version) =>
      cached(opts.cache, `pypi:rel:${index}:${normalizePypiName(name)}@${version}`, TTL.metadata, async () => {
        const raw = await fetchJson("PyPI", `${index}pypi/${normalizePypiName(name)}/${encodeURIComponent(version)}/json`, z.object({ info: Info }), opts);
        return raw === null ? null : { version, people: pypiPeople(raw.info) };
      }),
    provenance: (name, version, filename) =>
      // a published file's provenance never changes
      cached(opts.cache, `pypi:prov:${index}:${normalizePypiName(name)}@${version}/${filename}`, TTL.analysis, async () => {
        const raw = await fetchJson(
          "PyPI integrity",
          `${index}integrity/${normalizePypiName(name)}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}/provenance`,
          Provenance,
          { ...opts, timeoutMs: opts.timeoutMs ?? 3000, init: { headers: { accept: "application/vnd.pypi.integrity.v1+json" } } },
        );
        if (raw === null) return null;
        const pub = raw.attestation_bundles?.find((b) => b.publisher)?.publisher;
        return pub?.kind ? { publisher: pub.repository ? `${pub.kind}:${pub.repository}` : pub.kind } : {};
      }),
  };
}
