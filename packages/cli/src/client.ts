import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DAEMON_PORT, daemonToken, LADON_HOME, PATHS } from "./config.js";
import { slimResult, type SlimResult } from "./daemon.js";
import { gate, type GateInput } from "./gate.js";
import { gateEnv, loadLadonEnv } from "./runtime.js";

const base = `http://127.0.0.1:${DAEMON_PORT}`;
export const CLI_ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(400) });
    return r.ok;
  } catch {
    return false;
  }
}

export function startDaemonDetached() {
  mkdirSync(LADON_HOME, { recursive: true, mode: 0o700 });
  const out = openSync(PATHS.daemonLog, "a");
  const child = spawn(process.execPath, [CLI_ENTRY, "daemon"], { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
}

export async function ensureDaemon(): Promise<boolean> {
  if (await healthy()) return true;
  startDaemonDetached();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 120));
    if (await healthy()) return true;
  }
  return false;
}

/**
 * Ask the daemon for a verdict (it owns the Key connection and the warm cache). If the daemon cannot
 * be started, run the same gate in-process — never skip the check.
 */
export async function gateCommand(input: Omit<GateInput, "onStatus">, onStatus?: (m: string) => void): Promise<SlimResult> {
  if (await ensureDaemon()) {
    try {
      const r = await fetch(`${base}/gate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ladon-token": daemonToken() },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (r.ok) return (await r.json()) as SlimResult;
    } catch {
      /* fall through to in-process */
    }
  }
  loadLadonEnv();
  const env = await gateEnv();
  return slimResult(await gate({ ...input, ...(onStatus ? { onStatus } : {}) }, env));
}
