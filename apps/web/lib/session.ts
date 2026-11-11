import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { safeEqual } from "./tokens";

/**
 * Signed, httpOnly cookie sessions for /dashboard. HMAC-SHA256 with LADON_SESSION_SECRET (≥ 32 chars).
 * Without it, local dev uses a random per-process secret (sessions end on restart). In production a
 * missing/short secret fails closed: sign-in is disabled and every cookie is treated as signed-out —
 * a per-instance random secret would make sign-in fail at random across serverless instances.
 */

export const SESSION_COOKIE = "ladon_session";
export const CHALLENGE_COOKIE = "ladon_signin";
export const SESSION_TTL_S = 12 * 60 * 60;
export const CHALLENGE_TTL_S = 5 * 60;

const g = globalThis as unknown as { __ladonDevSecret?: string };

export class SessionConfigError extends Error {}

export function sessionSecret(env: Record<string, string | undefined> = process.env): string {
  const s = env.LADON_SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (env.NODE_ENV === "production") throw new SessionConfigError("LADON_SESSION_SECRET is missing or shorter than 32 characters");
  return (g.__ladonDevSecret ??= randomBytes(32).toString("base64url"));
}

/** false in production when LADON_SESSION_SECRET is unusable — sign-in must be refused. */
export function sessionConfigured(env: Record<string, string | undefined> = process.env): boolean {
  try {
    sessionSecret(env);
    return true;
  } catch {
    return false;
  }
}

function mac(secret: string, purpose: string, body: string): string {
  return createHmac("sha256", secret).update(`${purpose}.${body}`).digest("base64url");
}

export function sign(payload: object, purpose: string, secret = sessionSecret()): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(secret, purpose, body)}`;
}

export function unsign<S extends z.ZodType>(token: string | undefined, purpose: string, schema: S, nowSec: number, secretOverride?: string): z.infer<S> | null {
  if (!token) return null;
  let secret: string;
  try {
    secret = secretOverride ?? sessionSecret();
  } catch {
    return null; // not configured: nobody is signed in
  }
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
