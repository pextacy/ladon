import { describe, expect, it } from "vitest";
import { RateLimiter, SharedLimiter, type RateStore } from "./ratelimit";
import { MemoryStore } from "./store/memory";

describe("RateLimiter", () => {
  it("allows up to the limit per window per key", () => {
    let t = 0;
    const l = new RateLimiter(3, 60_000, () => t);
    expect([1, 2, 3].map(() => l.take("ip").ok)).toEqual([true, true, true]);
    const r = l.take("ip");
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBe(60);
    expect(l.take("other").ok).toBe(true);
    t = 60_000;
    expect(l.take("ip").ok).toBe(true);
  });

  it("supports weighted cost", () => {
    const l = new RateLimiter(5, 1000, () => 0);
    expect(l.take("ip", 4).ok).toBe(true);
    expect(l.take("ip", 2).ok).toBe(false);
    expect(l.take("ip", 1).ok).toBe(true);
  });

  it("stays bounded in memory", () => {
    let t = 0;
    const l = new RateLimiter(1, 1000, () => t, 10);
    for (let i = 0; i < 50; i++) l.take(`ip${i}`);
    t = 5000;
    expect(l.take("fresh").ok).toBe(true);
  });
});

describe("SharedLimiter", () => {
  const fake = (impl: RateStore["rateTake"]): RateStore & { calls: string[] } => {
    const calls: string[] = [];
    return { kind: "supabase", calls, rateTake: (b, l, w, c) => (calls.push(`${b}|${l}|${w}|${c}`), impl(b, l, w, c)) };
  };

  it("uses the in-memory limiter when no database is configured", async () => {
    const l = new SharedLimiter("check", new RateLimiter(2, 60_000, () => 0), () => null);
    expect((await l.take("ip")).ok).toBe(true);
    expect((await l.take("ip")).ok).toBe(true);
    const r = await l.take("ip");
    expect(r).toMatchObject({ ok: false, shared: false });
  });

  it("counts in the shared store (bucket = name:ip, window in seconds)", async () => {
    const store = fake(async () => ({ ok: false, used: 30, resetAt: new Date(42_000).toISOString() }));
    const l = new SharedLimiter("check", new RateLimiter(30, 60_000), () => store, () => 0);
    expect(await l.take("1.2.3.4", 2)).toEqual({ ok: false, remaining: 0, retryAfter: 42, shared: true });
    expect(store.calls).toEqual(["check:1.2.3.4|30|60|2"]);
  });

  it("falls back to memory when the database errors", async () => {
    const store = fake(async () => {
      throw new Error("database error (rate limit): down");
    });
    const l = new SharedLimiter("manifest", new RateLimiter(1, 60_000, () => 0), () => store);
    expect(await l.take("ip")).toMatchObject({ ok: true, shared: false });
    expect(await l.take("ip")).toMatchObject({ ok: false, shared: false });
  });

  it("the memory store satisfies the RateStore interface", async () => {
    const m = new MemoryStore();
    m.now = () => 0;
    const r: RateStore = m;
    expect((await r.rateTake("x", 1, 60, 1)).ok).toBe(true);
    expect((await r.rateTake("x", 1, 60, 1)).ok).toBe(false);
  });
});
