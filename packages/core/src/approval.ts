import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { z } from "zod";

/**
 * Approval protocol — DOCS §6. The daemon creates a request bound to the exact command (hash),
 * a one-time nonce and an expiry. Only a Ladon Key signature (Ed25519) or a WebAuthn assertion over
 * the same challenge can approve it. There is deliberately no code path that approves without one.
 */

export const APPROVAL_TTL_SECONDS = 120;

export const KeyRequest = z.object({
  t: z.literal("req"),
  id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  pkg: z.string().max(240),
  score: z.number().int().min(0).max(100),
  why: z.array(z.string().max(120)).max(3),
  h: z.string().regex(/^[0-9a-f]{64}$/),
  n: z.string().regex(/^[0-9a-f]{32,64}$/),
  exp: z.number().int().positive(),
});
export type KeyRequest = z.infer<typeof KeyRequest>;

export const KeyResponse = z.object({
  t: z.literal("res"),
  id: z.string(),
  ok: z.boolean(),
  ctr: z.number().int().nonnegative(),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
  reason: z.string().optional(),
});
export type KeyResponse = z.infer<typeof KeyResponse>;

export const KeyHello = z.object({
  t: z.literal("hello"),
  v: z.number().int(),
  pk: z.string().regex(/^[0-9a-f]{64}$/),
  ctr: z.number().int().nonnegative(),
  name: z.string().optional(),
});
export type KeyHello = z.infer<typeof KeyHello>;

export function commandHash(command: string, cwd = ""): string {
  return createHash("sha256").update(`${cwd}\0${command}`).digest("hex");
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function newRequestId(): string {
  return randomBytes(6).toString("base64url");
}

/** Exactly the bytes the Ladon Key signs: id|h|n|exp|ok|ctr */
export function keySignedMessage(r: { id: string; h: string; n: string; exp: number }, ok: boolean, ctr: number): string {
  return `${r.id}|${r.h}|${r.n}|${r.exp}|${ok ? 1 : 0}|${ctr}`;
}

/** WebAuthn challenge for the same request, with the decision bound in: ladon:v1|id|h|n|exp|decision */
export function passkeyChallenge(r: { id: string; h: string; n: string; exp: number }, decision: "approve" | "reject"): string {
  return Buffer.from(`ladon:v1|${r.id}|${r.h}|${r.n}|${r.exp}|${decision}`).toString("base64url");
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519PublicKeyFromRaw(rawHex: string) {
  const raw = Buffer.from(rawHex, "hex");
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

export function verifyEd25519(rawPublicKeyHex: string, message: string, sigHex: string): boolean {
  try {
    return verify(null, Buffer.from(message), ed25519PublicKeyFromRaw(rawPublicKeyHex), Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

export type KeyVerdict = { ok: true; approved: boolean; ctr: number } | { ok: false; error: string };

/**
 * Verify a Ladon Key response against the pending request: signature, matching id, expiry, nonce
 * freshness and a strictly increasing counter (replay protection).
 */
export function verifyKeyResponse(
  req: { id: string; h: string; n: string; exp: number },
  res: KeyResponse,
  ctx: { publicKeyHex: string; lastCounter: number; usedNonces: Set<string>; nowSeconds?: number },
): KeyVerdict {
  const now = ctx.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (res.id !== req.id) return { ok: false, error: "response is for a different request" };
  if (now > req.exp) return { ok: false, error: "approval expired" };
  if (ctx.usedNonces.has(req.n)) return { ok: false, error: "nonce already used (replay)" };
  if (res.ctr <= ctx.lastCounter) return { ok: false, error: `counter did not increase (${res.ctr} ≤ ${ctx.lastCounter}) — replay?` };
  if (!verifyEd25519(ctx.publicKeyHex, keySignedMessage(req, res.ok, res.ctr), res.sig)) return { ok: false, error: "bad signature — not from the paired Ladon Key" };
  return { ok: true, approved: res.ok, ctr: res.ctr };
}

/** Short fingerprint shown on the Key's idle screen and in `ladon key status`. */
export function keyFingerprint(rawPublicKeyHex: string): string {
  return rawPublicKeyHex.slice(0, 8).toUpperCase();
}
