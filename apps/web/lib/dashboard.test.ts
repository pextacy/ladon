import { describe, expect, it } from "vitest";
import { loadDashboard } from "./dashboard";
import { MemoryStore } from "./store/memory";

const pk = (credentialId: string, deviceId: string) => ({ credentialId, deviceId, publicKey: "pk", counter: 0, label: "phone", transports: [], createdAt: "2026-11-10T00:00:00.000Z" });
const decision = (id: string, deviceId: string) => ({
  id, deviceId, ts: "2026-11-10T00:00:00.000Z", ecosystem: "npm" as const, package: "x", version: null, verdict: "hold" as const, score: 90, reasons: [],
  outcome: "blocked" as const, via: null, agent: null, createdAt: "2026-11-10T00:00:00.000Z",
});

describe("dashboard scoping", () => {
  it("shows only the signed-in passkey's device, and drops sessions whose passkey is gone or moved", async () => {
    const s = new MemoryStore();
    await s.createDevice({ id: "d1", label: "laptop", tokenHash: "h1", createdAt: "x" });
    await s.createDevice({ id: "d2", label: "other", tokenHash: "h2", createdAt: "x" });
    await s.addPasskey(pk("c1", "d1"));
    await s.addPasskey(pk("c2", "d2"));
    await s.addDecision(decision("1", "d1"));
    await s.addDecision(decision("2", "d2"));

    const mine = await loadDashboard(s, { d: "d1", c: "c1", exp: 0 });
    expect(mine?.device?.label).toBe("laptop");
    expect(mine?.decisions.map((d) => d.id)).toEqual(["1"]);
    expect(mine?.passkeys.map((p) => p.credentialId)).toEqual(["c1"]);

    expect(await loadDashboard(s, { d: "d2", c: "c1", exp: 0 })).toBeNull(); // passkey belongs to d1
    expect(await loadDashboard(s, { d: "d1", c: "gone", exp: 0 })).toBeNull();
  });
});
