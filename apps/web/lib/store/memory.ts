import type { Ecosystem } from "@ladon/core";
import { safeEqual } from "../tokens";
import type {
  ApprovalPatch,
  ApprovalRecord,
  AtlasAlertQuery,
  AtlasNameRecord,
  AtlasObservation,
  AtlasReportRecord,
  AtlasSearch,
  DecisionRecord,
  DeviceKeyRecord,
  DeviceRecord,
  PairCodeRecord,
  PasskeyRecord,
  RateTake,
  Store,
  VerdictCacheRecord,
} from "./types";

const clone = <T>(v: T): T => structuredClone(v);

/** Registered strictly after we first saw it as hallucinated — the slopsquat signal. */
export function isAtlasAlert(e: Pick<AtlasNameRecord, "registered" | "registeredAt" | "firstSeen">): boolean {
  if (!e.registered || !e.registeredAt) return false;
  const r = Date.parse(e.registeredAt);
  const f = Date.parse(e.firstSeen);
  return Number.isFinite(r) && Number.isFinite(f) && r > f;
}
const atlasKey = (eco: Ecosystem, name: string) => `${eco}:${name}`;

/** In-process store for local dev and tests. Data lives until the process exits. */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private devices = new Map<string, DeviceRecord>();
  private pairCodes = new Map<string, PairCodeRecord>();
  private passkeys = new Map<string, PasskeyRecord>();
  private approvals = new Map<string, ApprovalRecord>();
  private decisions: DecisionRecord[] = [];
  private atlas = new Map<string, AtlasNameRecord>();
  private reports: AtlasReportRecord[] = [];
  private verdicts = new Map<string, VerdictCacheRecord>();
  private deviceKeys = new Map<string, DeviceKeyRecord>();
  private rates = new Map<string, { windowStart: number; used: number }>();
  /** clock for rateTake (tests) */
  now: () => number = Date.now;

  constructor(seed: AtlasNameRecord[] = []) {
    for (const e of seed) this.atlas.set(atlasKey(e.ecosystem, e.name), clone(e));
  }

  async ping() {}

  async createDevice(d: DeviceRecord) {
    this.devices.set(d.id, clone(d));
  }
  async getDevice(id: string) {
    const d = this.devices.get(id);
    return d ? clone(d) : null;
  }
  async getDeviceByTokenHash(tokenHash: string) {
    // constant-time compare, and scan every device so timing doesn't depend on which one matched
    let found: DeviceRecord | null = null;
    for (const d of this.devices.values()) if (safeEqual(d.tokenHash, tokenHash) && !found) found = d;
    return found ? clone(found) : null;
  }

  async createPairCode(p: PairCodeRecord) {
    this.pairCodes.set(p.code, clone(p));
  }
  async getPairCode(code: string) {
    const p = this.pairCodes.get(code);
    return p ? clone(p) : null;
  }
  async setPairChallenge(code: string, challenge: string) {
    const p = this.pairCodes.get(code);
    if (p) p.challenge = challenge;
  }
  async consumePairCode(code: string, at: string) {
    const p = this.pairCodes.get(code);
    if (!p || p.usedAt) return false;
    p.usedAt = at;
    return true;
  }

  async addPasskey(p: PasskeyRecord) {
    this.passkeys.set(p.credentialId, clone(p));
  }
  async getPasskey(credentialId: string) {
    const p = this.passkeys.get(credentialId);
    return p ? clone(p) : null;
  }
  async listPasskeys(deviceId: string) {
    return [...this.passkeys.values()].filter((p) => p.deviceId === deviceId).map(clone);
  }
  async updatePasskeyCounter(credentialId: string, counter: number) {
    const p = this.passkeys.get(credentialId);
    if (p) p.counter = counter;
  }

  async createApproval(a: ApprovalRecord) {
    if (this.approvals.has(a.id)) return "exists" as const;
    this.approvals.set(a.id, clone(a));
    return "ok" as const;
  }
  async getApproval(id: string) {
    const a = this.approvals.get(id);
    return a ? clone(a) : null;
  }
  async transitionApproval(id: string, patch: ApprovalPatch) {
    const a = this.approvals.get(id);
    if (!a || a.status !== "pending") return false;
    a.status = patch.status;
    if (patch.decision !== undefined) a.decision = patch.decision;
    if (patch.assertion !== undefined) a.assertion = clone(patch.assertion);
    if (patch.decidedBy !== undefined) a.decidedBy = patch.decidedBy;
    if (patch.decidedAt !== undefined) a.decidedAt = patch.decidedAt;
    return true;
  }
  async listApprovals(deviceId: string, limit: number) {
    return [...this.approvals.values()]
      .filter((a) => a.deviceId === deviceId)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async addDecision(d: DecisionRecord) {
    this.decisions.push(clone(d));
  }
  async listDecisions(deviceId: string, limit: number) {
    return this.decisions
      .filter((d) => d.deviceId === deviceId)
      .sort((x, y) => y.ts.localeCompare(x.ts))
      .slice(0, limit)
      .map(clone);
  }

  async getAtlasName(ecosystem: Ecosystem, name: string) {
    const e = this.atlas.get(atlasKey(ecosystem, name));
    return e ? clone(e) : null;
  }
  async searchAtlas(s: AtlasSearch) {
    const q = s.q?.toLowerCase().trim();
    const all = [...this.atlas.values()]
      .filter((e) => (!s.ecosystem || e.ecosystem === s.ecosystem) && (!q || e.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.registered) - Number(a.registered) || (b.registeredAt ?? "").localeCompare(a.registeredAt ?? "") || b.seenCount - a.seenCount || a.name.localeCompare(b.name));
    const offset = s.offset ?? 0;
    return { entries: all.slice(offset, offset + s.limit).map(clone), total: all.length };
  }
  async observeAtlasName(o: AtlasObservation) {
    const k = atlasKey(o.ecosystem, o.name);
    const e = this.atlas.get(k);
    if (!e) {
      this.atlas.set(k, {
        ecosystem: o.ecosystem,
        name: o.name,
        firstSeen: o.at,
        models: o.model ? [o.model] : [],
        seenCount: 1,
        registered: o.registered,
        registeredAt: null,
        source: o.source,
        lastChecked: o.at,
      });
      return;
    }
    e.seenCount += 1;
    if (o.model && !e.models.includes(o.model)) e.models.push(o.model);
    if (!e.source && o.source) e.source = o.source;
  }
  async setAtlasRegistered(ecosystem: Ecosystem, name: string, registeredAt: string | null, checkedAt: string) {
    const e = this.atlas.get(atlasKey(ecosystem, name));
    if (!e) return;
    e.lastChecked = checkedAt;
    if (registeredAt) {
      e.registered = true;
      e.registeredAt = e.registeredAt ?? registeredAt;
    }
  }
  async listAtlasUnregistered(limit: number) {
    return [...this.atlas.values()].filter((e) => !e.registered).slice(0, limit).map(clone);
  }
  async listAtlasAlerts(q: AtlasAlertQuery) {
    const since = q.since ? Date.parse(q.since) : -Infinity;
    return [...this.atlas.values()]
      .filter((e) => isAtlasAlert(e) && (!q.ecosystem || e.ecosystem === q.ecosystem) && Date.parse(e.registeredAt!) >= since)
      .sort((a, b) => b.registeredAt!.localeCompare(a.registeredAt!) || a.name.localeCompare(b.name))
      .slice(0, q.limit)
      .map(clone);
  }
  async addAtlasReport(r: AtlasReportRecord) {
    this.reports.push(clone(r));
  }
  /** test helper */
  reportCount() {
    return this.reports.length;
  }

  async addDeviceKey(k: DeviceKeyRecord) {
    const id = `${k.deviceId}:${k.publicKey}`;
    const prev = this.deviceKeys.get(id);
    this.deviceKeys.set(id, clone({ ...k, createdAt: prev?.createdAt ?? k.createdAt }));
  }
  async listDeviceKeys(deviceId: string) {
    return [...this.deviceKeys.values()].filter((k) => k.deviceId === deviceId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
  }

  async rateTake(bucket: string, limit: number, windowSeconds: number, cost: number): Promise<RateTake> {
    const w = windowSeconds * 1000;
    const t = this.now();
    const windowStart = Math.floor(t / w) * w;
    let e = this.rates.get(bucket);
    if (!e || e.windowStart !== windowStart) {
      if (this.rates.size >= 10_000) for (const [k, v] of this.rates) if (v.windowStart < windowStart) this.rates.delete(k);
      e = { windowStart, used: 0 };
      this.rates.set(bucket, e);
    }
    const resetAt = new Date(windowStart + w).toISOString();
    if (e.used + cost > limit) return { ok: false, used: e.used, resetAt };
    e.used += cost;
    return { ok: true, used: e.used, resetAt };
  }

  async getVerdict(ecosystem: Ecosystem, name: string, version: string) {
    const v = this.verdicts.get(`${ecosystem}:${name}@${version}`);
    return v ? clone(v) : null;
  }
  async putVerdict(r: VerdictCacheRecord) {
    this.verdicts.set(`${r.ecosystem}:${r.name}@${r.version}`, clone(r));
  }
}
