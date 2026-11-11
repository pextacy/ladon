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

describe("session secret fails closed in production", () => {
  it("throws for a missing or short secret in production, falls back only in dev", async () => {
    const { sessionSecret, sessionConfigured } = await import("./session");
    expect(() => sessionSecret({ NODE_ENV: "production" })).toThrow(/LADON_SESSION_SECRET/);
    expect(() => sessionSecret({ NODE_ENV: "production", LADON_SESSION_SECRET: "short" })).toThrow(/LADON_SESSION_SECRET/);
    expect(sessionConfigured({ NODE_ENV: "production" })).toBe(false);
    expect(sessionSecret({ NODE_ENV: "production", LADON_SESSION_SECRET: secret })).toBe(secret);
    expect(sessionSecret({ NODE_ENV: "development" })).toHaveLength(43);
    expect(sessionConfigured({ NODE_ENV: "development" })).toBe(true);
  });

  it("treats every cookie as signed out when the production secret is missing", async () => {
    const { vi } = await import("vitest");
    const tok = sign({ d: "dev", c: "cred", exp: 2000 }, "session", secret);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LADON_SESSION_SECRET", "");
    try {
      expect(unsign(tok, "session", Session, 1000)).toBeNull();
      expect(() => sign({ d: "dev", c: "cred", exp: 2000 }, "session")).toThrow(/LADON_SESSION_SECRET/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
