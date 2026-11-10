import { z } from "zod";
import { cached, TTL, type Cache } from "./cache.js";
import { fetchJson, type HttpOptions } from "./http.js";

export interface RepoSource {
  /** Does the linked repository's manifest declare this package name? null = could not check. */
  referencesPackage(repoUrl: string, directory: string | undefined, name: string, ecosystem: "npm" | "pypi"): Promise<{ referencesPackage: boolean | null; note?: string }>;
}

/** github.com/owner/repo from the many shapes npm/PyPI repository fields take. */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/\s#]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url.replace(/^github:/, "https://github.com/"));
  if (!m) {
    const short = /^([\w.-]+)\/([\w.-]+)$/.exec(url);
    return short ? { owner: short[1]!, repo: short[2]! } : null;
  }
  return { owner: m[1]!, repo: m[2]! };
}

export function githubRepoSource(opts: HttpOptions & { cache?: Cache; rawBase?: string } = {}): RepoSource {
  const raw = (opts.rawBase ?? "https://raw.githubusercontent.com/").replace(/\/?$/, "/");
  return {
    referencesPackage: (repoUrl, directory, name, ecosystem) =>
      cached(opts.cache, `repo:${repoUrl}:${directory ?? ""}:${name}`, TTL.metadata, async () => {
        const gh = parseGithubRepo(repoUrl);
        if (!gh) return { referencesPackage: null, note: "repository is not on GitHub; not verified" };
        const dir = directory ? directory.replace(/^\.?\/*/, "").replace(/\/*$/, "/") : "";
        if (ecosystem === "npm") {
          const pj = await fetchJson("GitHub", `${raw}${gh.owner}/${gh.repo}/HEAD/${dir}package.json`, z.object({ name: z.string().optional() }), {
            ...opts,
            timeoutMs: opts.timeoutMs ?? 3000,
          }).catch(() => undefined);
          if (pj === undefined) return { referencesPackage: null, note: "could not read repository" };
          // monorepos often keep packages in subfolders without saying so — not evidence either way
          if (pj === null) return dir ? { referencesPackage: false, note: `${gh.owner}/${gh.repo} has no package.json in ${dir}` } : { referencesPackage: null, note: "no package.json at repository root" };
          return pj.name === name
            ? { referencesPackage: true }
            : { referencesPackage: false, note: `${gh.owner}/${gh.repo} declares "${pj.name ?? "no name"}", not "${name}"` };
        }
        // PyPI: accept pyproject.toml or setup.py/cfg mentioning the name
        for (const file of ["pyproject.toml", "setup.cfg", "setup.py"]) {
          const res = await (opts.fetch ?? fetch)(`${raw}${gh.owner}/${gh.repo}/HEAD/${dir}${file}`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
          if (!res) return { referencesPackage: null, note: "could not read repository" };
          if (!res.ok) continue;
          const text = (await res.text()).toLowerCase();
          const n = name.toLowerCase().replace(/[-_.]+/g, "[-_.]");
          return new RegExp(`["']${n}["']|name\\s*=\\s*${n}\\b`).test(text)
            ? { referencesPackage: true }
            : { referencesPackage: false, note: `${gh.owner}/${gh.repo} ${file} does not name "${name}"` };
        }
        return { referencesPackage: null, note: `${gh.owner}/${gh.repo} has no Python project files at the root` };
      }),
  };
}
