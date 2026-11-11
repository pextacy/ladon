import { describe, expect, it } from "vitest";
import { agoLabel, daysAgo, exactVersionMissing, mmss, parsePage, plural } from "./format";

describe("exactVersionMissing", () => {
  it("flags an exact version the registry fell back from", () => {
    expect(exactVersionMissing("npm", "999.0.0", "4.18.1")).toBe(true);
    expect(exactVersionMissing("npm", "=1.2.3", "1.2.3")).toBe(false);
    expect(exactVersionMissing("npm", "v1.2.3", "1.2.3")).toBe(false);
    expect(exactVersionMissing("npm", "1.0.0-beta.1", "1.0.0")).toBe(true);
    expect(exactVersionMissing("pypi", "==9.9", "2.32.3")).toBe(true);
    expect(exactVersionMissing("pypi", "2.32.3", "2.32.3")).toBe(false);
  });
  it("ignores ranges, tags and missing data", () => {
    expect(exactVersionMissing("npm", "^4", "4.18.1")).toBe(false);
    expect(exactVersionMissing("npm", "4.17", "4.17.21")).toBe(false);
    expect(exactVersionMissing("npm", "next", "5.0.0")).toBe(false);
    expect(exactVersionMissing("pypi", ">=2", "2.32.3")).toBe(false);
    expect(exactVersionMissing("npm", undefined, "1.0.0")).toBe(false);
    expect(exactVersionMissing("npm", "1.0.0", null)).toBe(false);
  });
});

describe("parsePage / plural", () => {
  it("parses ?page= defensively", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("-1")).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("3")).toBe(3);
    expect(parsePage("99999999")).toBe(10_000);
  });
  it("pluralises", () => {
    expect(plural(1, "dependency", "dependencies")).toBe("1 dependency");
    expect(plural(2, "dependency", "dependencies")).toBe("2 dependencies");
    expect(plural(1200, "name")).toBe("1,200 names");
  });
});

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
