import atlasSeed from "../data/atlas-seed.json" with { type: "json" };
import { z } from "zod";
import type { AtlasEvidence } from "../evidence.js";
import { normalizePypiName } from "../parse/command.js";
import type { Ecosystem } from "../schemas.js";
import { cached, TTL, type Cache } from "./cache.js";
import { fetchJson, type HttpOptions } from "./http.js";

export const AtlasEntry = z.object({
  ecosystem: z.enum(["npm", "pypi"]),
  name: z.string(),
  models: z.array(z.string()).default([]),
  seenCount: z.number().int().nonnegative().default(1),
  registeredAt: z.string().nullable().optional(),
  source: z.string().optional(),
});
export type AtlasEntry = z.infer<typeof AtlasEntry>;

const LookupResp = z.object({ found: z.boolean(), entry: AtlasEntry.optional() });

export interface AtlasSource {
  lookup(ecosystem: Ecosystem, name: string): Promise<AtlasEvidence | null>;
}

const key = (eco: Ecosystem, name: string) => `${eco}:${eco === "pypi" ? normalizePypiName(name) : name}`;

function toEvidence(e: AtlasEntry): AtlasEvidence {
  const ev: AtlasEvidence = { hallucinated: true, models: e.models, seenCount: e.seenCount, registeredAt: e.registeredAt ?? null };
  if (e.source) ev.source = e.source;
  return ev;
}

let seedIndex: Map<string, AtlasEntry> | undefined;
export function seedAtlas(): Map<string, AtlasEntry> {
  if (!seedIndex) {
    const raw = atlasSeed as { entries: unknown[] };
    seedIndex = new Map(raw.entries.map((x) => AtlasEntry.parse(x)).map((e) => [key(e.ecosystem, e.name), e]));
  }
  return seedIndex;
}

/** Offline atlas from a fixed list (seed data or tests). */
export function staticAtlas(entries: Iterable<AtlasEntry>): AtlasSource {
  const idx = new Map([...entries].map((e) => [key(e.ecosystem, e.name), e]));
  return { lookup: async (eco, name) => (idx.has(key(eco, name)) ? toEvidence(idx.get(key(eco, name))!) : null) };
}

/** Live Atlas (apps/web /api/atlas/lookup) with the curated seed as fallback and fill-in. */
export function atlasSource(opts: HttpOptions & { baseUrl: string; cache?: Cache }): AtlasSource {
  const base = opts.baseUrl.replace(/\/?$/, "/");
  const seed = staticAtlas(seedAtlas().values());
  return {
    lookup: (eco, name) =>
      cached(opts.cache, `atlas:${key(eco, name)}`, TTL.atlas, async () => {
        const url = `${base}api/atlas/lookup?eco=${eco}&name=${encodeURIComponent(name)}`;
        const live = await fetchJson("Atlas", url, LookupResp, { ...opts, timeoutMs: opts.timeoutMs ?? 2500 }).catch(() => null);
        if (live?.found && live.entry) return toEvidence(live.entry);
        return seed.lookup(eco, name);
      }),
  };
}
