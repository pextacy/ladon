import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTopList, parseInstallCommand, type CheckDeps, type IntentInput, type NpmPackageInfo } from "@ladon/core";
import type { Approver } from "./approve/types.js";
import type { SlimResult } from "./daemon.js";
import { firstVisitScan, formatDirNotice, markScanned } from "./firstscan.js";
import { gate, loadLockfiles, targetsFor } from "./gate.js";
import { codexCommandString, handleCodexPreToolUse, handleCursorBeforeShell, handleCursorBeforeSubmitPrompt } from "./hook.js";
import { codexHooksDisabled, CODEX_MATCHER, installCodexHooks, installCursorHooks } from "./init.js";
import { pruneSessions, recordPrompt, recordStep, sessionContext, sessionFile, sessionsDir } from "./sessions.js";
import { pythonShimScript } from "./shim.js";

const NOW = new Date();
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const pk = (name: string, created: string): NpmPackageInfo => ({
  name,
  created,
  distTags: { latest: "1.0.0" },
  versions: { "1.0.0": { version: "1.0.0", time: created, maintainers: ["m"], provenance: false, scripts: {}, gypfile: false, repositoryUrl: `https://github.com/x/${name}` } },
});
const registry: Record<string, NpmPackageInfo> = { react: pk("react", ago(4000)), "mid-pkg": pk("mid-pkg", ago(5)) };
const fakeDeps = (): CheckDeps => ({
  npm: { packument: async (n) => registry[n] ?? null, weeklyDownloads: async (n) => (n === "react" ? 5e7 : 0), tarball: async () => null },
  pypi: { project: async () => null, weeklyDownloads: async () => 0, sdist: async () => null },
  osv: { query: async () => ({ malicious: [], vulns: [] }) },
  topLists: { npm: buildTopList("npm", ["react"]), pypi: buildTopList("pypi", ["requests"]) },
});
const noApprover: Approver = { via: "key", ready: async () => ({ ok: false, detail: "not paired" }), request: async () => ({ kind: "timeout", detail: "t" }) };
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const names = (cmd: string, cwd: string) => {
  const p = parseInstallCommand(cmd)[0]!;
  const r = targetsFor(p, cwd, loadLockfiles(cwd));
  return { targets: r.targets.map((t) => t.name).sort(), unverifiable: r.unverifiable };
};

const PYPROJECT = `[project]
name = "app"
dependencies = ["requests>=2", "flask==3.0.0", "brand-new-thing"]
[project.optional-dependencies]
dev = ["pytest"]
`;

