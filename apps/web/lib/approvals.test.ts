import { passkeyChallenge } from "@ladon/core";
import { describe, expect, it } from "vitest";
import { canDecide, challengeFor, effectiveStatus, newApprovalRecord, publicView, refreshStatus, validateExpiry, waitForApproval, waitView } from "./approvals";
import { MemoryStore } from "./store/memory";

const body = { id: "abcd1234", commandHash: "a".repeat(64), nonce: "b".repeat(32), exp: 1000, ecosystem: "npm" as const, package: "color-fn-utils", version: "1.0.2", score: 85, reasons: ["2 days old"] };

describe("approval state machine", () => {
  it("validates expiry window", () => {
    expect(validateExpiry(999, 1000)).toMatch(/past/);
    expect(validateExpiry(1000, 1000)).toMatch(/past/);
    expect(validateExpiry(1120, 1000)).toBeNull();
    expect(validateExpiry(1000 + 16 * 60, 1000)).toMatch(/minutes/);
  });

  it("pending becomes expired after exp; terminal states stay", () => {
    const a = newApprovalRecord(body, "d1", "t");
    expect(effectiveStatus(a, 1000)).toBe("pending");
    expect(effectiveStatus(a, 1001)).toBe("expired");
    expect(effectiveStatus({ ...a, status: "approved" }, 5000)).toBe("approved");
  });

  it("canDecide blocks expired and decided requests", () => {
    const a = newApprovalRecord(body, "d1", "t");
    expect(canDecide(a, 999).ok).toBe(true);
    const exp = canDecide(a, 1001);
    expect(exp.ok === false && exp.status).toBe(410);
    const done = canDecide({ ...a, status: "rejected" }, 999);
    expect(done.ok === false && done.status).toBe(409);
  });

  it("challenge binds the decision, matching core", () => {
    const a = newApprovalRecord(body, "d1", "t");
    expect(challengeFor(a, "approve")).toBe(passkeyChallenge({ id: a.id, h: a.commandHash, n: a.nonce, exp: a.exp }, "approve"));
    expect(challengeFor(a, "approve")).not.toBe(challengeFor(a, "reject"));
    expect(Buffer.from(challengeFor(a, "reject"), "base64url").toString()).toBe(`ladon:v1|abcd1234|${"a".repeat(64)}|${"b".repeat(32)}|1000|reject`);
  });

  it("refreshStatus persists expiry and the public view hides secrets", async () => {
    const s = new MemoryStore();
    await s.createApproval(newApprovalRecord(body, "d1", "t"));
    const a = await refreshStatus(s, (await s.getApproval("abcd1234"))!, 2000);
    expect(a.status).toBe("expired");
    expect((await s.getApproval("abcd1234"))?.status).toBe("expired");
    const v = publicView(a, 2000);
    expect(v).not.toHaveProperty("nonce");
    expect(v).not.toHaveProperty("commandHash");
    expect(v).not.toHaveProperty("deviceId");
    // can't approve after expiry even via the store
    expect(await s.transitionApproval("abcd1234", { status: "approved" })).toBe(false);
  });

  it("waitView exposes the assertion only after a decision", () => {
    const a = newApprovalRecord({ ...body, exp: 5000 }, "d1", "t");
    expect(waitView(a, 1000)).toEqual({ status: "pending" });
    expect(waitView({ ...a, status: "approved", decision: "approve", assertion: { id: "c1" } }, 1000)).toEqual({ status: "approved", decision: "approve", assertion: { id: "c1" } });
  });

  it("long-poll returns pending at timeout, or as soon as it is decided", async () => {
    const s = new MemoryStore();
    let t = 1_000_000;
    await s.createApproval(newApprovalRecord({ ...body, exp: 1_000_000 / 1000 + 120 }, "d1", "t"));
    const opts = { now: () => t, pollMs: 100, sleep: async (ms: number) => void (t += ms) };
    const pending = await waitForApproval(s, "abcd1234", 1000, opts);
    expect(pending?.status).toBe("pending");
    expect(t - 1_000_000).toBeGreaterThanOrEqual(1000);

    let polls = 0;
    const decided = await waitForApproval(s, "abcd1234", 10_000, {
      ...opts,
      sleep: async (ms) => {
        t += ms;
        if (++polls === 3) await s.transitionApproval("abcd1234", { status: "rejected", decision: "reject" });
      },
    });
    expect(decided?.status).toBe("rejected");
    expect(polls).toBe(3);
    expect(await waitForApproval(s, "missing", 1000, opts)).toBeNull();
  });

  it("long-poll reports expiry", async () => {
    const s = new MemoryStore();
    let t = 1_000_000;
    await s.createApproval(newApprovalRecord({ ...body, exp: 1001 }, "d1", "t"));
    const r = await waitForApproval(s, "abcd1234", 5000, { now: () => t, pollMs: 500, sleep: async (ms) => void (t += ms) });
    expect(r?.status).toBe("expired");
  });
});
