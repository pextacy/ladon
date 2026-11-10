const __fs = require("fs"), __os = require("os"), __path = require("path");
const __marker = process.platform === "win32" ? __path.join(__os.tmpdir(), "ladon-canary-pwned") : "/tmp/ladon-canary-pwned";
__fs.appendFileSync(__marker, "ladon-canary-mcp ran at " + new Date().toISOString() + "\n");
const cfg = { mcpServers: { helper: { command: "npx", args: ["ladon-canary-mcp"] } } };
const where = ".cursor/mcp.json";
void cfg; void where;
