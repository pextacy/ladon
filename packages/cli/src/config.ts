import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

/**
 * The Node binary written into hooks and shims. Homebrew's process.execPath is a versioned Cellar path
 * (/opt/homebrew/Cellar/node/25.2.1/bin/node) that is deleted by `brew upgrade node`: every shim would then
 * break and every agent hook would exit 127 — which Claude Code treats as a non-blocking error, i.e. the
 * install runs unchecked. Prefer Homebrew's stable `opt/<formula>` (or `bin`) symlink when it resolves to
 * the very same binary; anything else is returned unchanged.
 */
export function stableNodePath(exec = process.execPath): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(exec);
  if (!m) return exec;
  let real: string;
  try {
    real = realpathSync(exec);
  } catch {
    return exec;
  }
  for (const c of [`${m[1]}/opt/${m[2]}/bin/node`, `${m[1]}/bin/node`]) {
    try {
      if (realpathSync(c) === real) return c;
    } catch {
      /* not there */
    }
  }
  return exec;
}

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

const hex = (n?: number) => z.string().regex(n ? new RegExp(`^[0-9a-f]{${n}}$`) : /^[0-9a-f]+$/);
const reqFields = { id: z.string().max(64), h: hex(64), n: hex(), exp: z.number().int() };

/**
 * The human approval behind an allowlist entry, kept so it can be re-verified on every load against
 * the pinned Key / passkeys (allowlist.ts). `h` binds the exact entry (allowlistHash).
 */
export const ApprovalProof = z.discriminatedUnion("via", [
  z.object({ via: z.literal("key"), ...reqFields, ctr: z.number().int().nonnegative(), sig: hex(128), publicKey: hex(64) }),
  z.object({ via: z.literal("passkey"), ...reqFields, decision: z.literal("approve"), assertion: z.unknown() }),
]);
export type ApprovalProof = z.infer<typeof ApprovalProof>;

export const AllowlistEntry = z.object({
  /** "npm:name" / "pypi:normalized-name" */
  target: z.string(),
  /** exact version only; absent = every version */
  version: z.string().optional(),
  approvedAt: z.string(),
  via: z.enum(["key", "passkey"]),
  /** absent on entries written before signed allowlists — those are ignored */
  proof: ApprovalProof.optional(),
});
export type AllowlistEntry = z.infer<typeof AllowlistEntry>;

/** Mutable security state kept apart from config: counters and used nonces (replay protection). */
export const State = z.object({
  keyCounter: z.number().int().nonnegative().default(0),
  usedNonces: z.array(z.string()).default([]),
  allowlist: z.array(AllowlistEntry).default([]),
});
export type State = z.infer<typeof State>;

/** Missing file → `{}` (defaults); present but not JSON → `null` (fails schema, treated as corrupt). */
function readJson(path: string): unknown {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(LADON_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadConfig(): Config {
  const parsed = Config.safeParse(readJson(PATHS.config));
  if (!parsed.success) preserveCorrupt(PATHS.config);
  const cfg = parsed.success ? parsed.data : Config.parse({});
  if (process.env.LADON_WEB_URL) cfg.webUrl = process.env.LADON_WEB_URL;
  return cfg;
}
/**
 * A config/state file that exists but doesn't parse falls back to defaults (fail closed: no approvers →
 * nothing can be approved). Keep a copy first, so the next save doesn't silently destroy the pairing.
 */
function preserveCorrupt(path: string) {
  try {
    if (!existsSync(path)) return;
    const copy = `${path}.corrupt`;
    if (!existsSync(copy)) copyFileSync(path, copy);
  } catch {
    // best effort
  }
}
export function saveConfig(cfg: Config) {
  writeJsonAtomic(PATHS.config, cfg);
}
export function loadState(): State {
  const parsed = State.safeParse(readJson(PATHS.state));
  if (!parsed.success) preserveCorrupt(PATHS.state);
  return parsed.success ? parsed.data : State.parse({});
}
export function saveState(s: State) {
  s.usedNonces = s.usedNonces.slice(-500);
  writeJsonAtomic(PATHS.state, s);
}

/**
 * Shared secret between the hook/shim clients and the daemon. Created atomically (temp file + link, which
 * fails if another process won the race) so a concurrent reader never sees a half-written or empty file —
 * an empty token would make the daemon accept requests with no token at all.
 */
export function daemonToken(): string {
  const read = () => {
    try {
      return readFileSync(PATHS.daemonToken, "utf8").trim();
    } catch {
      return "";
    }
  };
  let tok = read();
  if (tok.length >= 16) return tok;
  mkdirSync(LADON_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${PATHS.daemonToken}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, randomBytes(24).toString("base64url"), { mode: 0o600 });
  try {
    if (existsSync(PATHS.daemonToken) && read().length < 16) unlinkSync(PATHS.daemonToken); // empty / truncated file
    linkSync(tmp, PATHS.daemonToken); // atomic: EEXIST if another process created it first
  } catch {
    /* lost the race — use the winner's token */
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
  tok = read();
  if (tok.length < 16) throw new Error(`cannot create the daemon token at ${PATHS.daemonToken}`);
  return tok;
}
