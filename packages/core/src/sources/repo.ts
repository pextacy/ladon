import { z } from "zod";
import { cached, TTL, type Cache } from "./cache.js";
import { fetchText, type HttpOptions } from "./http.js";

export interface RepoSource {
  /** Does the linked repository's manifest declare this package name? null = could not check. */
  referencesPackage(repoUrl: string, directory: string | undefined, name: string, ecosystem: "npm" | "pypi"): Promise<{ referencesPackage: boolean | null; note?: string }>;
}

export type RepoHost = "github" | "gitlab" | "codeberg" | "bitbucket";

export interface RepoRef {
  host: RepoHost;
  /** owner / workspace; for GitLab the full (possibly nested) group path */
  owner: string;
  repo: string;
}

const TAIL = String.raw`(?:\.git)?\/?(?:[#?].*)?$`;

/** owner/repo on GitHub, GitLab, Codeberg or Bitbucket from the many shapes npm/PyPI repository fields take. */
export function parseRepoUrl(url: string): RepoRef | null {
  const u = url.trim().replace(/^(github|gitlab|bitbucket):/, (_, h: string) => `https://${h === "bitbucket" ? "bitbucket.org" : `${h}.com`}/`);
  const gitlab = new RegExp(String.raw`gitlab\.com[/:]((?:[^/\s#?]+\/)+?)([^/\s#?]+?)(?:\/-\/.*)?${TAIL}`, "i").exec(u);
  if (gitlab) return { host: "gitlab", owner: gitlab[1]!.replace(/\/$/, ""), repo: gitlab[2]!.replace(/\.git$/, "") };
  for (const [host, domain] of [
    ["github", String.raw`github\.com`],
    ["codeberg", String.raw`codeberg\.org`],
    ["bitbucket", String.raw`bitbucket\.org`],
  ] as const) {
    const m = new RegExp(String.raw`${domain}[/:]([^/\s#?]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$`, "i").exec(u);
    if (m) return { host, owner: m[1]!, repo: m[2]! };
  }
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(u);
  return short ? { host: "github", owner: short[1]!, repo: short[2]! } : null;
}

/** github.com/owner/repo (kept for callers that only care about GitHub). */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const r = parseRepoUrl(url);
  return r && r.host === "github" ? { owner: r.owner, repo: r.repo } : null;
}

export interface RepoSourceOptions extends HttpOptions {
  cache?: Cache;
  /** raw.githubusercontent.com base (tests / mirrors) */
  rawBase?: string;
}

/** Public raw-file URL of `path` on the default branch. */
export function rawFileUrl(ref: RepoRef, path: string, rawBase = "https://raw.githubusercontent.com/"): string {
  const p = path.split("/").map(encodeURIComponent).join("/");
  switch (ref.host) {
    case "github":
      return `${rawBase.replace(/\/?$/, "/")}${ref.owner}/${ref.repo}/HEAD/${p}`;
    case "gitlab":
      return `https://gitlab.com/${ref.owner}/${ref.repo}/-/raw/HEAD/${p}`;
    case "codeberg":
      // Forgejo/Gitea API: ref omitted → default branch
      return `https://codeberg.org/api/v1/repos/${ref.owner}/${ref.repo}/raw/${p}`;
    case "bitbucket":
      return `https://bitbucket.org/${ref.owner}/${ref.repo}/raw/HEAD/${p}`;
  }
}

const HOST_LABEL: Record<RepoHost, string> = { github: "GitHub", gitlab: "GitLab", codeberg: "Codeberg", bitbucket: "Bitbucket" };
const PackageJsonName = z.object({ name: z.string().optional() });

/** R13 source: reads the linked repository's manifest over public raw-file URLs (no API tokens). */
export function repoSource(opts: RepoSourceOptions = {}): RepoSource {
  const http = { ...opts, timeoutMs: opts.timeoutMs ?? 3000 };
  return {
    referencesPackage: (repoUrl, directory, name, ecosystem) =>
      cached(opts.cache, `repo:${repoUrl}:${directory ?? ""}:${name}`, TTL.metadata, async () => {
        const ref = parseRepoUrl(repoUrl);
        if (!ref) return { referencesPackage: null, note: "repository is not on GitHub, GitLab, Codeberg or Bitbucket; not verified" };
        const label = `${ref.owner}/${ref.repo}`;
        const dir = directory ? directory.replace(/^\.?\/*/, "").replace(/\/*$/, "/") : "";
        const read = (file: string) => fetchText(HOST_LABEL[ref.host], rawFileUrl(ref, `${dir}${file}`, opts.rawBase), http);
        if (ecosystem === "npm") {
          const text = await read("package.json").catch(() => undefined);
          if (text === undefined) return { referencesPackage: null, note: "could not read repository" };
          // monorepos often keep packages in subfolders without saying so — not evidence either way
          if (text === null) return dir ? { referencesPackage: false, note: `${label} has no package.json in ${dir}` } : { referencesPackage: null, note: "no package.json at repository root" };
          let pj: z.infer<typeof PackageJsonName>;
          try {
            const parsed = PackageJsonName.safeParse(JSON.parse(text));
            if (!parsed.success) return { referencesPackage: null, note: "repository package.json is not valid" };
            pj = parsed.data;
          } catch {
            return { referencesPackage: null, note: "repository package.json is not valid JSON" };
          }
          return pj.name === name ? { referencesPackage: true } : { referencesPackage: false, note: `${label} declares "${pj.name ?? "no name"}", not "${name}"` };
        }
        // PyPI: accept pyproject.toml or setup.py/cfg mentioning the name
        for (const file of ["pyproject.toml", "setup.cfg", "setup.py"]) {
          const text = await read(file).catch(() => undefined);
          if (text === undefined) return { referencesPackage: null, note: "could not read repository" };
          if (text === null) continue;
          const n = name.toLowerCase().replace(/[-_.]+/g, "[-_.]");
          return new RegExp(`["']${n}["']|name\\s*=\\s*${n}\\b`).test(text.toLowerCase())
            ? { referencesPackage: true }
            : { referencesPackage: false, note: `${label} ${file} does not name "${name}"` };
        }
        return { referencesPackage: null, note: `${label} has no Python project files at the root` };
      }),
  };
}

/** Backward-compatible name: now covers GitHub, GitLab, Codeberg and Bitbucket. */
export const githubRepoSource = repoSource;
