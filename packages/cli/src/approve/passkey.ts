import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { passkeyChallenge } from "@ladon/core";
import { loadConfig, loadState, saveConfig, saveState, type Config } from "../config.js";
import { createApproval, deviceMe, waitApproval, WebError } from "../web.js";
import type { ApprovalOutcome, Approver, PendingApproval } from "./types.js";

/**
 * Passkey approval: the web app collects a WebAuthn assertion on the human's phone, but the daemon
 * verifies it itself against passkeys pinned at pairing time (TOFU). The server is a mailbox, not a
 * trusted party — it cannot approve on its own.
 */
export async function verifyPasskeyAssertion(
  cfg: Pick<Config, "webUrl" | "passkeys">,
  req: PendingApproval,
  decision: "approve" | "reject",
  assertion: AuthenticationResponseJSON,
  opts: { ignoreCounter?: boolean } = {},
): Promise<{ ok: true; credentialId: string; newCounter: number } | { ok: false; error: string }> {
  const pinned = cfg.passkeys.find((p) => p.credentialId === assertion.id);
  if (!pinned) return { ok: false, error: "assertion from a passkey that is not paired with this machine" };
  const origin = new URL(cfg.webUrl).origin;
  try {
    const v = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: passkeyChallenge(req, decision),
      expectedOrigin: origin,
      expectedRPID: new URL(cfg.webUrl).hostname,
      // ignoreCounter: re-verifying a stored proof (allowlist) — replay is prevented by the bound hash instead
      credential: { id: pinned.credentialId, publicKey: new Uint8Array(Buffer.from(pinned.publicKey, "base64url")), counter: opts.ignoreCounter ? 0 : pinned.counter },
      requireUserVerification: true,
    });
    if (!v.verified) return { ok: false, error: "passkey assertion did not verify" };
    return { ok: true, credentialId: pinned.credentialId, newCounter: v.authenticationInfo.newCounter };
  } catch (e) {
    return { ok: false, error: `passkey assertion rejected: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function passkeyApprover(): Approver {
  return {
    via: "passkey",
    async ready() {
      const cfg = loadConfig();
      if (!cfg.device) return { ok: false, detail: "no device registered (ladon init)" };
      if (cfg.passkeys.length === 0) return { ok: false, detail: "no passkey paired (ladon passkey pair)" };
      return { ok: true, detail: `${cfg.passkeys.length} passkey(s) paired` };
    },
    async request(req, signal, onStatus) {
      const cfg = loadConfig();
      if (!cfg.device || cfg.passkeys.length === 0) return { kind: "unavailable", detail: "no passkey paired" };
      let approveUrl: string;
      try {
        const create: Parameters<typeof createApproval>[1] = { id: req.id, commandHash: req.h, nonce: req.n, exp: req.exp, ecosystem: req.ecosystem, package: req.name, score: req.score, reasons: req.why };
        if (req.version) create.version = req.version;
        if (req.intent) create.intent = req.intent;
        approveUrl = (await createApproval(cfg, create)).approveUrl;
      } catch (e) {
        return { kind: "unavailable", detail: e instanceof Error ? e.message : String(e) };
      }
      onStatus?.(`approve on your phone: ${approveUrl}`);
      while (!signal.aborted && Date.now() / 1000 < req.exp + 2) {
        let w;
        try {
          w = await waitApproval(cfg, req.id, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
        } catch (e) {
          if (signal.aborted) break;
          if (e instanceof WebError) await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (w.status === "pending") continue;
        if (w.status === "expired") return { kind: "timeout", detail: "passkey approval expired" };
        const decision = w.decision ?? (w.status === "approved" ? "approve" : "reject");
        const v = await verifyPasskeyAssertion(cfg, req, decision, w.assertion as AuthenticationResponseJSON);
        if (!v.ok) {
          // A response we cannot verify is treated as a rejection — never as an approval.
          return { kind: "rejected", via: "passkey", detail: v.error };
        }
        const state = loadState();
        if (state.usedNonces.includes(req.n)) return { kind: "rejected", via: "passkey", detail: "nonce already used (replay)" };
        state.usedNonces.push(req.n);
        saveState(state);
        const fresh = loadConfig();
        fresh.passkeys = fresh.passkeys.map((p) => (p.credentialId === v.credentialId ? { ...p, counter: Math.max(p.counter, v.newCounter) } : p));
        saveConfig(fresh);
        if (decision !== "approve") return { kind: "rejected", via: "passkey", detail: "rejected with passkey" };
        const proof = { via: "passkey" as const, id: req.id, h: req.h, n: req.n, exp: req.exp, decision: "approve" as const, assertion: w.assertion };
        return { kind: "approved", via: "passkey", detail: "approved with passkey", proof };
      }
      return { kind: "timeout", detail: "no passkey decision in time" };
    },
  };
}

export interface ServerPasskey {
  credentialId: string;
  publicKey: string;
  counter: number;
  label?: string;
  createdAt?: string;
}

/** Passkeys the server lists for this device. Listing never pins — pinning needs a human (see init.ts). */
export async function serverPasskeys(): Promise<ServerPasskey[]> {
  const cfg = loadConfig();
  if (!cfg.device) throw new WebError("no device registered — run ladon init");
  const me = await deviceMe(cfg);
  return me.passkeys.map((p) => {
    const out: ServerPasskey = { credentialId: p.credentialId, publicKey: p.publicKey, counter: p.counter };
    if (p.label) out.label = p.label;
    if (p.createdAt) out.createdAt = p.createdAt;
    return out;
  });
}

export function pinPasskey(p: ServerPasskey) {
  const cfg = loadConfig();
  if (cfg.passkeys.some((x) => x.credentialId === p.credentialId)) return;
  const pin: Config["passkeys"][number] = { credentialId: p.credentialId, publicKey: p.publicKey, counter: p.counter };
  if (p.label) pin.label = p.label;
  cfg.passkeys.push(pin);
  saveConfig(cfg);
}
