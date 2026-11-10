import { describe, expect, it } from "vitest";
import { extractNames, normalizeName } from "./extract";

describe("probe name extraction", () => {
  it("normalizes npm names, strips versions/commands, drops builtins", () => {
    expect(normalizeName("npm", "Express@4.19.0")).toBe("express");
    expect(normalizeName("npm", "@tanstack/react-query@^5")).toBe("@tanstack/react-query");
    expect(normalizeName("npm", "npm install -D vitest")).toBe("vitest");
    expect(normalizeName("npm", "`zod`")).toBe("zod");
    expect(normalizeName("npm", "fs")).toBeNull();
    expect(normalizeName("npm", "node:crypto")).toBeNull();
    expect(normalizeName("npm", "not a/package!")).toBeNull();
  });

  it("normalizes PyPI names (PEP 503), strips extras/specifiers, drops stdlib", () => {
    expect(normalizeName("pypi", "Flask_Login>=0.6")).toBe("flask-login");
    expect(normalizeName("pypi", "uvicorn[standard]")).toBe("uvicorn");
    expect(normalizeName("pypi", "pip install requests==2.32.3")).toBe("requests");
    expect(normalizeName("pypi", "json")).toBeNull();
    expect(normalizeName("pypi", "asyncio")).toBeNull();
  });

  it("validates model output and dedupes", () => {
    const out = { packages: [{ ecosystem: "npm", name: "zod" }, { ecosystem: "npm", name: "ZOD" }, { ecosystem: "pypi", name: "Requests" }, { ecosystem: "npm", name: "path" }] };
    expect(extractNames(out)).toEqual([
      { ecosystem: "npm", name: "zod" },
      { ecosystem: "pypi", name: "requests" },
    ]);
    expect(extractNames({ packages: [{ ecosystem: "cargo", name: "serde" }] })).toEqual([]);
    expect(extractNames("garbage")).toEqual([]);
    expect(extractNames(null)).toEqual([]);
  });
});
