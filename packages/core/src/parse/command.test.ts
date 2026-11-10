import { describe, expect, it } from "vitest";
import { parseInstallCommand, parsePackageJsonDeps, parseRequirementsTxt } from "./command.js";

const names = (cmd: string) => parseInstallCommand(cmd).flatMap((p) => p.targets.map((t) => `${t.ecosystem}:${t.name}${t.versionSpec ? "@" + t.versionSpec : ""}`));

describe("parseInstallCommand — npm family", () => {
  it.each([
    ["npm i react", ["npm:react"]],
    ["npm install a b@1.2.3 -D", ["npm:a", "npm:b@1.2.3"]],
    ["npm i @scope/pkg@^2 --save-exact", ["npm:@scope/pkg@^2"]],
    ["npm isntall lodash", ["npm:lodash"]],
    ["npm --prefix web install axios", ["npm:axios"]],
    ["npm i --registry http://localhost:4873/ color-fn-utils", ["npm:color-fn-utils"]],
    ["pnpm add zod", ["npm:zod"]],
    ["pnpm -w add -D vitest", ["npm:vitest"]],
    ["yarn add left-pad@1.3.0", ["npm:left-pad@1.3.0"]],
    ["bun add hono", ["npm:hono"]],
    ["npm i myalias@npm:real-pkg@1.0.0", ["npm:real-pkg@1.0.0"]],
    ["cd web && npm i foo && npm run build", ["npm:foo"]],
    ["FOO=1 sudo npm i -g bar", ["npm:bar"]],
    ["bash -c 'npm install evil-pkg'", ["npm:evil-pkg"]],
    ["echo hi; npm i x | tee log", ["npm:x"]],
  ])("%s", (cmd, expected) => {
    expect(names(cmd)).toEqual(expected);
  });

  it("classifies manifest installs", () => {
    expect(parseInstallCommand("npm ci")[0]?.kind).toBe("manifest");
    expect(parseInstallCommand("npm install")[0]?.kind).toBe("manifest");
    expect(parseInstallCommand("pnpm i")[0]?.kind).toBe("manifest");
    expect(parseInstallCommand("yarn")[0]?.kind).toBe("manifest");
  });

  it("classifies exec", () => {
    const p = parseInstallCommand("npx create-foo@latest my-app")[0];
    expect(p?.kind).toBe("exec");
    expect(p?.targets).toEqual([{ ecosystem: "npm", name: "create-foo", versionSpec: "latest" }]);
    expect(names("pnpm dlx shadcn init")).toEqual(["npm:shadcn"]);
    expect(names("npm exec --package=cowsay -- cowsay hi")).toEqual(["npm:cowsay"]);
  });

  it("records registry override and non-registry specs", () => {
    const p = parseInstallCommand("npm i --registry=https://evil.example/ github:user/repo ./local.tgz ok")[0]!;
    expect(p.registry).toBe("https://evil.example/");
    expect(p.nonRegistry).toEqual(["github:user/repo", "./local.tgz"]);
    expect(p.targets.map((t) => t.name)).toEqual(["ok"]);
  });

  it("ignores non-install commands", () => {
    expect(parseInstallCommand("npm run build && npm test && ls")).toEqual([]);
    expect(parseInstallCommand("echo 'npm i foo'")).toEqual([]);
  });
});

describe("parseInstallCommand — python family", () => {
  it.each([
    ["pip install requests", ["pypi:requests"]],
    ["pip3 install 'requests==2.31.0' flask>=2", ["pypi:requests@2.31.0", "pypi:flask@>=2"]],
    ["python -m pip install -U numpy", ["pypi:numpy"]],
    ["python3 -m pip install --index-url http://x/simple pkg", ["pypi:pkg"]],
    ["uv add httpx", ["pypi:httpx"]],
    ["uv pip install 'fastapi[standard]==0.115.0'", ["pypi:fastapi@0.115.0"]],
    ["poetry add pydantic", ["pypi:pydantic"]],
    ["uvx ruff check .", ["pypi:ruff"]],
    ["pipx install black", ["pypi:black"]],
  ])("%s", (cmd, expected) => {
    expect(names(cmd)).toEqual(expected);
  });

  it("captures requirement files", () => {
    const p = parseInstallCommand("pip install -r requirements.txt")[0]!;
    expect(p.kind).toBe("manifest");
    expect(p.requirementFiles).toEqual(["requirements.txt"]);
  });

  it("marks exec for uvx", () => {
    expect(parseInstallCommand("uvx huggingface-cli")[0]?.kind).toBe("exec");
  });
});

describe("manifests", () => {
  it("parses requirements.txt", () => {
    const r = parseRequirementsTxt("# c\nrequests==2.0\nflask>=2 ; python_version>'3.8'\n-r other.txt\n-e .\ngit+https://x/y.git\n");
    expect(r.targets).toEqual([
      { ecosystem: "pypi", name: "requests", versionSpec: "2.0" },
      { ecosystem: "pypi", name: "flask", versionSpec: ">=2" },
    ]);
    expect(r.includes).toEqual(["other.txt"]);
    expect(r.nonRegistry).toHaveLength(2);
  });
  it("parses package.json deps", () => {
    const r = parsePackageJsonDeps({ dependencies: { react: "^19.0.0", x: "github:a/b" }, devDependencies: { vitest: "4" } });
    expect(r.targets.map((t) => t.name)).toEqual(["react", "vitest"]);
    expect(r.nonRegistry).toEqual(["x@github:a/b"]);
  });
});
