import type { Store } from "../lib/store/types";
import { extractNames, type ExtractedName } from "./extract";
import type { Existence } from "./registry";
import type { ProbePrompt } from "./prompts/generate";

/** Probe logic with every side effect injected, so it is testable without network or API key. */
export interface ProbeDeps {
  /** ask a model one prompt; returns the raw structured output (or null on refusal/failure) */
  ask(model: string, prompt: ProbePrompt): Promise<unknown | null>;
  exists(ecosystem: "npm" | "pypi", name: string): Promise<Existence>;
  store: Store;
  now(): Date;
  log(msg: string): void;
}

export interface ProbeStats {
  calls: number;
  failedCalls: number;
  names: number;
  hallucinated: number;
  unknown: number;
}

/** Deterministic daily rotation so nightly runs cover all prompts over time under the cost cap. */
export function selectPrompts(prompts: ProbePrompt[], max: number, day: number): ProbePrompt[] {
  if (prompts.length === 0 || max <= 0) return [];
  const n = Math.min(max, prompts.length);
  const start = (day * n) % prompts.length;
  return Array.from({ length: n }, (_, i) => prompts[(start + i) % prompts.length]!);
}

export const dayNumber = (d: Date) => Math.floor(d.getTime() / 86_400_000);

/**
 * Send prompts to each model (total calls ≤ maxCalls), extract package names, check each against
 * its registry, record names that do not exist as hallucinated (registered=false).
 */
export async function probeRun(prompts: ProbePrompt[], models: string[], maxCalls: number, deps: ProbeDeps): Promise<ProbeStats> {
  const stats: ProbeStats = { calls: 0, failedCalls: 0, names: 0, hallucinated: 0, unknown: 0 };
  if (models.length === 0) return stats;
  const perModel = Math.floor(maxCalls / models.length);
  const picked = selectPrompts(prompts, perModel, dayNumber(deps.now()));
  const existence = new Map<string, Promise<Existence>>();
  const check = (n: ExtractedName) => {
    const k = `${n.ecosystem}:${n.name}`;
    if (!existence.has(k)) existence.set(k, deps.exists(n.ecosystem, n.name));
    return existence.get(k)!;
  };

  for (const model of models) {
    for (const p of picked) {
      stats.calls++;
      const out = await deps.ask(model, p);
      if (out === null) {
        stats.failedCalls++;
        continue;
      }
      const names = extractNames(out);
      stats.names += names.length;
      for (const n of names) {
        const e = await check(n);
        if (e.exists === null) {
          stats.unknown++;
          continue;
        }
        if (e.exists) continue;
        stats.hallucinated++;
        await deps.store.observeAtlasName({ ecosystem: n.ecosystem, name: n.name, model, source: `atlas probe (${p.id.split("-")[0]})`, registered: false, at: deps.now().toISOString() });
        deps.log(`  hallucinated ${n.ecosystem}:${n.name}  (${model}, ${p.id})`);
      }
    }
  }
  return stats;
}

export interface RecheckStats {
  checked: number;
  newlyRegistered: { ecosystem: string; name: string; registeredAt: string }[];
  unknown: number;
}

/** Re-check unregistered Atlas names; flag the ones that now exist (the slopsquat early warning). */
export async function recheckRun(limit: number, deps: Pick<ProbeDeps, "exists" | "store" | "now" | "log">): Promise<RecheckStats> {
  const stats: RecheckStats = { checked: 0, newlyRegistered: [], unknown: 0 };
  const names = await deps.store.listAtlasUnregistered(limit);
  for (const n of names) {
    stats.checked++;
    const e = await deps.exists(n.ecosystem, n.name);
    const now = deps.now().toISOString();
    if (e.exists === null) {
      stats.unknown++;
      continue;
    }
    if (e.exists) {
      // first publish time from the registry when it is after we first saw the name; else now
      const at = e.createdAt && Date.parse(e.createdAt) >= Date.parse(n.firstSeen) ? e.createdAt : now;
      await deps.store.setAtlasRegistered(n.ecosystem, n.name, at, now);
      stats.newlyRegistered.push({ ecosystem: n.ecosystem, name: n.name, registeredAt: at });
      deps.log(`  NEWLY REGISTERED ${n.ecosystem}:${n.name} at ${at}`);
    } else {
      await deps.store.setAtlasRegistered(n.ecosystem, n.name, null, now);
    }
  }
  return stats;
}
