import { describe, expect, it } from "vitest";
import { buildTopList, damerauLevenshtein, defaultTopList, findConflation, findTyposquat, homoglyphFold, tokens } from "./index.js";

describe("damerauLevenshtein", () => {
  it.each([["express", "express", 0], ["expres", "express", 1], ["exrpess", "express", 1], ["lodahs", "lodash", 1], ["react", "preact", 1], ["abc", "xyz", 3]])("%s/%s=%i", (a, b, d) => {
    expect(damerauLevenshtein(a, b)).toBe(d);
  });
  it("early exit", () => expect(damerauLevenshtein("aaaaaaa", "bbbbbbb", 2)).toBe(3));
});

describe("names", () => {
  const top = buildTopList("npm", ["react", "express", "lodash", "mongoose", "jscodeshift", "react-dom", "axios", "@types/node"]);
  it("homoglyphs", () => {
    expect(homoglyphFold("rnongoose")).toBe(homoglyphFold("mongoose"));
    expect(findTyposquat("npm", "rnongoose", top)).toMatchObject({ of: "mongoose", homoglyph: true });
  });
  it("typosquats", () => {
    expect(findTyposquat("npm", "expresss", top)).toMatchObject({ of: "express", distance: 1 });
    expect(findTyposquat("npm", "lodahs", top)?.of).toBe("lodash");
    expect(findTyposquat("npm", "express", top)).toBeNull();
    expect(findTyposquat("npm", "totally-different", top)).toBeNull();
  });
  it("same name under another scope", () => {
    expect(findTyposquat("npm", "@evil/express", top)).toMatchObject({ of: "express", distance: 0 });
  });
  it("tokens", () => expect(tokens("@x/reactCodeShift_utils")).toEqual(["react", "code", "shift", "utils"]));
  it("conflation react-codeshift", () => {
    expect(findConflation("npm", "react-codeshift", top)).toEqual(["react", "jscodeshift"]);
    expect(findConflation("npm", "react-dom", top)).toBeNull();
  });
  it("real top lists load", () => {
    const npm = defaultTopList("npm");
    expect(npm.names.length).toBe(5000);
    expect(findTyposquat("npm", "reqeusts", defaultTopList("pypi"))?.of).toBe("requests");
    expect(findTyposquat("npm", "chalk", npm)).toBeNull();
  });
});
