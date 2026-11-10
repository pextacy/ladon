import { describe, expect, it } from "vitest";
import { passkeyChallenge } from "@ladon/core";
import { verifyPasskeyAssertion } from "./approve/passkey.js";
// @ts-expect-error — plain JS test helper
import { createSoftAuthenticator } from "../../../scripts/soft-authenticator.mjs";

const WEB = "https://ladon.example";
type Soft = { credentialId: string; register(o: { challenge: string }): { response: { attestationObject: string } }; assert(o: { challenge: string }): never };

/** Extract the COSE public key the server would store, from the soft authenticator's attestation. */
async function pinned(auth: Soft) {
  const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
  const challenge = Buffer.from("reg").toString("base64url");
  const v = await verifyRegistrationResponse({ response: auth.register({ challenge }) as never, expectedChallenge: challenge, expectedOrigin: WEB, expectedRPID: "ladon.example", requireUserVerification: true });
  const c = v.registrationInfo!.credential;
  return { credentialId: c.id, publicKey: Buffer.from(c.publicKey).toString("base64url"), counter: 0 };
}

const req = { id: "abcd1234", h: "a".repeat(64), n: "b".repeat(32), exp: 2_000_000_000, pkg: "npm:x", ecosystem: "npm" as const, name: "x", score: 90, why: [] };

describe("passkey assertions are verified by the daemon, not trusted from the server", () => {
  it("accepts a valid assertion for the pinned passkey and decision", async () => {
    const auth = createSoftAuthenticator({ origin: WEB, rpId: "ladon.example" }) as Soft;
    const cfg = { webUrl: WEB, passkeys: [await pinned(auth)] };
    const a = auth.assert({ challenge: passkeyChallenge(req, "approve") });
    expect((await verifyPasskeyAssertion(cfg, req, "approve", a)).ok).toBe(true);
  });

  it("a compromised server can't turn a rejection into an approval", async () => {
    const auth = createSoftAuthenticator({ origin: WEB, rpId: "ladon.example" }) as Soft;
    const cfg = { webUrl: WEB, passkeys: [await pinned(auth)] };
    const rejectAssertion = auth.assert({ challenge: passkeyChallenge(req, "reject") });
    expect((await verifyPasskeyAssertion(cfg, req, "approve", rejectAssertion)).ok).toBe(false);
  });

  it("rejects assertions from passkeys that were never pinned (server-injected credential)", async () => {
    const real = createSoftAuthenticator({ origin: WEB, rpId: "ladon.example" }) as Soft;
    const rogue = createSoftAuthenticator({ origin: WEB, rpId: "ladon.example" }) as Soft;
    const cfg = { webUrl: WEB, passkeys: [await pinned(real)] };
    const r = await verifyPasskeyAssertion(cfg, req, "approve", rogue.assert({ challenge: passkeyChallenge(req, "approve") }));
    expect(r).toMatchObject({ ok: false });
  });

  it("an assertion for another request doesn't approve this one", async () => {
    const auth = createSoftAuthenticator({ origin: WEB, rpId: "ladon.example" }) as Soft;
    const cfg = { webUrl: WEB, passkeys: [await pinned(auth)] };
    const other = auth.assert({ challenge: passkeyChallenge({ ...req, n: "c".repeat(32) }, "approve") });
    expect((await verifyPasskeyAssertion(cfg, req, "approve", other)).ok).toBe(false);
  });
});
