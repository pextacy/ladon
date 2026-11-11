import { ageMs, DAY, type Evidence } from "./evidence.js";
import { ALL_RULES, type Rule } from "./rules/rules.js";
import type { Verdict } from "./schemas.js";
import { clampScore, verdictForScore } from "./verdict.js";

export interface Hit {
  id: string;
  name: string;
  weight: number;
  override: boolean;
  detail: string;
  /** shown in verbose output but not counted (established-package discount) */
  discounted?: boolean;
}

export interface Scored {
  score: number;
  verdict: Verdict;
  hits: Hit[];
}

export interface ScoreOptions {
  /** fail closed (default): a critical source failure → hold */
  failMode?: "closed" | "open";
  rules?: Rule[];
}

export const SOURCE_UNAVAILABLE_WEIGHT = 60;

/** Heuristic rules that legitimately fire on popular packages (esbuild, sharp, prisma download binaries at install). */
export const DISCOUNTABLE = new Set(["R08", "R09", "R10", "R11", "R13"]);

/**
 * Established package: widely used, long-lived, and the requested version is not brand new.
 * For these, the real risk is a hijacked *new* version — covered by R07, R14, R15 and OSV — so
 * install-script heuristics are shown but not counted. DOCS §2.
 */
export function isEstablished(ev: Evidence): boolean {
  const r = ev.registry;
  const first = ageMs(ev, r?.firstPublished);
  const ver = ageMs(ev, r?.versionPublished);
  if ((ev.weeklyDownloads ?? 0) < 100_000 || first === undefined || first < 180 * DAY || ver === undefined) return false;
  if (ver >= 7 * DAY) return true;
  // A fresh release of a popular package counts as routine only when it keeps the previous release's
  // install scripts unchanged and comes from the same publisher. A hijacked release that adds or edits
  // an install script, or is pushed by someone else, gets no discount (R07/R14 add their own weight).
  return routineRelease(ev);
}

function routineRelease(ev: Evidence): boolean {
  const r = ev.registry;
  if (!r?.previousVersion || !r.previousInstallScripts) return false;
  const same = (a: Record<string, string>, b: Record<string, string>) => {
    const ka = Object.keys(a).sort();
    return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
  };
  if (!same(r.installScripts, r.previousInstallScripts)) return false;
  if (r.publisher && r.previousPublisher && r.publisher !== r.previousPublisher && !r.previousMaintainers.includes(r.publisher)) return false;
  if (r.previousProvenance === true && r.provenance !== true) return false;
  return true;
}

/** Deterministic scoring — DOCS §1/§2. Pure function of the evidence. */
export function scoreEvidence(ev: Evidence, opts: ScoreOptions = {}): Scored {
  const hits: Hit[] = [];
  const established = isEstablished(ev);
  for (const rule of opts.rules ?? ALL_RULES) {
    const r = rule.evaluate(ev);
    if (!r.hit) continue;
    const override = rule.weight === "override";
    const hit: Hit = { id: rule.id, name: rule.name, weight: override ? 100 : (r.weight ?? (rule.weight as number)), override, detail: r.detail };
    if (established && DISCOUNTABLE.has(rule.id)) {
      hit.weight = 0;
      hit.discounted = true;
    }
    hits.push(hit);
  }
  const critical = ev.errors.filter((e) => e.critical);
  if (critical.length > 0 && (opts.failMode ?? "closed") === "closed" && !hits.some((h) => h.override)) {
    hits.push({
      id: "E01",
      name: "source_unavailable",
      weight: SOURCE_UNAVAILABLE_WEIGHT,
      override: false,
      detail: `could not verify: ${critical.map((e) => e.message).join("; ")} (failing closed)`,
    });
  }
  hits.sort((a, b) => Number(b.override) - Number(a.override) || Number(!!a.discounted) - Number(!!b.discounted) || b.weight - a.weight);
  const score = hits.some((h) => h.override) ? 100 : clampScore(hits.reduce((s, h) => s + h.weight, 0));
  return { score, verdict: verdictForScore(score), hits };
}
