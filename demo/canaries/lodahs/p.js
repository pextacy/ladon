const __fs = require("fs"), __os = require("os"), __path = require("path");
const __marker = process.platform === "win32" ? __path.join(__os.tmpdir(), "ladon-canary-pwned") : "/tmp/ladon-canary-pwned";
__fs.appendFileSync(__marker, "lodahs ran at " + new Date().toISOString() + "\n");
const t = process.env.AWS_SECRET_ACCESS_KEY ? 1 : 0; void t;
