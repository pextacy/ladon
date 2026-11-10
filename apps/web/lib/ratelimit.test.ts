import { describe, expect, it } from "vitest";
import { RateLimiter } from "./ratelimit";

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
