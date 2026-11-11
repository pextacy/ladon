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
});

const Raw = z.object({
  info: z.object({
    name: z.string(),
    version: z.string(),
    summary: z.string().nullish().catch(null),
    description: z.string().nullish().catch(null),
    author: z.string().nullish().catch(null),
    maintainer: z.string().nullish().catch(null),
    home_page: z.string().nullish().catch(null),
    project_urls: z.record(z.string(), z.string()).nullish().catch(null),
  }),
  releases: z.record(z.string(), z.array(File)).optional().catch({}),
  urls: z.array(File).optional().catch([]),
});

export interface PypiReleaseInfo {
  version: string;
  time?: string;
  hasWheel: boolean;
  sdistUrl?: string;
}

export interface PypiPackageInfo {
  name: string;
  latest: string;
  summary?: string;
  readmeExcerpt?: string;
  author?: string;
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
    const rel: PypiReleaseInfo = { version: v, hasWheel: live.some((f) => f.packagetype === "bdist_wheel") };
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
}

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
      cached(opts.cache, `pypi:pj:${index}:${normalizePypiName(name)}`, TTL.metadata, async () => {
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
  };
}
