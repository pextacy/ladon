import { describe, expect, it } from "vitest";
import { overall, probeDb } from "./health";

describe("health", () => {
  it("db is not_configured without env", async () => {
    expect(await probeDb({})).toEqual({ status: "not_configured" });
  });
  it("overall is degraded only when something is down", () => {
    expect(overall({ a: { status: "ok" }, b: { status: "not_configured" } })).toBe("ok");
    expect(overall({ a: { status: "ok" }, b: { status: "down" } })).toBe("degraded");
  });
});
