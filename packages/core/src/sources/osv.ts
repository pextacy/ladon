import { z } from "zod";
import type { Ecosystem } from "../schemas.js";
import { cached, TTL, type Cache } from "./cache.js";
import { fetchJson, type HttpOptions } from "./http.js";

const Resp = z.object({
  vulns: z.array(z.object({ id: z.string(), aliases: z.array(z.string()).optional().catch([]) })).optional().catch([]),
});

export interface OsvResult {
  /** OSV `MAL-*` advisories (OpenSSF malicious-packages) */
  malicious: string[];
  vulns: string[];
}

export interface OsvSource {
  query(ecosystem: Ecosystem, name: string, version?: string): Promise<OsvResult>;
}

export function osvSource(opts: HttpOptions & { api?: string; cache?: Cache } = {}): OsvSource {
  const api = (opts.api ?? "https://api.osv.dev/").replace(/\/?$/, "/");
  return {
    query: (ecosystem, name, version) =>
      cached(opts.cache, `osv:${ecosystem}:${name}:${version ?? ""}`, TTL.osv, async () => {
        const body = { package: { name, ecosystem: ecosystem === "npm" ? "npm" : "PyPI" }, ...(version ? { version } : {}) };
        const r = await fetchJson("OSV", `${api}v1/query`, Resp, {
          ...opts,
          init: { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
        });
        const vulns = r?.vulns ?? [];
        const ids = vulns.flatMap((v) => [v.id, ...(v.aliases ?? [])]);
        return {
          malicious: [...new Set(ids.filter((id) => id.startsWith("MAL-")))],
          vulns: [...new Set(vulns.map((v) => v.id).filter((id) => !id.startsWith("MAL-")))],
        };
      }),
  };
}
