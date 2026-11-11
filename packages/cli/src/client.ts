import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LADON_VERSION } from "@ladon/core";
import { DAEMON_PORT, daemonToken, LADON_HOME, PATHS } from "./config.js";
import { daemonProof, slimResult, type SlimResult } from "./daemon.js";
import { gate, type GateInput } from "./gate.js";
import { gateEnv, loadLadonEnv } from "./runtime.js";

const BASE = `http://127.0.0.1:${DAEMON_PORT}`;
export const CLI_ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

const proofOk = (given: string | null, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export type DaemonProbe = { state: "down" } | { state: "impostor"; pid?: number } | { state: "up"; version: string };

const claimedPid = (text: string): number | undefined => {
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A daemon from a Ladon build before the authenticity proof can't prove itself, so it looks like an
 * impostor — and it would hold the port (and the Key's serial port) forever. If the pid it reports is
 * really `node <this CLI> daemon`, it is ours: stop it with a signal (no token is sent anywhere).
 */
export function isOurDaemonProcess(pid: number, entry = CLI_ENTRY): boolean {
  if (pid === process.pid || process.platform === "win32") return false;
  try {
    const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
    return r.status === 0 && r.stdout.trim().endsWith(` ${entry} daemon`);
  } catch {
    return false;
  }
}

/**
 * Is the real daemon listening? Something answering /health is not enough: it must prove it knows the
 * token (HMAC over a fresh challenge) before we send it the token or trust its verdicts.
 */
export async function probeDaemon(base = BASE): Promise<DaemonProbe> {
  const c = randomBytes(16).toString("hex");
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${base}/health?c=${c}`, { signal: AbortSignal.timeout(400) });
    text = await res.text();
  } catch {
    return { state: "down" };
  }
  if (!res.ok || !proofOk(res.headers.get("x-ladon-proof"), daemonProof(daemonToken(), c, text))) {
    const pid = claimedPid(text);
    return pid ? { state: "impostor", pid } : { state: "impostor" };
  }
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return { state: "up", version: typeof v === "string" ? v : "" };
  } catch {
    return { state: "impostor" };
  }
}

export function startDaemonDetached() {
  mkdirSync(LADON_HOME, { recursive: true, mode: 0o700 });
  const out = openSync(PATHS.daemonLog, "a");
  const child = spawn(process.execPath, [CLI_ENTRY, "daemon"], { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
}

async function stopDaemon(base: string) {
  try {
    await fetch(`${base}/shutdown`, { method: "POST", headers: { "x-ladon-token": daemonToken() }, signal: AbortSignal.timeout(1000) });
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 20; i++) {
    if ((await probeDaemon(base)).state === "down") return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function ensureDaemon(base = BASE): Promise<boolean> {
  let p = await probeDaemon(base);
  if (p.state === "impostor" && p.pid && isOurDaemonProcess(p.pid)) {
    // pre-proof daemon from an older build of this same install: replace it
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      /* gone already */
    }
    for (let i = 0; i < 20 && (p = await probeDaemon(base)).state !== "down"; i++) await new Promise((r) => setTimeout(r, 100));
  }
  if (p.state === "impostor") return false; // never talk to it; the caller gates in-process
  if (p.state === "up" && p.version === LADON_VERSION) return true;
  if (p.state === "up") await stopDaemon(base); // stale daemon from an older install: replace it
  startDaemonDetached();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 120));
    p = await probeDaemon(base);
    if (p.state === "up") return p.version === LADON_VERSION;
    if (p.state === "impostor") return false;
  }
  return false;
}

/** POST /gate to the daemon; null unless the response is proven to come from the real daemon. */
export async function postGate(input: Omit<GateInput, "onStatus">, opts: { base?: string; signal?: AbortSignal } = {}): Promise<SlimResult | null> {
  const c = randomBytes(16).toString("hex");
  const token = daemonToken();
  const r = await fetch(`${opts.base ?? BASE}/gate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ladon-token": token, "x-ladon-challenge": c },
    body: JSON.stringify(input),
    signal: opts.signal ?? AbortSignal.timeout(10 * 60_000),
  });
  const text = await r.text();
  if (!r.ok || !proofOk(r.headers.get("x-ladon-proof"), daemonProof(token, c, text))) return null;
  return JSON.parse(text) as SlimResult;
}

/**
 * Ask the daemon for a verdict (it owns the Key connection and the warm cache). If the daemon cannot
 * be started or can't prove it is ours, run the same gate in-process — never skip the check.
 */
export async function gateCommand(input: Omit<GateInput, "onStatus">, onStatus?: (m: string) => void, signal?: AbortSignal): Promise<SlimResult> {
  if (await ensureDaemon()) {
    try {
      const r = await postGate(input, signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) } : {});
      if (r) return r;
    } catch (e) {
      if (signal?.aborted) throw e;
      /* fall through to in-process */
    }
  }
  if (signal?.aborted) throw new Error("timed out");
  loadLadonEnv();
  const env = await gateEnv();
  return slimResult(await gate({ ...input, ...(onStatus ? { onStatus } : {}) }, env));
}
