import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { safeEqual } from "./tokens";

/**
 * Signed, httpOnly cookie sessions for /dashboard. HMAC-SHA256 with LADON_SESSION_SECRET; without it
 * (local dev) a random per-process secret is used, so sessions end when the server restarts.
 */

export const SESSION_COOKIE = "ladon_session";
export const CHALLENGE_COOKIE = "ladon_signin";
export const SESSION_TTL_S = 12 * 60 * 60;
export const CHALLENGE_TTL_S = 5 * 60;

const g = globalThis as unknown as { __ladonDevSecret?: string };

export function sessionSecret(env: Record<string, string | undefined> = process.env): string {
  const s = env.LADON_SESSION_SECRET;
  if (s && s.length >= 32) return s;
  return (g.__ladonDevSecret ??= randomBytes(32).toString("base64url"));
}

function mac(secret: string, purpose: string, body: string): string {
  return createHmac("sha256", secret).update(`${purpose}.${body}`).digest("base64url");
}

export function sign(payload: object, purpose: string, secret = sessionSecret()): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(secret, purpose, body)}`;
}

export function unsign<S extends z.ZodType>(token: string | undefined, purpose: string, schema: S, nowSec: number, secret = sessionSecret()): z.infer<S> | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(sig, mac(secret, purpose, body))) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const r = schema.safeParse(raw);
  if (!r.success) return null;
  const exp = (r.data as { exp?: unknown }).exp;
  if (typeof exp !== "number" || exp < nowSec) return null;
  return r.data;
}

export const Session = z.object({ d: z.string(), c: z.string(), exp: z.number() });
export type Session = z.infer<typeof Session>;
export const SignInChallenge = z.object({ ch: z.string(), exp: z.number() });

export function cookieOptions(maxAge: number, secure: boolean) {
  return { httpOnly: true, sameSite: "strict" as const, secure, path: "/", maxAge };
}
