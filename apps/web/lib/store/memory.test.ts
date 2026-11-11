import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory";
import { seedRecords } from "./index";
import type { ApprovalRecord } from "./types";

const approval = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: "abcd1234", deviceId: "d1", commandHash: "a".repeat(64), nonce: "b".repeat(32), exp: 2_000_000_000, ecosystem: "npm",
  package: "color-fn-utils", version: "1.0.2", score: 85, reasons: ["2 days old"], intent: null, status: "pending", decision: null,
  assertion: null, decidedBy: null, decidedAt: null, createdAt: "2026-11-10T00:00:00.000Z", ...over,
});

describe("MemoryStore", () => {
  it("finds devices by token hash and returns copies", async () => {
    const s = new MemoryStore();
    await s.createDevice({ id: "d1", label: "laptop", tokenHash: "h1", createdAt: "x" });
    const d = await s.getDeviceByTokenHash("h1");
    expect(d?.id).toBe("d1");
    d!.label = "mutated";
    expect((await s.getDevice("d1"))?.label).toBe("laptop");
    expect(await s.getDeviceByTokenHash("nope")).toBeNull();
  });

  it("consumes a pair code once", async () => {
    const s = new MemoryStore();
    await s.createPairCode({ code: "ABCDEFGH", deviceId: "d1", expiresAt: "x", usedAt: null, challenge: null, createdAt: "x" });
    await s.setPairChallenge("ABCDEFGH", "ch");
    expect((await s.getPairCode("ABCDEFGH"))?.challenge).toBe("ch");
    expect(await s.consumePairCode("ABCDEFGH", "t")).toBe(true);
    expect(await s.consumePairCode("ABCDEFGH", "t")).toBe(false);
    expect(await s.consumePairCode("ZZZZZZZZ", "t")).toBe(false);
  });

  it("passkeys belong to a device and keep counters", async () => {
    const s = new MemoryStore();
    await s.addPasskey({ credentialId: "c1", deviceId: "d1", publicKey: "pk", counter: 0, label: "phone", transports: [], createdAt: "x" });
    await s.updatePasskeyCounter("c1", 5);
    expect((await s.getPasskey("c1"))?.counter).toBe(5);
    expect(await s.listPasskeys("d1")).toHaveLength(1);
    expect(await s.listPasskeys("d2")).toHaveLength(0);
  });

  it("approval ids are unique and transitions only leave pending once", async () => {
    const s = new MemoryStore();
    expect(await s.createApproval(approval())).toBe("ok");
    expect(await s.createApproval(approval())).toBe("exists");
    expect(await s.transitionApproval("abcd1234", { status: "approved", decision: "approve", decidedBy: "c1" })).toBe(true);
    expect(await s.transitionApproval("abcd1234", { status: "rejected", decision: "reject" })).toBe(false);
    const a = await s.getApproval("abcd1234");
    expect(a?.status).toBe("approved");
    expect(a?.decidedBy).toBe("c1");
    expect(await s.transitionApproval("missing", { status: "expired" })).toBe(false);
  });

  it("lists decisions newest first per device", async () => {
    const s = new MemoryStore();
    const base = { deviceId: "d1", ecosystem: "npm" as const, package: "x", version: null, verdict: "hold" as const, score: 90, reasons: [], outcome: "blocked" as const, via: null, agent: null, createdAt: "x" };
    await s.addDecision({ ...base, id: "1", ts: "2026-11-01T00:00:00Z" });
    await s.addDecision({ ...base, id: "2", ts: "2026-11-03T00:00:00Z" });
    await s.addDecision({ ...base, id: "3", ts: "2026-11-02T00:00:00Z", deviceId: "d2" });
    expect((await s.listDecisions("d1", 10)).map((d) => d.id)).toEqual(["2", "1"]);
  });

  it("atlas observe merges models and counts, search filters", async () => {
    const s = new MemoryStore(seedRecords());
    const o = { ecosystem: "npm" as const, name: "react-fake-pkg", source: "probe", registered: false, at: "2026-11-10T00:00:00Z" };
    await s.observeAtlasName({ ...o, model: "m1" });
    await s.observeAtlasName({ ...o, model: "m2" });
    await s.observeAtlasName({ ...o, model: "m1" });
    const e = await s.getAtlasName("npm", "react-fake-pkg");
    expect(e?.seenCount).toBe(3);
    expect(e?.models).toEqual(["m1", "m2"]);
    expect((await s.searchAtlas({ q: "fake", limit: 10 })).total).toBe(1);
    expect((await s.searchAtlas({ ecosystem: "pypi", limit: 10 })).entries.every((x) => x.ecosystem === "pypi")).toBe(true);
    expect((await s.listAtlasUnregistered(10)).some((x) => x.name === "react-fake-pkg")).toBe(true);
    await s.setAtlasRegistered("npm", "react-fake-pkg", "2026-11-11T00:00:00Z", "2026-11-11T00:00:00Z");
    expect((await s.getAtlasName("npm", "react-fake-pkg"))?.registered).toBe(true);
    // first registration date sticks
    await s.setAtlasRegistered("npm", "react-fake-pkg", "2026-12-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect((await s.getAtlasName("npm", "react-fake-pkg"))?.registeredAt).toBe("2026-11-11T00:00:00Z");
  });

  it("seed records come from core's curated seed", () => {
    const seed = seedRecords();
    expect(seed.length).toBeGreaterThan(0);
    expect(seed.every((e) => !!e.source)).toBe(true);
  });

  it("verdict cache round-trips", async () => {
    const s = new MemoryStore();
    await s.putVerdict({ ecosystem: "npm", name: "a", version: "latest", evidence: { x: 1 }, score: 0, computedAt: "t" });
    expect((await s.getVerdict("npm", "a", "latest"))?.evidence).toEqual({ x: 1 });
    expect(await s.getVerdict("npm", "a", "1.0.0")).toBeNull();
  });
});

describe("MemoryStore token lookup", () => {
  it("matches only the exact hash among several devices", async () => {
    const s = new MemoryStore();
    for (const i of [1, 2, 3]) await s.createDevice({ id: `d${i}`, label: "l", tokenHash: `${i}`.repeat(64), createdAt: "x" });
    expect((await s.getDeviceByTokenHash("2".repeat(64)))?.id).toBe("d2");
    expect(await s.getDeviceByTokenHash("2".repeat(63))).toBeNull();
  });
});
