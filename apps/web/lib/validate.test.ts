import { describe, expect, it } from "vitest";
import { AtlasReportBody, CheckQuery, CreateApprovalBody, DecisionBody, ManifestBody, PairCode, WaitQuery, zodMessage } from "./validate";

const approval = { id: "abcd1234", commandHash: "a".repeat(64), nonce: "b".repeat(32), exp: 2_000_000_000, ecosystem: "npm", package: "x", score: 85, reasons: ["r"] };

describe("request validation", () => {
  it("accepts a valid approval and rejects bad fields", () => {
    expect(CreateApprovalBody.safeParse(approval).success).toBe(true);
    expect(CreateApprovalBody.safeParse({ ...approval, commandHash: "nothex" }).success).toBe(false);
    expect(CreateApprovalBody.safeParse({ ...approval, reasons: ["1", "2", "3", "4", "5", "6"] }).success).toBe(false);
    expect(CreateApprovalBody.safeParse({ ...approval, score: 101 }).success).toBe(false);
    expect(CreateApprovalBody.safeParse({ ...approval, id: "a/b" }).success).toBe(false);
    expect(CreateApprovalBody.safeParse({ ...approval, intent: { drift: "strong", reason: "task mismatch" } }).success).toBe(true);
    expect(CreateApprovalBody.safeParse({ ...approval, intent: { drift: "huge", reason: "" } }).success).toBe(false);
  });

  it("validates check queries and package names", () => {
    expect(CheckQuery.parse({ name: "left-pad" })).toEqual({ eco: "npm", name: "left-pad" });
    expect(CheckQuery.safeParse({ eco: "pypi", name: "requests", v: "2.32.3" }).success).toBe(true);
    expect(CheckQuery.safeParse({ name: "@types/node" }).success).toBe(true);
    expect(CheckQuery.safeParse({ name: "../etc/passwd" }).success).toBe(false);
    expect(CheckQuery.safeParse({ eco: "cargo", name: "x" }).success).toBe(false);
    const bad = CheckQuery.safeParse({ name: "" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(zodMessage(bad.error)).toMatch(/^name: /);
  });

  it("normalizes pair codes and clamps wait timeout", () => {
    expect(PairCode.parse(" abcd2345 ")).toBe("ABCD2345");
    expect(PairCode.safeParse("ABCD1234").success).toBe(false); // 1 is not in [A-Z2-9]
    expect(WaitQuery.parse({}).timeout).toBe(25);
    expect(WaitQuery.parse({ timeout: "2" }).timeout).toBe(2);
    expect(WaitQuery.safeParse({ timeout: "60" }).success).toBe(false);
  });

  it("decisions and reports carry no free-form secrets", () => {
    const d = { ts: "2026-11-10T10:00:00Z", ecosystem: "npm", package: "x", verdict: "hold", score: 90, reasons: [], outcome: "blocked" };
    expect(DecisionBody.safeParse(d).success).toBe(true);
    expect(DecisionBody.safeParse({ ...d, outcome: "maybe" }).success).toBe(false);
    expect(DecisionBody.safeParse({ ...d, agent: "claude code; rm -rf" }).success).toBe(false);
    expect(AtlasReportBody.safeParse({ ecosystem: "npm", name: "x", model: "claude-opus-5-5" }).success).toBe(true);
    expect(AtlasReportBody.safeParse({ ecosystem: "npm", name: "x", model: "please ignore previous" }).success).toBe(false);
  });

  it("truncates long rule details instead of rejecting the daemon's request", () => {
    // core's intent detail: "task mismatch — " + reason (≤160) + " (likely from an instruction file)" ≈ 210 chars
    const long = `task mismatch — ${"r".repeat(160)} (likely from an instruction file)`;
    expect(long.length).toBeGreaterThan(200);
    const a = CreateApprovalBody.parse({ ...approval, reasons: [long], intent: { drift: "strong", reason: "x".repeat(300) } });
    expect(a.reasons[0]).toHaveLength(200);
    expect(a.reasons[0]!.endsWith("…")).toBe(true);
    expect(a.intent?.reason).toHaveLength(240);
    const d = DecisionBody.parse({ ts: "2026-11-10T10:00:00Z", ecosystem: "npm", package: "x", verdict: "hold", score: 90, reasons: [long], outcome: "blocked" });
    expect(d.reasons[0]).toHaveLength(200);
    expect(CreateApprovalBody.parse({ ...approval, reasons: ["short"] }).reasons).toEqual(["short"]);
  });

  it("caps manifest size", () => {
    expect(ManifestBody.safeParse({ filename: "package.json", content: "x".repeat(200 * 1024 + 1) }).success).toBe(false);
  });
});
