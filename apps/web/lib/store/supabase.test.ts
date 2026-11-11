import { beforeEach, describe, expect, it, vi } from "vitest";

/** Records every PostgREST call chain the store builds, and answers each with { data: [], error: null }. */
type Call = { table: string; ops: [string, unknown[]][] };
const calls: Call[] = [];

function builder(table: string) {
  const call: Call = { table, ops: [] };
  calls.push(call);
  const b: Record<string, unknown> = {};
  for (const op of ["update", "insert", "select", "eq", "is", "order", "limit", "range", "ilike", "maybeSingle"]) {
    b[op] = (...args: unknown[]) => {
      call.ops.push([op, args]);
      return b;
    };
  }
  b.then = (resolve: (v: { data: unknown[]; error: null; count: number }) => unknown) => resolve({ data: [], error: null, count: 0 });
  return b;
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => builder(t), rpc: () => builder("rpc") }) }));

const { SupabaseStore } = await import("./supabase");

describe("SupabaseStore.setAtlasRegistered matches MemoryStore semantics", () => {
  beforeEach(() => void (calls.length = 0));

  it("always moves last_checked and sets registered, and only fills registered_at when empty", async () => {
    await new SupabaseStore("https://x.supabase.co", "k").setAtlasRegistered("npm", "foo", "2026-11-01T00:00:00.000Z", "2026-11-10T00:00:00.000Z");
    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    expect(first!.ops[0]).toEqual(["update", [{ last_checked: "2026-11-10T00:00:00.000Z", registered: true }]]);
    expect(first!.ops.some(([op]) => op === "is")).toBe(false); // not gated on registered_at
    expect(second!.ops[0]).toEqual(["update", [{ registered_at: "2026-11-01T00:00:00.000Z" }]]);
    expect(second!.ops).toContainEqual(["is", ["registered_at", null]]);
  });

  it("an unregistered re-check only touches last_checked", async () => {
    await new SupabaseStore("https://x.supabase.co", "k").setAtlasRegistered("pypi", "bar", null, "2026-11-10T00:00:00.000Z");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ops[0]).toEqual(["update", [{ last_checked: "2026-11-10T00:00:00.000Z" }]]);
  });
});
