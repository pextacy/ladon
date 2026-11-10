import type { Ecosystem } from "@ladon/core";
import type {
  ApprovalPatch,
  ApprovalRecord,
  AtlasNameRecord,
  AtlasObservation,
  AtlasReportRecord,
  AtlasSearch,
  DecisionRecord,
  DeviceRecord,
  PairCodeRecord,
  PasskeyRecord,
  Store,
  VerdictCacheRecord,
} from "./types";

const clone = <T>(v: T): T => structuredClone(v);
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
    for (const d of this.devices.values()) if (d.tokenHash === tokenHash) return clone(d);
    return null;
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
  async addAtlasReport(r: AtlasReportRecord) {
    this.reports.push(clone(r));
  }
  /** test helper */
  reportCount() {
    return this.reports.length;
  }

  async getVerdict(ecosystem: Ecosystem, name: string, version: string) {
    const v = this.verdicts.get(`${ecosystem}:${name}@${version}`);
    return v ? clone(v) : null;
  }
  async putVerdict(r: VerdictCacheRecord) {
    this.verdicts.set(`${r.ecosystem}:${r.name}@${r.version}`, clone(r));
  }
}
