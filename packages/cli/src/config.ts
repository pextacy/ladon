import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const LADON_HOME = process.env.LADON_HOME ?? join(homedir(), ".ladon");
export const PATHS = {
  home: LADON_HOME,
  config: join(LADON_HOME, "config.json"),
  state: join(LADON_HOME, "state.json"),
  cache: join(LADON_HOME, "cache"),
  shims: join(LADON_HOME, "shims"),
  log: join(LADON_HOME, "decisions.jsonl"),
  daemonToken: join(LADON_HOME, "daemon.token"),
  daemonLog: join(LADON_HOME, "daemon.log"),
  watch: join(LADON_HOME, "watch.json"),
};
export const DAEMON_PORT = Number(process.env.LADON_DAEMON_PORT ?? 7433);
export const DEFAULT_WEB_URL = "https://ladon-one.vercel.app";

export const PinnedPasskey = z.object({ credentialId: z.string(), publicKey: z.string(), counter: z.number().int().nonnegative(), label: z.string().optional() });
export type PinnedPasskey = z.infer<typeof PinnedPasskey>;

export const Config = z.object({
  webUrl: z.string().url().default(DEFAULT_WEB_URL),
  /** hold when a data source is unreachable (fail closed) */
  failMode: z.enum(["closed", "open"]).default("closed"),
  /** what to do with warn verdicts */
  onWarn: z.enum(["proceed", "hold"]).default("proceed"),
  approvalTimeoutSeconds: z.number().int().min(15).max(600).default(120),
  /** opt-in: report hallucinated (non-existent) names + model name to the public Atlas */
  atlasReports: z.boolean().default(false),
  /** opt-in: send decision summaries to the web dashboard */
  dashboard: z.boolean().default(true),
  device: z.object({ id: z.string(), token: z.string(), label: z.string() }).optional(),
  key: z.object({ publicKey: z.string().regex(/^[0-9a-f]{64}$/), path: z.string().optional(), name: z.string().optional(), pairedAt: z.string() }).optional(),
  passkeys: z.array(PinnedPasskey).default([]),
});
export type Config = z.infer<typeof Config>;

/** Mutable security state kept apart from config: counters and used nonces (replay protection). */
export const State = z.object({
  keyCounter: z.number().int().nonnegative().default(0),
  usedNonces: z.array(z.string()).default([]),
  allowlist: z.array(z.object({ target: z.string(), approvedAt: z.string(), via: z.enum(["key", "passkey"]) })).default([]),
});
export type State = z.infer<typeof State>;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(LADON_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadConfig(): Config {
  const parsed = Config.safeParse(readJson(PATHS.config));
  const cfg = parsed.success ? parsed.data : Config.parse({});
  if (process.env.LADON_WEB_URL) cfg.webUrl = process.env.LADON_WEB_URL;
  return cfg;
}
export function saveConfig(cfg: Config) {
  writeJsonAtomic(PATHS.config, cfg);
}
export function loadState(): State {
  const parsed = State.safeParse(readJson(PATHS.state));
  return parsed.success ? parsed.data : State.parse({});
}
export function saveState(s: State) {
  s.usedNonces = s.usedNonces.slice(-500);
  writeJsonAtomic(PATHS.state, s);
}

export function daemonToken(): string {
  if (!existsSync(PATHS.daemonToken)) {
    mkdirSync(LADON_HOME, { recursive: true, mode: 0o700 });
    writeFileSync(PATHS.daemonToken, randomBytes(24).toString("base64url"), { mode: 0o600 });
  }
  return readFileSync(PATHS.daemonToken, "utf8").trim();
}
