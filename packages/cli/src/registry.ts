import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ParsedInstall } from "@ladon/core";

function npmrcRegistry(path: string): string | undefined {
  try {
    const m = /^\s*registry\s*=\s*(\S+)/m.exec(readFileSync(path, "utf8"));
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** Which npm registry this install will really hit: flag > env > project .npmrc (walking up) > ~/.npmrc > default. */
export function npmRegistryFor(p: ParsedInstall, cwd: string, env = process.env): string | undefined {
  if (p.registry) return p.registry;
  const fromEnv = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (fromEnv) return fromEnv;
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const r = npmrcRegistry(join(dir, ".npmrc"));
    if (r) return r;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return npmrcRegistry(join(homedir(), ".npmrc"));
}

export function pypiIndexFor(p: ParsedInstall, env = process.env): string | undefined {
  const idx = p.registry ?? env.PIP_INDEX_URL ?? env.UV_INDEX_URL ?? env.UV_DEFAULT_INDEX;
  if (!idx) return undefined;
  // PEP 503 simple index URL → JSON API base (works for pypi.org mirrors that expose /pypi/<name>/json)
  return idx.replace(/\/simple\/?$/, "/");
}

export function isDefaultNpm(r: string | undefined): boolean {
  return !r || /^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\/?$/.test(r);
}
