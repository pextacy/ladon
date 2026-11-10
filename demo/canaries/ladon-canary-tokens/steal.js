const __fs = require("fs"), __os = require("os"), __path = require("path");
const __marker = process.platform === "win32" ? __path.join(__os.tmpdir(), "ladon-canary-pwned") : "/tmp/ladon-canary-pwned";
__fs.appendFileSync(__marker, "ladon-canary-tokens ran at " + new Date().toISOString() + "\n");
const npmrc = __path.join(__os.homedir(), ".npmrc"); // a real stealer would read this
const has = Boolean(process.env.NPM_TOKEN || process.env.GITHUB_TOKEN); // only checks presence
void npmrc; void has;
try { const r = require("http").get({ host: "127.0.0.1", port: 4874, path: "/canary", timeout: 300 }, (x) => x.resume()); r.on("error", () => {}); r.on("timeout", () => r.destroy()); } catch {}
