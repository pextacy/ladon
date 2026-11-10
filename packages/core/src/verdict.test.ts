import { describe, expect, it } from "vitest";
import { clampScore, verdictForScore } from "./verdict.js";

describe("verdictForScore", () => {
  it.each([
    [0, "allow"], [29, "allow"], [30, "warn"], [59, "warn"], [60, "hold"], [100, "hold"], [250, "hold"],
  ] as const)("score %i → %s", (score, expected) => {
    expect(verdictForScore(score)).toBe(expected);
  });

  it("fails closed on NaN", () => {
    expect(clampScore(Number.NaN)).toBe(100);
    expect(verdictForScore(Number.NaN)).toBe("hold");
  });
});
