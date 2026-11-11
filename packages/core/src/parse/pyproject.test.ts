import { describe, expect, it } from "vitest";
import { parsePipfileDeps, parsePyprojectDeps } from "./pyproject.js";

describe("pyproject / Pipfile deps", () => {
  it("reads PEP 621, optional deps, groups and build-system", () => {
    const r = parsePyprojectDeps(`
[build-system]
requires = ["hatchling>=1.20"]  # build
[project]
name = "x"
dependencies = [
  "requests>=2.31",
  "fastapi[all]==0.110.0",  # comment, with "quotes"
  "pkg @ git+https://example.com/pkg.git",
]
[project.optional-dependencies]
dev = ["pytest"]
[dependency-groups]
lint = ["ruff==0.5.0"]
`);
    expect(r.targets.map((t) => `${t.name}${t.versionSpec ? " " + t.versionSpec : ""}`)).toEqual([
      "hatchling >=1.20",
      "requests >=2.31",
      "fastapi 0.110.0",
      "pytest",
      "ruff 0.5.0",
    ]);
    expect(r.nonRegistry).toHaveLength(1);
  });

  it("reads poetry tables", () => {
    const r = parsePyprojectDeps(`
[tool.poetry.dependencies]
python = "^3.11"
django = "^5.0"
numpy = "1.26.4"
local = { path = "../local" }
rich = { version = ">=13", extras = ["x"] }
[tool.poetry.group.dev.dependencies]
black = "*"
`);
    expect(r.targets.map((t) => t.name)).toEqual(["django", "numpy", "rich", "black"]);
    expect(r.targets.find((t) => t.name === "numpy")?.versionSpec).toBe("1.26.4");
    expect(r.nonRegistry).toEqual(["local (../local)"]);
  });

  it("reads Pipfile", () => {
    const r = parsePipfileDeps(`[[source]]\nurl = "https://pypi.org/simple"\n[packages]\nflask = "*"\nrequests = "==2.31.0"\n[dev-packages]\npytest = ">=8"\n`);
    expect(r.targets.map((t) => [t.name, t.versionSpec])).toEqual([["flask", undefined], ["requests", "2.31.0"], ["pytest", ">=8"]]);
  });
});
