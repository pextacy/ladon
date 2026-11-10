import { describe, expect, it } from "vitest";
import { challengeFor, newApprovalRecord } from "./approvals";
import { assertionOptions, challengeBytes } from "./webauthn";

describe("webauthn options", () => {
  it("carry the decision-bound challenge unchanged and list the device's passkeys", async () => {
    const a = newApprovalRecord({ id: "abcd1234", commandHash: "a".repeat(64), nonce: "b".repeat(32), exp: 1000, ecosystem: "npm", package: "x", score: 80, reasons: [] }, "d1", "t");
    const ch = challengeFor(a, "approve");
    expect(Buffer.from(challengeBytes(ch)).toString("base64url")).toBe(ch);
    const o = await assertionOptions({ origin: "http://localhost:3000", rpID: "localhost", rpName: "Ladon" }, ch, [
      { credentialId: "Y3JlZA", deviceId: "d1", publicKey: "pk", counter: 0, label: "p", transports: ["internal", "bogus"], createdAt: "t" },
    ]);
    expect(o.challenge).toBe(ch);
    expect(o.userVerification).toBe("required");
    expect(o.rpId).toBe("localhost");
    expect(o.allowCredentials).toEqual([{ id: "Y3JlZA", transports: ["internal"], type: "public-key" }]);
  });
});
