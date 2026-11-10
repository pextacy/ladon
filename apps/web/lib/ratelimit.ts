/**
 * Fixed-window in-memory rate limiter, keyed per client (IP). Per instance only — good enough to stop
 * casual abuse of the public checker; a determined attacker is bounded by the upstream registries.
 */
export interface RateResult {
  ok: boolean;
  remaining: number;
  /** seconds until the window resets */
  retryAfter: number;
}

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private now: () => number = Date.now,
    private maxKeys = 10_000,
  ) {}

  take(key: string, cost = 1): RateResult {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) {
      if (this.hits.size >= this.maxKeys) this.sweep(t);
      e = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, e);
    }
    const retryAfter = Math.max(1, Math.ceil((e.resetAt - t) / 1000));
    if (e.count + cost > this.limit) return { ok: false, remaining: Math.max(0, this.limit - e.count), retryAfter };
    e.count += cost;
    return { ok: true, remaining: this.limit - e.count, retryAfter };
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    // still full: drop the oldest entries rather than grow without bound
    while (this.hits.size >= this.maxKeys) {
      const first = this.hits.keys().next();
      if (first.done) break;
      this.hits.delete(first.value);
    }
  }
}

const g = globalThis as unknown as { __ladonLimiters?: Record<string, RateLimiter> };

/** Shared limiters (docs/API.md: /api/check 30/min/IP). */
export function limiter(name: "check" | "manifest" | "report" | "devices" | "auth"): RateLimiter {
  const all = (g.__ladonLimiters ??= {});
  const cfg = { check: [30, 60_000], manifest: [5, 60_000], report: [20, 60_000], devices: [10, 60_000], auth: [30, 60_000] } as const;
  return (all[name] ??= new RateLimiter(cfg[name][0], cfg[name][1]));
}
