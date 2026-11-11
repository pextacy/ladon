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

/** The part of the Store a shared limiter needs (lib/store/types.ts `rateTake`). */
export interface RateStore {
  readonly kind: "memory" | "supabase";
  rateTake(bucket: string, limit: number, windowSeconds: number, cost: number): Promise<{ ok: boolean; used: number; resetAt: string }>;
}

/**
 * Rate limit shared across server instances: a Postgres fixed-window counter (migration 0002,
 * `rate_limit_take`) when Supabase is configured, else — or when the database call fails — the
 * per-instance in-memory limiter. A database outage never takes the public checker down.
 */
export class SharedLimiter {
  constructor(
    readonly name: string,
    private local: RateLimiter,
    private store: () => RateStore | null,
    private now: () => number = Date.now,
  ) {}

  get limit() {
    return this.local.limit;
  }

  async take(key: string, cost = 1): Promise<RateResult & { shared: boolean }> {
    const s = this.store();
    if (s && s.kind === "supabase") {
      try {
        const r = await s.rateTake(`${this.name}:${key}`, this.local.limit, Math.max(1, Math.round(this.local.windowMs / 1000)), cost);
        const retryAfter = Math.max(1, Math.ceil((Date.parse(r.resetAt) - this.now()) / 1000));
        return { ok: r.ok, remaining: Math.max(0, this.local.limit - r.used), retryAfter, shared: true };
      } catch {
        /* fall back to the in-memory limiter */
      }
    }
    return { ...this.local.take(key, cost), shared: false };
  }
}

const gs = globalThis as unknown as { __ladonShared?: Record<string, SharedLimiter> };

/** Shared limiters for the public checker endpoints. */
export function sharedLimiter(name: "check" | "manifest", store: () => RateStore | null): SharedLimiter {
  const all = (gs.__ladonShared ??= {});
  return (all[name] ??= new SharedLimiter(name, limiter(name), store));
}
