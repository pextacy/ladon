import { describe, expect, it } from "vitest";
import { SupabaseStore } from "./supabase";

/** Minimal stand-in for the supabase-js query builder: records calls, resolves to `result`. */
function fakeDb(result: { data: unknown; error: { message: string } | null }) {
  const calls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "gte", "order", "limit", "upsert"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return builder;
    };
  }
  builder.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  const db = { ...builder, rpc: async (...args: unknown[]) => (calls.push(["rpc", ...args]), result) };
  return { db, calls };
}

const withDb = (db: unknown) => {
  const s = new SupabaseStore("https://example.supabase.co", "service-key");
  (s as unknown as { db: unknown }).db = db;
  return s;
};

describe("SupabaseStore (migration 0002 surface)", () => {
  it("rateTake calls rate_limit_take and maps the row", async () => {
    const { db, calls } = fakeDb({ data: [{ allowed: false, used: 30, reset_at: "2026-11-10T00:01:00+00:00" }], error: null });
    expect(await withDb(db).rateTake("check:ip", 30, 60, 1)).toEqual({ ok: false, used: 30, resetAt: "2026-11-10T00:01:00+00:00" });
    expect(calls).toEqual([["rpc", "rate_limit_take", { p_bucket: "check:ip", p_limit: 30, p_window_seconds: 60, p_cost: 1 }]]);
  });

  it("rateTake throws on a database error so the caller falls back", async () => {
    const { db } = fakeDb({ data: null, error: { message: "function does not exist" } });
    await expect(withDb(db).rateTake("x", 1, 60, 1)).rejects.toThrow(/database error \(rate limit\)/);
  });

  it("listAtlasAlerts reads the atlas_alerts view with filters", async () => {
    const row = { ecosystem: "npm", name: "x", first_seen: "a", models: ["m"], seen_count: 2, registered: true, registered_at: "b", source: null, last_checked: null };
    const { db, calls } = fakeDb({ data: [row], error: null });
    const out = await withDb(db).listAtlasAlerts({ ecosystem: "npm", since: "2026-11-01T00:00:00Z", limit: 5 });
    expect(out[0]).toMatchObject({ name: "x", registeredAt: "b", firstSeen: "a", seenCount: 2 });
    expect(calls).toContainEqual(["from", "atlas_alerts"]);
    expect(calls).toContainEqual(["eq", "ecosystem", "npm"]);
    expect(calls).toContainEqual(["gte", "registered_at", "2026-11-01T00:00:00Z"]);
    expect(calls).toContainEqual(["limit", 5]);
  });

  it("device keys upsert on (device_id, public_key)", async () => {
    const { db, calls } = fakeDb({ data: null, error: null });
    await withDb(db).addDeviceKey({ deviceId: "d", publicKey: "a".repeat(64), fingerprint: "AAAAAAAA", label: "Key", createdAt: "t" });
    expect(calls).toContainEqual(["from", "device_keys"]);
    expect(calls.find((c) => c[0] === "upsert")?.[2]).toMatchObject({ onConflict: "device_id,public_key" });
  });
});