describe("Python project installs (feature 5)", () => {
  it("uv sync checks pyproject deps not pinned in uv.lock", () => {
    const d = tmp("ladon-uv-");
    writeFileSync(join(d, "pyproject.toml"), PYPROJECT);
    writeFileSync(join(d, "uv.lock"), `[[package]]\nname = "requests"\nversion = "2.32.0"\n\n[[package]]\nname = "Flask"\nversion = "3.0.0"\n\n[[package]]\nname = "pytest"\nversion = "8.0.0"\n`);
    expect(names("uv sync", d).targets).toEqual(["brand-new-thing"]);
  });
  it("uv sync without a lock checks every dependency, found upward from a subdirectory", () => {
    const d = tmp("ladon-uv2-");
    writeFileSync(join(d, "pyproject.toml"), PYPROJECT);
    mkdirSync(join(d, ".git"));
    mkdirSync(join(d, "src"));
    expect(names("uv sync", join(d, "src")).targets).toEqual(["brand-new-thing", "flask", "pytest", "requests"]);
  });
  it("poetry install reads [tool.poetry.dependencies] minus poetry.lock", () => {
    const d = tmp("ladon-poetry-");
    writeFileSync(join(d, "pyproject.toml"), `[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.31"\nreqeusts = "*"\nlocal = { path = "../local" }\n`);
    writeFileSync(join(d, "poetry.lock"), `[[package]]\nname = "requests"\nversion = "2.31.0"\n`);
    const r = names("poetry install", d);
    expect(r.targets).toEqual(["reqeusts"]);
    expect(r.unverifiable.join()).toContain("../local");
  });
  it("pipenv install reads Pipfile minus Pipfile.lock", () => {
    const d = tmp("ladon-pipenv-");
    writeFileSync(join(d, "Pipfile"), `[packages]\nrequests = "*"\nnew-one = "==1.0"\n[dev-packages]\npytest = "*"\n`);
    writeFileSync(join(d, "Pipfile.lock"), JSON.stringify({ _meta: {}, default: { requests: { version: "==2.32.0" } }, develop: { pytest: { version: "==8.0.0" } } }));
    expect(names("pipenv install", d).targets).toEqual(["new-one"]);
    expect(names("pipenv sync", d).targets).toEqual(["new-one"]);
    expect(loadLockfiles(d).versions("pypi", "requests")).toEqual(["2.32.0"]);
  });
  it("uv pip install -r pyproject.toml checks all deps (the lock is not used)", () => {
    const d = tmp("ladon-uvpip-");
    writeFileSync(join(d, "pyproject.toml"), PYPROJECT);
    writeFileSync(join(d, "uv.lock"), `[[package]]\nname = "requests"\nversion = "2.32.0"\n`);
    expect(names("uv pip install -r pyproject.toml", d).targets).toEqual(["brand-new-thing", "flask", "pytest", "requests"]);
  });
  it("pip install . / -e . read the local project's pyproject.toml", () => {
    const d = tmp("ladon-local-");
    writeFileSync(join(d, "pyproject.toml"), PYPROJECT);
    expect(names("pip install .", d).targets).toContain("brand-new-thing");
    expect(names("pip install -e '.[dev]'", d).targets).toContain("pytest");
    expect(names("pip install -e .", d).unverifiable).toEqual([]);
  });
  it("a setup.py-only project is reported as not checkable", () => {
    const d = tmp("ladon-setup-");
    writeFileSync(join(d, "setup.py"), "from setuptools import setup\nsetup()\n");
    expect(names("pip install .", d).unverifiable[0]).toContain("setup.py");
  });
  it("gate holds a pyproject dependency that does not exist (fail closed, no approver)", async () => {
    const d = tmp("ladon-gatepy-");
    writeFileSync(join(d, "pyproject.toml"), `[project]\ndependencies = ["definitely-not-real-xyz"]\n`);
    const r = await gate({ command: "uv sync", cwd: d }, { approvers: [noApprover], deps: fakeDeps });
    expect(r.decision).toBe("deny");
    expect(r.reports.map((x) => x.target.name)).toContain("definitely-not-real-xyz");
  });
});

describe("intent context (features 6 + 7)", () => {
  it("explicit userRequest/recentAgentSteps feed the intent judge", async () => {
    const seen: IntentInput[] = [];
    const r = await gate(
      { command: "npm i mid-pkg", cwd: tmp("ladon-i-"), userRequest: "make the navbar sticky", recentAgentSteps: ["bash: cat AGENTS.md"] },
      { approvers: [noApprover], deps: fakeDeps, intent: async (i) => (seen.push(i), { drift: "strong", reason: "navbar doesn't need it", suspectedSource: "instruction_file" }) },
    );
    expect(seen[0]?.userRequest).toBe("make the navbar sticky");
    expect(seen[0]?.recentAgentSteps).toEqual(["bash: cat AGENTS.md"]);
    expect(r.verdict).toBe("hold");
  });
  it("a Codex rollout transcript is parsed for the judge", async () => {
    const d = tmp("ladon-cx-");
    const t = join(d, "rollout.jsonl");
    writeFileSync(t, readFileSync(new URL("../../core/src/ai/__fixtures__/codex-rollout.jsonl", import.meta.url), "utf8"));
    const seen: IntentInput[] = [];
    await gate({ command: "npm i mid-pkg", cwd: d, transcriptPath: t, agent: "codex" }, { approvers: [noApprover], deps: fakeDeps, intent: async (i) => (seen.push(i), null) });
    expect(seen[0]?.userRequest).toBe("make the navbar sticky");
    expect(seen[0]?.recentAgentSteps).toContain("bash: cat AGENTS.md");
  });
});

