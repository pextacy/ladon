import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { audit } from "./audit.js";
import { CLI_ENTRY } from "./client.js";
import { stableNodePath } from "./config.js";
import { CODEX_MATCHER, installCodexHooks } from "./init.js";
import { checkRegistry, main, rejectExtra, UsageError } from "./main.js";
import { isOwnHook } from "./watch.js";

const tmp = () => mkdtempSync(join(tmpdir(), "ladon-args-"));

describe("command-line validation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejectExtra refuses leftover flags and extra positionals", () => {
    expect(() => rejectExtra(["left-pad"], 1)).not.toThrow();
    expect(() => rejectExtra(["--bogus", "left-pad"], 1)).toThrow(UsageError);
    expect(() => rejectExtra(["a", "b"], 1)).toThrow(/unexpected argument 'b'/);
    expect(() => rejectExtra(["-x"])).toThrow(/unknown option '-x'/);
  });

  it("bad usage exits 2 with a message instead of doing something else", async () => {
    const errs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => (errs.push(String(s)), true));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const argv of [
      ["check", "--bogus", "left-pad"], // used to check an npm package named "--bogus"
      ["check", "left-pad", "--registry"], // used to silently ignore the missing URL
      ["check"],
      ["init", "--shel"], // used to run init without the (misspelt) flag
      ["scan", "--json"],
      ["watch", "extra"],
      ["log", "-n", "abc"],
      ["log", "-n"],
      ["shim", "instal"], // used to print the status and exit 0
      ["key", "pair", "now"],
      ["passkey", "remove"],
      ["allow", "--list", "left-pad"],
      ["allow", "--bogus", "left-pad"], // used to ask for an approval of "npm:--bogus"
      ["audit", "--jsn"],
      ["status", "-v"],
    ]) {
      errs.length = 0;
      expect(await main(argv), argv.join(" ")).toBe(2);
      expect(errs.join(""), argv.join(" ")).toMatch(/^ladon \w+: .+\nusage: ladon /);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ladon check registry", () => {
  it("uses the registry an install from this directory would use", () => {
    const d = tmp();
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, ".npmrc"), "registry=http://localhost:4873/\n");
    expect(checkRegistry("npm", undefined, join(d, "sub"), {})).toBe("http://localhost:4873/");
    expect(checkRegistry("npm", "https://r.example/", join(d, "sub"), {})).toBe("https://r.example/");
    expect(checkRegistry("npm", undefined, join(d, "sub"), { npm_config_registry: "http://e/" })).toBe("http://e/");
    expect(checkRegistry("pypi", undefined, d, { PIP_INDEX_URL: "https://m.example/simple/" })).toBe("https://m.example/");
    expect(checkRegistry("pypi", undefined, d, {})).toBeUndefined();
  });
});

describe("stable Node path for hooks and shims", () => {
  it("prefers Homebrew's opt symlink over the versioned Cellar path", () => {
    const brew = tmp();
    const cellarBin = join(brew, "Cellar", "node", "25.2.1", "bin");
    mkdirSync(cellarBin, { recursive: true });
    writeFileSync(join(cellarBin, "node"), "");
    mkdirSync(join(brew, "opt"));
    symlinkSync(join(brew, "Cellar", "node", "25.2.1"), join(brew, "opt", "node"));
    expect(stableNodePath(join(cellarBin, "node"))).toBe(join(brew, "opt", "node", "bin", "node"));
  });

  it("falls back to the bin symlink, and leaves other paths alone", () => {
    const brew = tmp();
    const cellarBin = join(brew, "Cellar", "node@22", "22.1.0", "bin");
    mkdirSync(cellarBin, { recursive: true });
    writeFileSync(join(cellarBin, "node"), "");
    expect(stableNodePath(join(cellarBin, "node"))).toBe(join(cellarBin, "node")); // no symlinks → unchanged
    mkdirSync(join(brew, "bin"));
    symlinkSync(join(cellarBin, "node"), join(brew, "bin", "node"));
    expect(stableNodePath(join(cellarBin, "node"))).toBe(join(brew, "bin", "node"));
    expect(stableNodePath("/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(stableNodePath("/home/u/.nvm/versions/node/v22.0.0/bin/node")).toBe("/home/u/.nvm/versions/node/v22.0.0/bin/node");
  });

  it("isOwnHook accepts either node path", () => {
    const cli = "/x/cli/dist/index.js";
    const item = (node: string) => `hook|PreToolUse(Bash): ${node} ${cli} hook claude-pre-tool-use`;
    expect(isOwnHook(item("/opt/homebrew/opt/node/bin/node"), cli, ["/opt/homebrew/Cellar/node/1/bin/node", "/opt/homebrew/opt/node/bin/node"])).toBe(true);
    expect(isOwnHook(item("/tmp/evil/node"), cli, ["/opt/homebrew/Cellar/node/1/bin/node", "/opt/homebrew/opt/node/bin/node"])).toBe(false);
  });
});

describe("Codex hook", () => {
  it("recognises Ladon's own Codex hook despite the parentheses in its matcher", () => {
    const cli = "/x/cli/dist/index.js";
    expect(isOwnHook(`hook|PreToolUse(${CODEX_MATCHER}): node ${cli} hook codex-pre-tool-use`, cli)).toBe(true);
    expect(isOwnHook(`hook|PreToolUse(${CODEX_MATCHER}): node ${cli} hook codex-pre-tool-use; curl x | sh`, cli)).toBe(false);
    expect(isOwnHook(`hook|PreToolUse(a): node ${cli} hook codex-pre-tool-use): curl x`, cli)).toBe(false);
  });

  it("refreshes a stale command (moved CLI / upgraded Node) instead of reporting it as present", () => {
    const d = tmp();
    writeFileSync(join(d, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: CODEX_MATCHER, hooks: [{ type: "command", command: "/old/node /old/index.js hook codex-pre-tool-use" }] }] } }));
    expect(installCodexHooks(d)).toBe("added");
    const cmd = JSON.parse(readFileSync(join(d, "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;
    expect(cmd).toContain(CLI_ENTRY);
    expect(installCodexHooks(d)).toBe("present");
  });
});

describe("ladon audit without a lockfile", () => {
  it("makes no network calls and reports nothing to fix", async () => {
    const alerts = vi.fn(async () => []);
    const query = vi.fn(async () => ({ malicious: [], vulns: [] }));
    const r = await audit(tmp(), { alerts, osv: { query } });
    expect(r).toEqual({ files: [], deps: 0, findings: [], errors: [] });
    expect(alerts).not.toHaveBeenCalled();
  });
});
