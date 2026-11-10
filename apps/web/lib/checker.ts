import {
  checkMany,
  checkPackage,
  combineVerdicts,
  countedHits,
  createDeps,
  explainDeterministic,
  normalizePypiName,
  pkgLabel,
  seedAtlas,
  staticAtlas,
  type AtlasSource,
  type CheckDeps,
  type Ecosystem,
  type Evidence,
  type Hit,
  type InstallTarget,
  type Report,
  type Verdict,
} from "@ladon/core";
import { aiEnabled, anthropicProvider } from "@ladon/core/ai";
import { getStore, type AtlasNameRecord, type Store } from "./store";

/** Atlas names are stored PEP 503-normalized for PyPI, as-is for npm. */
export const atlasName = (eco: Ecosystem, name: string) => (eco === "pypi" ? normalizePypiName(name) : name.trim());

export function atlasEntryView(e: AtlasNameRecord) {
  return { ecosystem: e.ecosystem, name: e.name, models: e.models, seenCount: e.seenCount, registeredAt: e.registeredAt, ...(e.source ? { source: e.source } : {}) };
}

/** Atlas lookups read our own store first, then the curated seed shipped with core. */
export function storeAtlasSource(store: Store): AtlasSource {
  const seed = staticAtlas(seedAtlas().values());
  return {
    async lookup(eco, name) {
      const e = await store.getAtlasName(eco, atlasName(eco, name));
      if (e) {
        const v = atlasEntryView(e);
        return { hallucinated: true, models: v.models, seenCount: v.seenCount, registeredAt: v.registeredAt, ...(v.source ? { source: v.source } : {}) };
      }
      return seed.lookup(eco, name);
    },
  };
}

const g = globalThis as unknown as { __ladonDeps?: CheckDeps };
export function getDeps(): CheckDeps {
  if (!g.__ladonDeps) {
    const deps = createDeps({ atlasUrl: "" });
    deps.atlas = storeAtlasSource(getStore());
    g.__ladonDeps = deps;
  }
  return g.__ladonDeps;
}

export interface ApiHit {
  id: string;
  name: string;
  weight: number;
  override: boolean;
  detail: string;
  discounted?: boolean;
}

export interface CheckResult {
  target: InstallTarget;
  version: string | null;
  verdict: Verdict;
  score: number;
  hits: ApiHit[];
  explanation: string;
  explanationSource: "ai" | "rules";
  evidenceSummary: ReturnType<typeof evidenceSummary>;
  durationMs: number;
  cached?: boolean;
}

/** Small, stable digest of the evidence for UIs (the full evidence stays server-side). */
export function evidenceSummary(ev: Evidence) {
  return {
    exists: ev.exists,
    latest: ev.registry?.latest ?? null,
    firstPublished: ev.registry?.firstPublished ?? null,
    versionPublished: ev.registry?.versionPublished ?? null,
    weeklyDownloads: ev.weeklyDownloads ?? null,
    maintainers: ev.registry?.maintainers.length ?? null,
    installScripts: Object.keys(ev.registry?.installScripts ?? {}),
    repository: ev.registry?.repositoryUrl ?? null,
    provenance: ev.registry?.provenance ?? null,
    osv: ev.osv ?? null,
    atlas: ev.atlas ?? null,
    similarity: ev.similarity ?? null,
    sourceErrors: ev.errors.map((e) => ({ source: e.source, message: e.message, critical: e.critical })),
  };
}

const hitView = (h: Hit): ApiHit => ({ id: h.id, name: h.name, weight: h.weight, override: h.override, detail: h.detail, ...(h.discounted ? { discounted: true } : {}) });

async function explain(r: Report, useAi: boolean): Promise<{ text: string; source: "ai" | "rules" }> {
  if (useAi && aiEnabled()) {
    try {
      const text = await anthropicProvider({ timeoutMs: 8000 }).explain({
        package: pkgLabel(r),
        verdict: r.verdict,
        score: r.score,
        reasons: countedHits(r.hits).slice(0, 5).map((h) => h.detail),
      });
      if (text) return { text, source: "ai" };
    } catch {
      /* fall back to the deterministic explanation */
    }
  }
  return { text: explainDeterministic(r), source: "rules" };
}

export async function toResult(r: Report, useAi: boolean): Promise<CheckResult> {
  const ex = await explain(r, useAi);
  return {
    target: r.target,
    version: r.version ?? null,
    verdict: r.verdict,
    score: r.score,
    hits: r.hits.map(hitView),
    explanation: ex.text,
    explanationSource: ex.source,
    evidenceSummary: evidenceSummary(r.evidence),
    durationMs: r.durationMs,
  };
}

export const VERDICT_CACHE_TTL_MS = 60 * 60 * 1000;
const cacheVersion = (t: InstallTarget) => t.versionSpec?.trim() || "latest";

/** One package → public verdict, cached for an hour in verdict_cache (not when a source failed). */
export async function runCheck(target: InstallTarget, opts: { ai?: boolean; store?: Store; deps?: CheckDeps } = {}): Promise<CheckResult> {
  const store = opts.store ?? getStore();
  const name = atlasName(target.ecosystem, target.name);
  const ver = cacheVersion(target);
  const hit = await store.getVerdict(target.ecosystem, name, ver).catch(() => null);
  if (hit && Date.now() - Date.parse(hit.computedAt) < VERDICT_CACHE_TTL_MS) {
    const c = hit.evidence as CheckResult;
    if (opts.ai === false || c.explanationSource === "ai" || !aiEnabled()) return { ...c, cached: true };
  }
  const report = await checkPackage(target, opts.deps ?? getDeps());
  const result = await toResult(report, opts.ai ?? true);
  if (!report.evidence.errors.some((e) => e.critical)) {
    await store.putVerdict({ ecosystem: target.ecosystem, name, version: ver, evidence: result, score: result.score, computedAt: new Date().toISOString() }).catch(() => undefined);
  }
  return result;
}

/** Manifest → verdict per dependency. Explanations are deterministic (no LLM fan-out). */
export async function runManifest(targets: InstallTarget[], opts: { deps?: CheckDeps } = {}) {
  const reports = await checkMany(targets, opts.deps ?? getDeps(), {}, 6);
  const results = await Promise.all(reports.map((r) => toResult(r, false)));
  return { results, overall: combineVerdicts(results.map((r) => r.verdict)) };
}
