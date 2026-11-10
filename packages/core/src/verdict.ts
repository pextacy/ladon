import type { Verdict } from "./schemas.js";

/** Verdict bands — DOCS.md §1. */
export const BANDS = { warnFrom: 30, holdFrom: 60 } as const;

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 100; // fail closed
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function verdictForScore(score: number): Verdict {
  const s = clampScore(score);
  if (s >= BANDS.holdFrom) return "hold";
  if (s >= BANDS.warnFrom) return "warn";
  return "allow";
}