describe("Cursor prompt memory (feature 6)", () => {
  it("stores prompts 0600, keeps the last few, tracks steps since the last prompt", () => {
    for (let i = 0; i < 7; i++) recordPrompt("conv-1", `prompt ${i}`);
    recordStep("conv-1", "bash: ls");
    const f = sessionFile("conv-1");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect((JSON.parse(readFileSync(f, "utf8")) as { prompts: unknown[] }).prompts).toHaveLength(5);
    expect(sessionContext("conv-1")).toEqual({ userRequest: "prompt 6", recentAgentSteps: ["bash: ls"] });
    recordPrompt("conv-1", "next task");
    expect(sessionContext("conv-1")?.recentAgentSteps).toEqual([]);
  });
  it("conversation ids cannot escape the sessions directory", () => {
    expect(sessionFile("../../etc/passwd").startsWith(sessionsDir() + "/")).toBe(true);
    expect(sessionFile("../../etc/passwd")).not.toContain("..");
  });
  it("expires after 24 h and prunes old files", () => {
    recordPrompt("old-conv", "hi", Date.now() - 25 * 3_600_000);
    expect(sessionContext("old-conv")).toBeNull();
    const f = sessionFile("old-conv");
    const old = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(f, old, old);
    pruneSessions();
    expect(existsSync(f)).toBe(false);
  });
  it("beforeSubmitPrompt never blocks; beforeShellExecution passes the stored prompt to the gate", async () => {
    expect(JSON.parse(handleCursorBeforeSubmitPrompt(JSON.stringify({ conversation_id: "c-2", prompt: "fix the footer", hook_event_name: "beforeSubmitPrompt" })).stdout)).toEqual({ continue: true });
    expect(JSON.parse(handleCursorBeforeSubmitPrompt("garbage").stdout)).toEqual({ continue: true });
    let got: Parameters<typeof gate>[0] | undefined;
    const gateFn = async (i: Parameters<typeof gate>[0]): Promise<SlimResult> => {
      got = i;
      return { decision: "deny", verdict: "hold", outcome: "blocked", display: "■ HOLD x", agentText: "blocked", durationMs: 1, approval: undefined, reports: [] };
    };
    const o = await handleCursorBeforeShell(JSON.stringify({ conversation_id: "c-2", command: "npm i mid-pkg", cwd: "/tmp" }), gateFn);
    expect(JSON.parse(o.stdout)).toMatchObject({ permission: "deny", agentMessage: "blocked" });
    expect(got).toMatchObject({ agent: "cursor", userRequest: "fix the footer" });
  });
});

const slim = (o: Partial<SlimResult>): SlimResult => ({ decision: "allow", verdict: "allow", outcome: "allowed", display: "", agentText: "", durationMs: 1, approval: undefined, reports: [], ...o });

