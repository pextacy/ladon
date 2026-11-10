import { describe, expect, it } from "vitest";
import { verifyKeyResponse } from "./approval.js";

// Vectors produced by the firmware's own signing code (firmware/test-vectors.md, test seed 00..1f).
const PK = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";
const req = { id: "a1b2", h: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", n: "6e6f6e63652d3031", exp: 1763139600 };
const ctx = (last: number) => ({ publicKeyHex: PK, lastCounter: last, usedNonces: new Set<string>(), nowSeconds: 1763139000 });

describe("host ⇄ firmware signature compatibility", () => {
  it("vector 1 (approve, ctr 42) verifies", () => {
    const res = { t: "res" as const, id: "a1b2", ok: true, ctr: 42, sig: "1f44517372dce4861a9640c1a572f52deb27c981a92b909df590c7108f073bdddabd1c03f6b2563fdebc88c4d0812919af26e5fee9335d3109ff595bc86f6d0e" };
    expect(verifyKeyResponse(req, res, ctx(41))).toEqual({ ok: true, approved: true, ctr: 42 });
    expect(verifyKeyResponse(req, { ...res, ok: false }, ctx(41)).ok).toBe(false);
  });
  it("vector 2 (timeout reject, ctr 43) verifies as a rejection", () => {
    const res = { t: "res" as const, id: "a1b2", ok: false, ctr: 43, reason: "timeout", sig: "2757272ca14cf0db6171ca70798d5a0cf2517b6e167678dead67c642a40dc2f3f2fa268dd4659354cb2c3dba0c71b23a3372fbb1416d1511339fcb84f072ce0f" };
    expect(verifyKeyResponse(req, res, ctx(42))).toEqual({ ok: true, approved: false, ctr: 43 });
  });
});
