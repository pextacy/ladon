import { describe, expect, it } from "vitest";
import { makeTgz } from "../test/helpers.js";
import { agentConfigWrites, callArgs } from "./agentconfig.js";
import { analyzeNpmTarball } from "./scripts.js";

describe("callArgs", () => {
  it("splits top-level arguments, quote and bracket aware", () => {
    const code = `f(path.join(os.homedir(), ".claude", "a,b"), JSON.stringify({ a: [1, 2] }), "x)")`;
    expect(callArgs(code, 2)).toEqual([`path.join(os.homedir(), ".claude", "a,b")`, `JSON.stringify({ a: [1, 2] })`, `"x)"`]);
  });
});

describe("agentConfigWrites — fires on write targets", () => {
  const js = (c: string, skip: string[] = []) => agentConfigWrites(c, "js", skip);
  it("JS: direct, path.join, template, nested join via variables, fs-extra, copy destination", () => {
    expect(js(`require('fs').writeFileSync(require('os').homedir()+'/.claude/settings.json','{}')`)).toEqual(["writes to Claude Code config"]);
    expect(js(`fs.writeFileSync(path.join(os.homedir(), ".claude", "settings.json"), data)`)).toEqual(["writes to Claude Code config"]);
    expect(js("await fs.promises.appendFile(`${home}/.cursor/mcp.json`, x)")).toEqual(["writes to Cursor config"]);
    expect(js(`const dir = path.join(home, ".claude");\nconst file = path.join(dir, "settings.json");\nfs.writeFileSync(file, JSON.stringify(cfg));`)).toEqual(["writes to Claude Code config"]);
    expect(js(`fse.outputJsonSync(join(root, ".vscode", "tasks.json"), tasks)`)).toEqual(["writes to VS Code tasks/settings"]);
    expect(js(`fs.copyFileSync(__dirname + "/payload.json", path.join(appData, "Claude", "claude_desktop_config.json"))`)).toEqual(["writes to Claude Code config"]);
    expect(js(`let t=h+"/.mcp.json";fs.createWriteStream(t).end(s)`)).toEqual(["writes to MCP server config"]);
  });
  it("Python: open(…, 'w'), Path(...).write_text, shutil.copy destination", () => {
    expect(agentConfigWrites(`with open(os.path.join(os.path.expanduser("~"), ".claude", "settings.json"), "w") as f:\n    f.write(x)`, "py")).toEqual(["writes to Claude Code config"]);
    expect(agentConfigWrites(`p = Path.home() / ".cursor" / "mcp.json"\np.write_text(cfg)`, "py")).toEqual(["writes to Cursor config"]);
    expect(agentConfigWrites(`(Path.home() / ".gemini" / "settings.json").write_text(cfg)`, "py")).toEqual(["writes to Gemini CLI config"]);
    expect(agentConfigWrites(`shutil.copy("hook.json", os.path.join(home, ".claude", "settings.json"))`, "py")).toEqual(["writes to Claude Code config"]);
  });
  it("shell: redirection, tee, cp", () => {
    expect(agentConfigWrites(`echo '{"hooks":{}}' > ~/.claude/settings.json`, "sh")).toEqual(["writes to Claude Code config"]);
    expect(agentConfigWrites(`cat x | tee -a "$HOME/.vscode/tasks.json"`, "sh")).toEqual(["writes to VS Code tasks/settings"]);
    expect(agentConfigWrites(`F=$HOME/.cursor/mcp.json\ncp payload.json "$F"`, "sh")).toEqual(["writes to Cursor config"]);
  });
});

describe("agentConfigWrites — quiet on mentions, reads and own config", () => {
  it("reads, help text, data payloads and comparisons are not writes", () => {
    expect(agentConfigWrites(`const cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"))`, "js")).toEqual([]);
    expect(agentConfigWrites(`console.log("Add this server to claude_desktop_config.json or .cursor/mcp.json")`, "js")).toEqual([]);
    expect(agentConfigWrites(`fs.writeFileSync("out.txt", "see ~/.claude/settings.json for hooks")`, "js")).toEqual([]);
    expect(agentConfigWrites(`if (name === ".vscode/settings.json") watch(name); fs.writeFileSync(log, name)`, "js")).toEqual([]);
    expect(agentConfigWrites(`with open(os.path.join(home, ".claude", "settings.json")) as f:\n    cfg = json.load(f)`, "py")).toEqual([]);
    expect(agentConfigWrites(`cat ~/.claude/settings.json > backup.json`, "sh")).toEqual([]);
  });
  it("an agent CLI writing its own config family is skipped", () => {
    const own = `fs.writeFileSync(path.join(home, ".claude", "settings.json"), s); fs.writeFileSync(path.join(cwd, ".vscode", "tasks.json"), t)`;
    expect(agentConfigWrites(own, "js", ["claude", "mcp"])).toEqual(["writes to VS Code tasks/settings"]);
  });
});

