import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { commandHash, keySignedMessage, normalizePypiName, verifyEd25519, type InstallTarget } from "@ladon/core";
import { verifyPasskeyAssertion } from "./approve/passkey.js";
import type { AllowlistEntry, Config, State } from "./config.js";

/**
 * Signed allowlist. Every entry carries the Key signature or passkey assertion that approved it, and
 * is re-verified against the *pinned* approvers each time it is loaded. The approval's command hash
 * binds the exact entry (target + optional version), so an agent that can write ~/.ladon/state.json
 * still cannot add an entry, widen a version-scoped one, or reuse another entry's proof.
 */

export const ALLOWLIST_DOMAIN = "ladon:allowlist";

/** "npm:name" / "pypi:pep503-name" */
export function allowTarget(ecosystem: "npm" | "pypi", name: string): string {
  return `${ecosystem}:${ecosystem === "pypi" ? normalizePypiName(name) : name}`;
}

/** Exact version from a spec ("1.2.3", "=1.2.3", "==1.2.3"); null for ranges / tags. */
export function exactVersion(spec: string | undefined): string | null {
  if (!spec) return null;
  const m = /^\s*(?:===?|=)?\s*v?([0-9][0-9A-Za-z.+!_-]*)\s*$/.exec(spec);
  if (!m) return null;
  return /[\^~*<>|, ]|\.x(\.|$)/i.test(m[1]!) ? null : m[1]!;
}

export const entryLabel = (e: Pick<AllowlistEntry, "target" | "version">) => `${e.target}${e.version ? `@${e.version}` : ""}`;

/** The command hash an allowlist approval must carry for this entry. */
export function allowlistHash(e: Pick<AllowlistEntry, "target" | "version">): string {
  return commandHash(`ladon allow ${entryLabel(e)}`, ALLOWLIST_DOMAIN);
}

export type EntryCheck = { ok: true } | { ok: false; reason: string };

const cache = new Map<string, EntryCheck>();

/** Verify one entry's proof against the pinned Key / passkeys in `cfg`. */
export async function verifyEntry(e: AllowlistEntry, cfg: Pick<Config, "key" | "passkeys" | "webUrl">): Promise<EntryCheck> {
  const p = e.proof;
  if (!p) return { ok: false, reason: "unsigned (written before signed allowlists, or not by Ladon)" };
  if (p.via !== e.via) return { ok: false, reason: "approval type does not match the entry" };
  if (p.h !== allowlistHash(e)) return { ok: false, reason: "approval is for a different allowlist entry" };
  const memo = JSON.stringify([e, cfg.key?.publicKey ?? null, cfg.passkeys.map((k) => [k.credentialId, k.publicKey]), cfg.webUrl]);
  const hit = cache.get(memo);
  if (hit) return hit;
  let r: EntryCheck;
  if (p.via === "key") {
    if (!cfg.key) r = { ok: false, reason: "signed by a Ladon Key, but no Key is paired" };
    else if (p.publicKey !== cfg.key.publicKey) r = { ok: false, reason: "signed by a Ladon Key that is not the paired one" };
    else r = verifyEd25519(cfg.key.publicKey, keySignedMessage(p, true, p.ctr), p.sig) ? { ok: true } : { ok: false, reason: "bad Ladon Key signature" };
  } else {
    const v = await verifyPasskeyAssertion(cfg, { ...p, pkg: "", ecosystem: "npm", name: "", score: 0, why: [] }, "approve", p.assertion as AuthenticationResponseJSON, { ignoreCounter: true });
    r = v.ok ? { ok: true } : { ok: false, reason: v.error };
  }
  if (cache.size > 500) cache.clear();
  cache.set(memo, r);
  return r;
}

export interface VerifiedAllowlist {
  entries: AllowlistEntry[];
  rejected: { entry: AllowlistEntry; reason: string }[];
  /** true when this exact install target is allowlisted by a verified entry */
  allows(t: InstallTarget): boolean;
}

export async function verifiedAllowlist(cfg: Pick<Config, "key" | "passkeys" | "webUrl">, state: Pick<State, "allowlist">, onWarn?: (m: string) => void): Promise<VerifiedAllowlist> {
  const entries: AllowlistEntry[] = [];
  const rejected: VerifiedAllowlist["rejected"] = [];
  for (const e of state.allowlist) {
    const r = await verifyEntry(e, cfg);
    if (r.ok) entries.push(e);
    else rejected.push({ entry: e, reason: r.reason });
  }
  const signed = rejected.filter((x) => x.entry.proof);
  if (signed.length > 0) onWarn?.(`▲ Ladon ignored ${signed.length} allowlist entr${signed.length === 1 ? "y" : "ies"} that did not verify: ${signed.map((x) => `${entryLabel(x.entry)} (${x.reason})`).join("; ")}`);
  const byTarget = new Map<string, AllowlistEntry[]>();
  for (const e of entries) byTarget.set(e.target, [...(byTarget.get(e.target) ?? []), e]);
  return {
    entries,
    rejected,
    allows(t) {
      const list = byTarget.get(allowTarget(t.ecosystem, t.name));
      if (!list) return false;
      const v = exactVersion(t.versionSpec);
      return list.some((e) => !e.version || (v !== null && v === e.version));
    },
  };
}
