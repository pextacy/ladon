const __fs = require("fs"), __os = require("os"), __path = require("path");
const __marker = process.platform === "win32" ? __path.join(__os.tmpdir(), "ladon-canary-pwned") : "/tmp/ladon-canary-pwned";
__fs.appendFileSync(__marker, "ladon-canary-dns ran at " + new Date().toISOString() + "\n");
require("dns").lookup("localhost", () => {});
