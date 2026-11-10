import type { Ecosystem } from "@ladon/core";

/**
 * Persistence for the web app. Two implementations: Supabase (production, service key server-side
 * only) and in-memory (used automatically when SUPABASE_URL / SUPABASE_SERVICE_KEY are missing).
 * All timestamps are ISO strings except approval `exp`, which is unix seconds (DOCS §6).
 */

export interface DeviceRecord {
  id: string;
  label: string;
  /** SHA-256 hex of the bearer token; the token itself is never stored */
  tokenHash: string;
  createdAt: string;
}

export interface PairCodeRecord {
  code: string;
  deviceId: string;
  expiresAt: string;
  usedAt: string | null;
  /** current WebAuthn registration challenge (base64url) */
  challenge: string | null;
  createdAt: string;
}

export interface PasskeyRecord {
  credentialId: string;
  deviceId: string;
  /** base64url COSE public key */
  publicKey: string;
  counter: number;
  label: string;
  transports: string[];
  createdAt: string;
}

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type Decision = "approve" | "reject";

export interface IntentRecord {
  drift: "none" | "weak" | "strong";
  reason: string;
}

export interface ApprovalRecord {
  id: string;
  deviceId: string;
  commandHash: string;
  nonce: string;
  /** unix seconds */
  exp: number;
  ecosystem: Ecosystem;
  package: string;
  version: string | null;
  score: number;
  reasons: string[];
  intent: IntentRecord | null;
  status: ApprovalStatus;
  decision: Decision | null;
  /** raw AuthenticationResponseJSON, stored verbatim so the daemon can verify it itself */
  assertion: unknown;
  /** credential id of the passkey that decided */
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface ApprovalPatch {
  status: Exclude<ApprovalStatus, "pending">;
  decision?: Decision | null;
  assertion?: unknown;
  decidedBy?: string | null;
  decidedAt?: string | null;
}

export const OUTCOMES = ["allowed", "warned", "approved", "rejected", "timeout", "blocked"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface DecisionRecord {
  id: string;
  deviceId: string;
  ts: string;
  ecosystem: Ecosystem;
  package: string;
  version: string | null;
  verdict: "allow" | "warn" | "hold";
  score: number;
  reasons: string[];
  outcome: Outcome;
  via: "key" | "passkey" | null;
  agent: string | null;
  createdAt: string;
}

export interface AtlasNameRecord {
  ecosystem: Ecosystem;
  name: string;
  firstSeen: string;
  models: string[];
  seenCount: number;
  registered: boolean;
  registeredAt: string | null;
  source: string | null;
  lastChecked: string | null;
}

export interface AtlasObservation {
  ecosystem: Ecosystem;
  name: string;
  model: string | null;
  source: string | null;
  /** registry status at observation time */
  registered: boolean;
  at: string;
}

export interface AtlasReportRecord {
  ecosystem: Ecosystem;
  name: string;
  model: string | null;
  ts: string;
}

export interface AtlasSearch {
  ecosystem?: Ecosystem;
  q?: string;
  limit: number;
  offset?: number;
}

export interface VerdictCacheRecord {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** the cached public API result */
  evidence: unknown;
  score: number;
  computedAt: string;
}

export interface Store {
  readonly kind: "memory" | "supabase";
  ping(): Promise<void>;

  createDevice(d: DeviceRecord): Promise<void>;
  getDevice(id: string): Promise<DeviceRecord | null>;
  getDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;

  createPairCode(p: PairCodeRecord): Promise<void>;
  getPairCode(code: string): Promise<PairCodeRecord | null>;
  setPairChallenge(code: string, challenge: string): Promise<void>;
  /** marks the code used; false if it was already used */
  consumePairCode(code: string, at: string): Promise<boolean>;

  addPasskey(p: PasskeyRecord): Promise<void>;
  getPasskey(credentialId: string): Promise<PasskeyRecord | null>;
  listPasskeys(deviceId: string): Promise<PasskeyRecord[]>;
  updatePasskeyCounter(credentialId: string, counter: number): Promise<void>;

  /** "exists" when an approval with that id already exists */
  createApproval(a: ApprovalRecord): Promise<"ok" | "exists">;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  /** compare-and-set from pending; false when the approval is no longer pending */
  transitionApproval(id: string, patch: ApprovalPatch): Promise<boolean>;
  listApprovals(deviceId: string, limit: number): Promise<ApprovalRecord[]>;

  addDecision(d: DecisionRecord): Promise<void>;
  listDecisions(deviceId: string, limit: number): Promise<DecisionRecord[]>;

  getAtlasName(ecosystem: Ecosystem, name: string): Promise<AtlasNameRecord | null>;
  searchAtlas(s: AtlasSearch): Promise<{ entries: AtlasNameRecord[]; total: number }>;
  /** insert, or bump seen_count and merge the model into models */
  observeAtlasName(o: AtlasObservation): Promise<void>;
  setAtlasRegistered(ecosystem: Ecosystem, name: string, registeredAt: string | null, checkedAt: string): Promise<void>;
  listAtlasUnregistered(limit: number): Promise<AtlasNameRecord[]>;
  addAtlasReport(r: AtlasReportRecord): Promise<void>;

  getVerdict(ecosystem: Ecosystem, name: string, version: string): Promise<VerdictCacheRecord | null>;
  putVerdict(r: VerdictCacheRecord): Promise<void>;
}
