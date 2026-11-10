import { passkeyChallenge } from "@ladon/core";
import type { ApprovalRecord, ApprovalStatus, Decision, Store } from "./store/types";
import type { CreateApprovalBody } from "./validate";

/**
 * Approval state machine (docs/API.md):
 *   pending → approved | rejected   only with a verified WebAuthn assertion
 *   pending → expired               when now > exp
 * Terminal states never change. There is no transition without an assertion or the clock.
 */

/** Longest an approval may stay open; the daemon uses 120 s (core APPROVAL_TTL_SECONDS). */
export const MAX_APPROVAL_TTL_SECONDS = 15 * 60;

export const nowSeconds = (now = Date.now()) => Math.floor(now / 1000);

export function effectiveStatus(a: Pick<ApprovalRecord, "status" | "exp">, nowSec: number): ApprovalStatus {
  return a.status === "pending" && nowSec > a.exp ? "expired" : a.status;
}

export function validateExpiry(exp: number, nowSec: number): string | null {
  if (exp <= nowSec) return "exp is in the past — the request already expired";
  if (exp > nowSec + MAX_APPROVAL_TTL_SECONDS) return `exp is more than ${MAX_APPROVAL_TTL_SECONDS / 60} minutes away`;
  return null;
}

export function newApprovalRecord(body: CreateApprovalBody, deviceId: string, createdAt: string): ApprovalRecord {
  return {
    id: body.id,
    deviceId,
    commandHash: body.commandHash,
    nonce: body.nonce,
    exp: body.exp,
    ecosystem: body.ecosystem,
    package: body.package,
    version: body.version ?? null,
    score: body.score,
    reasons: body.reasons,
    intent: body.intent ?? null,
    status: "pending",
    decision: null,
    assertion: null,
    decidedBy: null,
    decidedAt: null,
    createdAt,
  };
}

/** The exact challenge the passkey signs: decision is bound in (core passkeyChallenge). */
export function challengeFor(a: Pick<ApprovalRecord, "id" | "commandHash" | "nonce" | "exp">, decision: Decision): string {
  return passkeyChallenge({ id: a.id, h: a.commandHash, n: a.nonce, exp: a.exp }, decision);
}

export type DecideCheck = { ok: true } | { ok: false; status: number; error: string; current: ApprovalStatus };

/** Can a decision still be recorded? (before any WebAuthn work) */
export function canDecide(a: Pick<ApprovalRecord, "status" | "exp">, nowSec: number): DecideCheck {
  const s = effectiveStatus(a, nowSec);
  if (s === "pending") return { ok: true };
  if (s === "expired") return { ok: false, status: 410, error: "this request expired — the install was blocked; ask the agent to retry if you still want it", current: s };
  return { ok: false, status: 409, error: `this request was already ${s}`, current: s };
}

/** Persist expiry lazily so every reader sees the same terminal state. */
export async function refreshStatus(store: Store, a: ApprovalRecord, nowSec: number): Promise<ApprovalRecord> {
  if (a.status === "pending" && effectiveStatus(a, nowSec) === "expired") {
    await store.transitionApproval(a.id, { status: "expired" });
    return (await store.getApproval(a.id)) ?? { ...a, status: "expired" };
  }
  return a;
}

export function publicView(a: ApprovalRecord, nowSec: number) {
  return {
    id: a.id,
    package: a.package,
    version: a.version,
    ecosystem: a.ecosystem,
    score: a.score,
    reasons: a.reasons,
    intent: a.intent,
    status: effectiveStatus(a, nowSec),
    exp: a.exp,
    createdAt: a.createdAt,
  };
}
export type PublicApproval = ReturnType<typeof publicView>;

export function waitView(a: ApprovalRecord, nowSec: number) {
  const status = effectiveStatus(a, nowSec);
  if (status === "approved" || status === "rejected") {
    return { status, ...(a.decision ? { decision: a.decision } : {}), ...(a.assertion ? { assertion: a.assertion } : {}) };
  }
  return { status };
}

export interface WaitOptions {
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** Long-poll until the approval leaves pending or the timeout passes. */
export async function waitForApproval(store: Store, id: string, timeoutMs: number, opts: WaitOptions = {}): Promise<ApprovalRecord | null> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 750;
  const deadline = now() + timeoutMs;
  for (;;) {
    let a = await store.getApproval(id);
    if (!a) return null;
    a = await refreshStatus(store, a, nowSeconds(now()));
    if (a.status !== "pending" || now() >= deadline || opts.signal?.aborted) return a;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}
