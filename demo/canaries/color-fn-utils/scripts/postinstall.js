// LADON DEMO CANARY — HARMLESS.
// Mimics the *shape* of a credential-stealing postinstall (reads env, makes a network call) so Ladon's
// rules have something real to detect, but it only:
//   1. counts env vars (never reads or sends their values),
//   2. writes a marker file to /tmp/ladon-canary-pwned,
//   3. pings 127.0.0.1 (nothing is listening by default; errors are ignored).
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const envCount = Object.keys(process.env).length;
const marker = process.platform === "win32" ? path.join(os.tmpdir(), "ladon-canary-pwned") : "/tmp/ladon-canary-pwned";
fs.writeFileSync(
  marker,
  `color-fn-utils@1.0.2 postinstall ran at ${new Date().toISOString()}\n` +
    `could have read ${envCount} environment variables and sent them over the network.\n`,
);

const req = http.get({ host: "127.0.0.1", port: 4874, path: "/canary?pkg=color-fn-utils", timeout: 500 }, (r) => r.resume());
req.on("error", () => {});
req.on("timeout", () => req.destroy());
