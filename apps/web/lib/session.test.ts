import { describe, expect, it } from "vitest";
import { Session, sign, unsign } from "./session";

const secret = "s".repeat(40);

describe("signed sessions", () => {
  it("round-trips and rejects tampering, other purposes, expiry", () => {
    const tok = sign({ d: "dev", c: "cred", exp: 2000 }, "session", secret);
    expect(unsign(tok, "session", Session, 1000, secret)).toEqual({ d: "dev", c: "cred", exp: 2000 });
    expect(unsign(tok, "signin", Session, 1000, secret)).toBeNull();
    expect(unsign(tok, "session", Session, 2001, secret)).toBeNull();
    expect(unsign(tok, "session", Session, 1000, "x".repeat(40))).toBeNull();
    const [body, sig] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ d: "other", c: "cred", exp: 2000 })).toString("base64url");
    expect(unsign(`${forged}.${sig}`, "session", Session, 1000, secret)).toBeNull();
    expect(unsign(`${body}`, "session", Session, 1000, secret)).toBeNull();
    expect(unsign(undefined, "session", Session, 1000, secret)).toBeNull();
  });
});