describe("Codex PreToolUse hook (feature 1)", () => {
  const ev = (tool_name: string, tool_input: unknown) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: "/tmp", transcript_path: null, session_id: "s", model: "gpt-5" });
  it("denies a held install with JSON + exit code 2 + stderr", async () => {
    let cmd = "";
    const o = await handleCodexPreToolUse(ev("Bash", { command: "npm i evil" }), async (i) => ((cmd = i.command), slim({ decision: "deny", verdict: "hold", outcome: "blocked", display: "■ HOLD evil", agentText: "Do not retry" })));
    expect(cmd).toBe("npm i evil");
    expect(o.code).toBe(2);
    expect(o.stderr).toContain("Do not retry");
    expect(JSON.parse(o.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Do not retry" } });
  });
  it("accepts argv arrays, shell/exec_command names and the cmd field", async () => {
    const seen: string[] = [];
    const gateFn = async (i: { command: string }) => (seen.push(i.command), slim({}));
    await handleCodexPreToolUse(ev("shell", { command: ["bash", "-lc", "pip install requests"] }), gateFn);
    await handleCodexPreToolUse(ev("exec_command", { cmd: "pnpx cowsay" }), gateFn);
    await handleCodexPreToolUse(ev("local_shell", { command: ["npm", "i", "left pad"] }), gateFn);
    expect(seen).toEqual(["pip install requests", "pnpx cowsay", "npm i 'left pad'"]);
    expect(codexCommandString(["zsh", "-c", "ls"])).toBe("ls");
  });
  it("lets non-install commands, other tools and malformed input through without calling the gate", async () => {
    const gateFn = async () => {
      throw new Error("should not be called");
    };
    for (const raw of [ev("Bash", { command: "ls -la" }), ev("mcp__fs__read", { path: "x" }), "not json", JSON.stringify({ foo: 1 })]) {
      expect(await handleCodexPreToolUse(raw, gateFn)).toEqual({ stdout: "", stderr: "", code: 0 });
    }
  });
  it("fails closed when the gate throws on an install", async () => {
    const o = await handleCodexPreToolUse(ev("Bash", { command: "npm i x" }), async () => {
      throw new Error("daemon exploded");
    });
    expect(o.code).toBe(2);
    expect(o.stdout).toContain("fail closed");
  });
  it("blocks tampering with Ladon / Codex hook config", async () => {
    const o = await handleCodexPreToolUse(ev("apply_patch", { command: "*** Begin Patch\n*** Update File: /Users/x/.codex/hooks.json\n@@\n-a\n+b\n*** End Patch" }), async () => slim({}));
    expect(o.code).toBe(2);
    const b = await handleCodexPreToolUse(ev("Bash", { command: "echo '{}' > ~/.codex/hooks.json" }), async () => slim({}));
    expect(b.code).toBe(2);
    const ok = await handleCodexPreToolUse(ev("apply_patch", { command: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }), async () => slim({}));
    expect(ok.code).toBe(0);
  });
  it("warns without blocking", async () => {
    const o = await handleCodexPreToolUse(ev("Bash", { command: "npm i mid" }), async () => slim({ verdict: "warn", outcome: "warned", display: "▲ WARN mid" }));
    expect(o.code).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({ systemMessage: "▲ WARN mid" });
  });
});

describe("init --codex / --cursor (features 2 + 6)", () => {
  it("installs the Codex hook idempotently and keeps other hooks", () => {
    const d = tmp("ladon-codex-");
    writeFileSync(join(d, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other" }] }] } }));
    expect(installCodexHooks(d)).toBe("added");
    expect(installCodexHooks(d)).toBe("present");
    const cfg = JSON.parse(readFileSync(join(d, "hooks.json"), "utf8")) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
    expect(cfg.hooks.PreToolUse).toHaveLength(2);
    expect(cfg.hooks.PreToolUse[1]!.matcher).toBe(CODEX_MATCHER);
    expect(cfg.hooks.PreToolUse[1]!.hooks[0]!.command).toContain("hook codex-pre-tool-use");
    expect(new RegExp(CODEX_MATCHER).test("Bash") && new RegExp(CODEX_MATCHER).test("apply_patch") && !new RegExp(CODEX_MATCHER).test("mcp__x")).toBe(true);
    expect(existsSync(join(d, "hooks.json.ladon-backup"))).toBe(true);
  });
  it("treats an inline config.toml hook as installed and detects disabled hooks", () => {
    const d = tmp("ladon-codex2-");
    writeFileSync(join(d, "config.toml"), `model = "gpt-5"\n[features]\nhooks = false\n\n[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "ladon hook codex-pre-tool-use"\n`);
    expect(installCodexHooks(d)).toBe("present");
    expect(existsSync(join(d, "hooks.json"))).toBe(false);
    expect(codexHooksDisabled(d)).toBe(true);
    writeFileSync(join(d, "config.toml"), `[features]\nweb_search = true\n[other]\nhooks = false\n`);
    expect(codexHooksDisabled(d)).toBe(false);
  });
  it("Cursor gets beforeShellExecution + beforeSubmitPrompt; legacy installs are upgraded once", () => {
    const d = tmp("ladon-cursor-");
    const p = join(d, "hooks.json");
    writeFileSync(p, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "node /x/index.js hook cursor" }] } }));
    expect(installCursorHooks(p)).toBe("added");
    expect(installCursorHooks(p)).toBe("present");
    const cfg = JSON.parse(readFileSync(p, "utf8")) as { hooks: Record<string, { command: string }[]> };
    expect(cfg.hooks.beforeShellExecution).toHaveLength(1);
    expect(cfg.hooks.beforeSubmitPrompt![0]!.command).toContain("hook cursor-before-submit-prompt");
  });
});

