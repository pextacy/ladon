import { describe, expect, it } from "vitest";
import { manifestKind, parseManifest } from "./manifest";

describe("manifest parsing", () => {
  it("detects file kinds", () => {
    expect(manifestKind("package.json")).toBe("package.json");
    expect(manifestKind("app/Package.JSON")).toBe("package.json");
    expect(manifestKind("requirements-dev.txt")).toBe("requirements.txt");
    expect(manifestKind("pyproject.toml")).toBeNull();
  });

  it("parses package.json deps and skips non-registry ones", () => {
    const r = parseManifest("package.json", JSON.stringify({ dependencies: { express: "^4.19.0", local: "file:../x" }, devDependencies: { vitest: "^4.0.0" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets.map((t) => t.name).sort()).toEqual(["express", "vitest"]);
    expect(r.skipped.join()).toMatch(/local@file/);
  });

  it("parses requirements.txt, dedupes PEP 503 names, notes includes", () => {
    const r = parseManifest("requirements.txt", "requests==2.32.3\nFlask>=3\nflask\n-r other.txt\n# comment\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toHaveLength(2);
    expect(r.skipped.join()).toMatch(/other\.txt/);
  });

  it("enforces limits and explains errors", () => {
    const many = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`pkg-${i}`, "^1.0.0"]));
    const r = parseManifest("package.json", JSON.stringify({ dependencies: many }));
    expect(r.ok === false && r.error).toMatch(/61 dependencies.*at most 60/);
    expect(parseManifest("package.json", "{not json").ok).toBe(false);
    expect(parseManifest("package.json", "[]").ok).toBe(false);
    expect(parseManifest("package.json", "{}").ok).toBe(false);
    expect(parseManifest("Cargo.toml", "x").ok).toBe(false);
    expect(parseManifest("requirements.txt", "x\n".repeat(110 * 1024)).ok).toBe(false);
  });
});
