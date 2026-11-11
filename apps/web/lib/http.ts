import type { z } from "zod";
import { sharedLimiter, type RateLimiter } from "./ratelimit";
import { getStore, supabaseConfigured, type DeviceRecord } from "./store";
import { sha256Hex } from "./tokens";
import { zodMessage } from "./validate";

/** Errors are always JSON `{ error }` with a sentence a human can act on (fail closed, explain always). */
export function jsonError(status: number, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(data, { status: init.status ?? 200, headers: { "cache-control": "no-store", ...init.headers } });
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

export async function readJson<S extends z.ZodType>(req: Request, schema: S, maxBytes = 64 * 1024): Promise<Parsed<z.infer<S>>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return { ok: false, response: jsonError(415, "send the body as application/json") };
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { ok: false, response: jsonError(413, `request body is larger than ${Math.round(maxBytes / 1024)} KB`) };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: jsonError(400, "could not read the request body") };
  }
  if (Buffer.byteLength(text) > maxBytes) return { ok: false, response: jsonError(413, `request body is larger than ${Math.round(maxBytes / 1024)} KB`) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: jsonError(400, "request body is not valid JSON") };
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, response: jsonError(400, zodMessage(r.error)) };
  return { ok: true, data: r.data };
}

export function parseQuery<S extends z.ZodType>(url: URL, schema: S): Parsed<z.infer<S>> {
  const obj: Record<string, string> = {};
  for (const [k, v] of url.searchParams) obj[k] = v;
  const r = schema.safeParse(obj);
  return r.success ? { ok: true, data: r.data } : { ok: false, response: jsonError(400, zodMessage(r.error)) };
}

export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "local";
}

export function rateLimited(l: RateLimiter, headers: Headers, cost = 1): Response | null {
  const r = l.take(clientIp(headers), cost);
  if (r.ok) return null;
  return jsonError(429, `too many requests — limit is ${l.limit} per minute; try again in ${r.retryAfter} s`, { "retry-after": String(r.retryAfter) });
}

/** Like rateLimited, but counted across server instances when Supabase is configured. */
export async function rateLimitedShared(name: "check" | "manifest", headers: Headers, cost = 1): Promise<Response | null> {
  const l = sharedLimiter(name, () => (supabaseConfigured() ? getStore() : null));
  const r = await l.take(clientIp(headers), cost);
  if (r.ok) return null;
  return jsonError(429, `too many requests — limit is ${l.limit} per minute; try again in ${r.retryAfter} s`, { "retry-after": String(r.retryAfter) });
}

/** Bearer device token → device. The server stores only sha256(token). */
export async function authDevice(req: Request): Promise<{ ok: true; device: DeviceRecord } | { ok: false; response: Response }> {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,128})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return { ok: false, response: jsonError(401, "missing or malformed Authorization: Bearer <deviceToken>", { "www-authenticate": "Bearer" }) };
  const device = await getStore().getDeviceByTokenHash(sha256Hex(m[1]!));
  if (!device) return { ok: false, response: jsonError(401, "unknown device token — run `ladon init` to pair again", { "www-authenticate": "Bearer" }) };
  return { ok: true, device };
}

/** Wrap a handler so unexpected failures still answer with JSON and never leak stack traces. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error("[ladon api]", e);
      const msg = e instanceof Error && e.message.startsWith("database error") ? "the database is unavailable — nothing was changed; try again" : "internal error — nothing was changed; try again";
      return jsonError(500, msg);
    }
  };
}