describe("python shim (feature 4)", () => {
  const setup = () => {
    const root = tmp("ladon-py-");
    const shimDir = join(root, "shims");
    const real = join(root, "realbin");
    mkdirSync(shimDir);
    mkdirSync(real);
    writeFileSync(join(real, "python3"), `#!/bin/sh\necho "REAL $*"\n`);
    chmodSync(join(real, "python3"), 0o755);
    writeFileSync(join(shimDir, "python3"), pythonShimScript("python3", "echo GATE", shimDir));
    chmodSync(join(shimDir, "python3"), 0o755);
    const run = (...args: string[]) => execFileSync(join(shimDir, "python3"), args, { env: { PATH: `${shimDir}:${real}:/usr/bin:/bin` } }).toString().trim();
    return { run, shimDir, real };
  };
  it("execs the real python for ordinary use (no node)", () => {
    const { run } = setup();
    expect(run("script.py", "-m", "pip")).toBe("REAL script.py -m pip");
    expect(run("-c", "import sys", "-m", "pip")).toBe("REAL -c import sys -m pip");
    expect(run("-m", "http.server")).toBe("REAL -m http.server");
    expect(run("-W", "ignore", "x.py")).toBe("REAL -W ignore x.py");
  });
  it("hands -m pip / -m uv / -mpip to Ladon", () => {
    const { run } = setup();
    expect(run("-m", "pip", "install", "x")).toBe("GATE -m pip install x");
    expect(run("-I", "-W", "ignore", "-m", "pip3", "install", "x")).toBe("GATE -I -W ignore -m pip3 install x");
    expect(run("-m", "uv", "pip", "install", "x")).toBe("GATE -m uv pip install x");
    expect(run("-mpip", "install", "x")).toBe("GATE -mpip install x");
  });
  it("skips itself even when reachable through another PATH entry", () => {
    const { shimDir, real } = setup();
    const out = execFileSync(join(shimDir, "python3"), ["a.py"], { env: { PATH: `${shimDir}/:${shimDir}/../shims:${real}` } }).toString().trim();
    expect(out).toBe("REAL a.py");
  });
});

describe("first-time-in-directory scan (feature 8)", () => {
  const risky = [{ path: "/p/AGENTS.md", risk: "high" as const, findings: [{ severity: "high" as const, kind: "install_imperative", line: 3, detail: "tells the agent to install a package", excerpt: "npm i x" }] }];
  it("once per directory per 24 h, only for agents without a session hook", () => {
    const d = tmp("ladon-fs-");
    let calls = 0;
    const scan = () => (calls++, risky as never);
    expect(firstVisitScan(d, "claude-code", scan)).toBeNull();
    expect(firstVisitScan(d, "human", scan)).toBeNull();
    expect(calls).toBe(0);
    const n = firstVisitScan(d, "cursor", scan);
    expect(n?.human).toContain("AGENTS.md");
    expect(n?.agent).toContain("untrusted");
    expect(firstVisitScan(d, "codex", scan)).toBeNull();
    expect(calls).toBe(1);
    expect(markScanned(join(d, "other"), Date.now())).toBe(true);
  });
  it("low/none risk files produce no notice", () => {
    expect(formatDirNotice([{ path: "/p/CLAUDE.md", risk: "low", findings: [] }])).toBeNull();
  });
  it("gate prepends the notice to display and agentText", async () => {
    const notice = { human: "▲ Ladon: ~/x/AGENTS.md — tells the agent to install", agent: "[Ladon security notice]" };
    const r = await gate({ command: "npm i react", cwd: tmp("ladon-fsg-"), agent: "codex" }, { approvers: [], deps: fakeDeps, dirScan: () => notice });
    expect(r.decision).toBe("allow");
    expect(r.notice).toBe(notice.human);
    expect(r.display.startsWith(notice.human)).toBe(true);
    expect(r.agentText.startsWith("[Ladon security notice]")).toBe(true);
  });
});
