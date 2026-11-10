import type { CheckDeps } from "./check.js";
import { atlasSource } from "./sources/atlas.js";
import { FileCache, MemoryCache, type Cache } from "./sources/cache.js";
import type { FetchLike } from "./sources/http.js";
import { npmSource } from "./sources/npm.js";
import { osvSource } from "./sources/osv.js";
import { pypiSource } from "./sources/pypi.js";
import { githubRepoSource } from "./sources/repo.js";

export const DEFAULT_ATLAS_URL = "https://ladon-one.vercel.app/";

export interface DepsConfig {
  /** directory for the persistent cache; omit for in-memory */
  cacheDir?: string;
  cache?: Cache;
  npmRegistry?: string;
  pypiIndex?: string;
  /** Hallucination Atlas base URL; "" disables the live Atlas (seed only) */
  atlasUrl?: string;
  fetch?: FetchLike;
  repoCheck?: boolean;
}

/** Wire the real data sources (all network I/O lives in core/sources). */
export function createDeps(cfg: DepsConfig = {}): CheckDeps {
  const cache = cfg.cache ?? (cfg.cacheDir ? new FileCache(cfg.cacheDir) : new MemoryCache());
  const http = cfg.fetch ? { fetch: cfg.fetch } : {};
  const deps: CheckDeps = {
    npm: npmSource({ ...http, cache, ...(cfg.npmRegistry ? { registry: cfg.npmRegistry } : {}) }),
    pypi: pypiSource({ ...http, cache, ...(cfg.pypiIndex ? { index: cfg.pypiIndex } : {}) }),
    osv: osvSource({ ...http, cache }),
    atlas: atlasSource({ ...http, cache, baseUrl: cfg.atlasUrl === undefined ? DEFAULT_ATLAS_URL : cfg.atlasUrl || "http://127.0.0.1:9/" }),
    cache,
  };
  if (cfg.repoCheck !== false) deps.repo = githubRepoSource({ ...http, cache });
  return deps;
}
