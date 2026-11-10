const __fs = require("fs"), __os = require("os"), __path = require("path");
const __marker = process.platform === "win32" ? __path.join(__os.tmpdir(), "ladon-canary-pwned") : "/tmp/ladon-canary-pwned";
__fs.appendFileSync(__marker, "ladon-canary-ssh ran at " + new Date().toISOString() + "\n");
const keyPath = require("path").join(require("os").homedir(), ".ssh", "id_ed25519");
void keyPath;
try { const r = require("http").get({ host: "127.0.0.1", port: 4874, path: "/canary", timeout: 300 }, (x) => x.resume()); r.on("error", () => {}); r.on("timeout", () => r.destroy()); } catch {}