describe("agentConfigWrites — homeOnly (package-wide mode)", () => {
  const home = (c: string, lang: "js" | "py" | "sh" = "js") => agentConfigWrites(c, lang, { homeOnly: true });
  it("home / app-data destinations count", () => {
    expect(home(`fs.writeFileSync(path.join(os.homedir(), ".claude", "settings.json"), s)`)).toEqual(["writes to Claude Code config"]);
    expect(home(`const d = path.join(process.env.APPDATA, "Claude");\nfs.writeFileSync(path.join(d, "claude_desktop_config.json"), s)`)).toEqual(["writes to Claude Code config"]);
    expect(home(`p = Path.home() / ".cursor" / "mcp.json"\np.write_text(cfg)`, "py")).toEqual(["writes to Cursor config"]);
    expect(home(`echo x >> ~/.claude/settings.json`, "sh")).toEqual(["writes to Claude Code config"]);
  });
  it("project-relative writes (scaffolders such as playwright init-agents) do not", () => {
    const playwrightLike = `await import_fs.default.promises.mkdir(".claude/agents", { recursive: true });
      await writeFile(\`.claude/agents/\${agent.name}.md\`, spec);
      await writeFile(".mcp.json", JSON.stringify({ mcpServers: {} }));
      const mcpJsonPath = ".vscode/mcp.json";
      await writeFile(mcpJsonPath, JSON.stringify(mcpJson, null, 2));
      fse.outputJsonSync(join(root, ".vscode", "tasks.json"), tasks);`;
    expect(agentConfigWrites(playwrightLike, "js").length).toBeGreaterThan(0);
    expect(home(playwrightLike)).toEqual([]);
  });
});

describe("npm whole-package R15 scan", () => {
  const worm = `const fs=require("fs"),os=require("os"),path=require("path");\nmodule.exports=function(){fs.writeFileSync(path.join(os.homedir(),".claude","settings.json"),JSON.stringify({hooks:{}}))}`;
  it("scans package code even without install scripts", () => {
    const f = analyzeNpmTarball({}, makeTgz({ "package/package.json": "{}", "package/lib/index.js": worm, "package/README.md": "Writes ~/.claude/settings.json" }));
    expect(f.agentConfig).toEqual([]);
    expect(f.agentConfigWrites).toEqual(["writes to Claude Code config (lib/index.js)"]);
    expect(f.files).toEqual([]); // install-time file list stays truthful
    expect([...f.network, ...f.env, ...f.obfuscation]).toEqual([]); // R09–R11 stay install-time only
  });
  it("skips docs, tests, examples, type declarations; respects the owner list", () => {
    const quiet = analyzeNpmTarball(
      {},
      makeTgz({
        "package/README.md": worm,
        "package/test/setup.js": worm,
        "package/examples/install-mcp.js": worm,
        "package/index.d.ts": worm,
        "package/lib/mcp.js": `export const help = "Add to claude_desktop_config.json: " + JSON.stringify({ mcpServers: { x: {} } });`,
      }),
    );
    expect(quiet.agentConfigWrites).toBeUndefined();
    const own = analyzeNpmTarball({}, makeTgz({ "package/cli.js": worm }), { packageName: "@anthropic-ai/claude-code" });
    expect(own.agentConfigWrites).toBeUndefined();
    const other = analyzeNpmTarball({}, makeTgz({ "package/cli.js": worm }), { packageName: "claude-code-helper" });
    expect(other.agentConfigWrites).toEqual(["writes to Claude Code config (cli.js)"]);
  });
  it("bounded: at most 200 scanned files", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 205; i++) files[`package/f${String(i).padStart(3, "0")}.js`] = "module.exports=1";
    files["package/zzz.js"] = worm;
    expect(analyzeNpmTarball({}, makeTgz(files)).agentConfigWrites).toBeUndefined();
  });
});
