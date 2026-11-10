import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url (docs/API.md). */
export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** [A-Z2-9] minus the look-alikes I and O, so codes survive being read aloud or retyped. */
export const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIR_CODE_RE = /^[A-Z2-9]{8}$/;
export const PAIR_TTL_MS = 15 * 60 * 1000;

export function newPairCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)];
  return s;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
