import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { commandHash, newNonce, newRequestId } from "@ladon/core";
import { requestApproval } from "./approve/index.js";
import { loadConfig } from "./config.js";
import { defaultApprovers } from "./runtime.js";

/** Ask on the controlling terminal (not stdin, which an agent controls). false if there is no terminal. */
export function confirmOnTty(question: string): boolean {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return false;
  }
  try {
    writeSync(fd, `${question}\nType "yes" to confirm: `);
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, null);
    return buf.subarray(0, n).toString("utf8").trim().toLowerCase() === "yes";
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Changing who can approve installs needs a human. With an approver already paired, that approver must
 * sign off (Key press or passkey). The very first approver is confirmed on /dev/tty.
 */
export async function humanApprovesApproverChange(what: string, log: (s: string) => void): Promise<boolean> {
  const cfg = loadConfig();
  if (cfg.key || cfg.passkeys.length > 0) {
    log(`  approve "${what}" on your existing Ladon Key or passkey…`);
    const o = await requestApproval(defaultApprovers(), {
      id: newRequestId(),
      h: commandHash(`ladon approver-change ${what}`),
      n: newNonce(),
      exp: Math.floor(Date.now() / 1000) + 120,
      pkg: `pair: ${what}`.slice(0, 120),
      ecosystem: "npm",
      name: "ladon-approver-change",
      score: 0,
      why: ["adds a new approver for risky installs", what.slice(0, 100)],
    }, log);
    if (o.kind !== "approved") log(`  ■ not paired: ${o.detail}`);
    return o.kind === "approved";
  }
  const yes = confirmOnTty(`\nPair ${what} as the approver for risky installs on this machine?`);
  if (!yes) log("  ■ not confirmed on the terminal — run this yourself in an interactive terminal");
  return yes;
}
