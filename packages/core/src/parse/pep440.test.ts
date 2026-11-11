import { describe, expect, it } from "vitest";
import { comparePep440, maxSatisfyingPep440, parsePep440, parsePep440Specifier, satisfiesPep440 } from "./pep440.js";

const sat = (v: string, spec: string) => satisfiesPep440(v, parsePep440Specifier(spec)!);
const cmp = (a: string, b: string) => comparePep440(parsePep440(a)!, parsePep440(b)!);

describe("PEP 440 versions", () => {
  it("parses and normalises", () => {
    expect(parsePep440("1!2.0.post1")).toMatchObject({ epoch: 1, release: [2, 0], post: 1 });
    expect(parsePep440("1.0-alpha2")).toMatchObject({ pre: ["a", 2] });
    expect(parsePep440("1.0c1")).toMatchObject({ pre: ["rc", 1] });
    expect(parsePep440("1.0-3")).toMatchObject({ post: 3 });
    expect(parsePep440("v1.0.dev")).toMatchObject({ dev: 0 });
    expect(parsePep440("1.0+ubuntu.1")).toMatchObject({ local: ["ubuntu", 1] });
    expect(parsePep440("not-a-version")).toBeNull();
  });
  it("orders per the spec", () => {
    const sorted = ["1.0.dev1", "1.0a1.dev1", "1.0a1", "1.0b2", "1.0rc1", "1.0", "1.0+local", "1.0.post1.dev1", "1.0.post1", "1.1"];
    const shuffled = [...sorted].reverse();
    expect(shuffled.sort(cmp)).toEqual(sorted);
    expect(cmp("1.0", "1.0.0")).toBe(0);
    expect(cmp("1!0.1", "2.0")).toBe(1);
  });
});

describe("PEP 440 specifiers", () => {
  it("comparison operators", () => {
    expect(sat("2.5", ">=2,<3")).toBe(true);
    expect(sat("3.0", ">=2,<3")).toBe(false);
    expect(sat("2.0", "<=2.0")).toBe(true);
    expect(sat("2.0.1", ">2.0")).toBe(true);
    expect(sat("1.5", "!=1.5")).toBe(false);
  });
  it("exclusive bounds ignore pre/post/local of the bound", () => {
    expect(satisfiesPep440("3.0a1", parsePep440Specifier("<3.0")!, true)).toBe(false);
    expect(sat("1.7.post1", ">1.7")).toBe(false);
    expect(sat("1.7.1", ">1.7")).toBe(true);
    expect(sat("1.7+local", ">1.7")).toBe(false);
  });
  it("== matches with zero padding and ignores candidate local", () => {
    expect(sat("1.0.0", "==1.0")).toBe(true);
    expect(sat("1.0+cpu", "==1.0")).toBe(true);
    expect(sat("1.0+cpu", "==1.0+gpu")).toBe(false);
  });
  it("wildcards", () => {
    expect(sat("1.2.9", "==1.2.*")).toBe(true);
    expect(sat("1.3", "==1.2.*")).toBe(false);
    expect(sat("1.2", "1.2.*")).toBe(true);
    expect(sat("1.2.3", "!=1.2.*")).toBe(false);
    expect(parsePep440Specifier(">=1.*")).toBeNull();
  });
  it("compatible release ~=", () => {
    expect(sat("2.2.5", "~=2.2")).toBe(true);
    expect(sat("3.0", "~=2.2")).toBe(false);
    expect(sat("1.4.9", "~=1.4.5")).toBe(true);
    expect(sat("1.5.0", "~=1.4.5")).toBe(false);
    expect(sat("1.4.4", "~=1.4.5")).toBe(false);
    expect(parsePep440Specifier("~=1")).toBeNull();
  });
  it("arbitrary equality ===", () => {
    expect(sat("1.0-custom", "===1.0-custom")).toBe(true);
    expect(sat("1.0", "===1.0.0")).toBe(false);
  });
  it("bare version means ==", () => {
    expect(sat("2.0", "2.0")).toBe(true);
    expect(sat("2.1", "2.0")).toBe(false);
  });
});

describe("maxSatisfyingPep440", () => {
  const vs = ["1.0", "1.1", "1.2rc1", "1.9", "2.0", "2.1.dev3", "2.0.post1", "3.0a1"];
  it("picks the highest final release", () => {
    expect(maxSatisfyingPep440(vs, ">=1.0")).toBe("2.0.post1");
    expect(maxSatisfyingPep440(vs, ">=1,<2")).toBe("1.9");
    expect(maxSatisfyingPep440(vs, "~=1.0")).toBe("1.9");
    expect(maxSatisfyingPep440(vs, "==1.*,!=1.9")).toBe("1.1");
  });
  it("includes pre-releases only when the spec names one, or nothing else matches", () => {
    expect(maxSatisfyingPep440(vs, ">=3.0a1")).toBe("3.0a1");
    expect(maxSatisfyingPep440(vs, ">=1.2rc1,<1.5")).toBe("1.2rc1");
    expect(maxSatisfyingPep440(vs, ">2.0.post1")).toBe("3.0a1");
  });
  it("no match / invalid spec", () => {
    expect(maxSatisfyingPep440(vs, ">=9")).toBeUndefined();
    expect(maxSatisfyingPep440(vs, "^1.0")).toBeUndefined();
  });
});
