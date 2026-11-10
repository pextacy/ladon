import type { PairCodeRecord, Store } from "./store/types";

export type PairCheck = { ok: true; pair: PairCodeRecord } | { ok: false; status: number; error: string };

export async function usablePairCode(store: Store, code: string, now: number): Promise<PairCheck> {
  const pair = await store.getPairCode(code);
  if (!pair) return { ok: false, status: 404, error: "unknown pair code — check the code printed by `ladon init`" };
  if (pair.usedAt) return { ok: false, status: 409, error: "this pair code was already used — run `ladon init` for a new one" };
  if (Date.parse(pair.expiresAt) < now) return { ok: false, status: 410, error: "this pair code expired (codes last 15 minutes) — run `ladon init` for a new one" };
  return { ok: true, pair };
}
