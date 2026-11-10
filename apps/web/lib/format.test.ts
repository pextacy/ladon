import { describe, expect, it } from "vitest";
import { agoLabel, daysAgo, mmss } from "./format";

describe("format", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  it("days ago", () => {
    expect(daysAgo("2026-11-07T12:00:00Z", now)).toBe(3);
    expect(agoLabel("2026-11-07T12:00:00Z", now)).toBe("3 days ago");
    expect(agoLabel("2026-11-10T01:00:00Z", now)).toBe("today");
    expect(agoLabel(null, now)).toBe("unknown");
  });
  it("countdown", () => {
    expect(mmss(125)).toBe("2:05");
    expect(mmss(-3)).toBe("0:00");
  });
});
