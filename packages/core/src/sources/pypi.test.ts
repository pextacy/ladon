import { describe, expect, it } from "vitest";
import { resolvePypiVersion, type PypiPackageInfo } from "./pypi.js";

const rel = (version: string) => ({ version, hasWheel: true });
const info: PypiPackageInfo = {
  name: "requests",
  latest: "2.32.3",
  releases: Object.fromEntries(["2.0.0", "2.28.2", "2.31.0", "2.32.3", "3.0.0b1"].map((v) => [v, rel(v)])),
};

describe("resolvePypiVersion (PEP 440)", () => {
  it("exact, range, wildcard, compatible release", () => {
    expect(resolvePypiVersion(info, undefined)).toBe("2.32.3");
    expect(resolvePypiVersion(info, "2.31.0")).toBe("2.31.0");
    expect(resolvePypiVersion(info, "2.0")).toBe("2.0.0");
    expect(resolvePypiVersion(info, ">=2,<2.30")).toBe("2.28.2");
    expect(resolvePypiVersion(info, "==2.31.*")).toBe("2.31.0");
    expect(resolvePypiVersion(info, "~=2.28")).toBe("2.32.3");
    expect(resolvePypiVersion(info, ">=3.0.0b1")).toBe("3.0.0b1");
    expect(resolvePypiVersion(info, ">2.32.3")).toBe("3.0.0b1");
  });
  it("no match → undefined; non-PEP 440 spec → latest", () => {
    expect(resolvePypiVersion(info, ">=4")).toBeUndefined();
    expect(resolvePypiVersion(info, "^2.0")).toBe("2.32.3");
  });
});
