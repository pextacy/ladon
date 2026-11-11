import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cachedIntentJudge, FileCache, type IntentInput, type IntentResult } from "@ladon/core";
import { KeyBridge } from "./approve/key.js";
import { passkeyApprover } from "./approve/passkey.js";
import type { Approver } from "./approve/types.js";
import { LADON_HOME, PATHS } from "./config.js";
import type { GateEnv } from "./gate.js";

/** Optional ~/.ladon/env (KEY=VALUE lines) so the daemon gets ANTHROPIC_API_KEY / LADON_AI without a shell rc. */
export function loadLadonEnv() {
  try {
    for (const line of readFileSync(join(LADON_HOME, "env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* optional */
  }
}

let keyBridge: KeyBridge | undefined;
export function sharedKeyBridge(): KeyBridge {
  keyBridge ??= new KeyBridge();
  return keyBridge;
}

export function defaultApprovers(): Approver[] {
  return [sharedKeyBridge(), passkeyApprover()];
}

/** Intent judge only when LADON_AI=on and a key is present (CLAUDE.md #3). */
export async function intentJudge(): Promise<((i: IntentInput) => Promise<IntentResult | null>) | undefined> {
  const ai = await import("@ladon/core/ai").catch(() => null);
  if (!ai || !ai.aiEnabled()) return undefined;
  const provider = ai.anthropicProvider({ timeoutMs: 12_000 });
  // same input → same decision for 24 h (stands in for temperature 0, which the API rejects)
  return cachedIntentJudge((i) => provider.judgeIntent(i), new FileCache(PATHS.cache));
}

export async function gateEnv(): Promise<GateEnv> {
  const intent = await intentJudge();
  return { approvers: defaultApprovers(), ...(intent ? { intent } : {}) };
}

/** Best-effort desktop notification so the human looks at the Key / phone. */
export function notify(title: string, body: string) {
  if (process.env.LADON_NO_NOTIFY) return;
  const esc = (s: string) => s.replace(/["\\]/g, "").slice(0, 200);
  if (process.platform === "darwin") execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
  else if (process.platform === "linux") execFile("notify-send", [esc(title), esc(body)], () => {});
}
