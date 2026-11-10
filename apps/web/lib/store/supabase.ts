import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
  IntentRecord,
  PairCodeRecord,
  PasskeyRecord,
  Store,
  VerdictCacheRecord,
} from "./types";

/* Row shapes as stored in Postgres (supabase/migrations/0001_init.sql). */
interface DeviceRow { id: string; label: string; token_hash: string; created_at: string }
interface PairRow { code: string; device_id: string; expires_at: string; used_at: string | null; challenge: string | null; created_at: string }
interface PasskeyRow { credential_id: string; device_id: string; public_key: string; counter: number; label: string; transports: string[] | null; created_at: string }
interface ApprovalRow {
  id: string; device_id: string; command_hash: string; nonce: string; exp: number; ecosystem: Ecosystem; package: string; version: string | null;
  score: number; reasons: string[]; intent: IntentRecord | null; status: ApprovalRecord["status"]; decision: ApprovalRecord["decision"];
  assertion: unknown; decided_by: string | null; decided_at: string | null; created_at: string;
}
interface DecisionRow {
  id: string; device_id: string; ts: string; ecosystem: Ecosystem; package: string; version: string | null; verdict: DecisionRecord["verdict"];
  score: number; reasons: string[]; outcome: DecisionRecord["outcome"]; via: DecisionRecord["via"]; agent: string | null; created_at: string;
}
interface AtlasRow {
  ecosystem: Ecosystem; name: string; first_seen: string; models: string[] | null; seen_count: number; registered: boolean;
  registered_at: string | null; source: string | null; last_checked: string | null;
}
interface VerdictRow { ecosystem: Ecosystem; name: string; version: string; evidence: unknown; score: number; computed_at: string }

const device = (r: DeviceRow): DeviceRecord => ({ id: r.id, label: r.label, tokenHash: r.token_hash, createdAt: r.created_at });
const pair = (r: PairRow): PairCodeRecord => ({ code: r.code, deviceId: r.device_id, expiresAt: r.expires_at, usedAt: r.used_at, challenge: r.challenge, createdAt: r.created_at });
const passkey = (r: PasskeyRow): PasskeyRecord => ({
  credentialId: r.credential_id, deviceId: r.device_id, publicKey: r.public_key, counter: Number(r.counter), label: r.label, transports: r.transports ?? [], createdAt: r.created_at,
});
const approval = (r: ApprovalRow): ApprovalRecord => ({
  id: r.id, deviceId: r.device_id, commandHash: r.command_hash, nonce: r.nonce, exp: Number(r.exp), ecosystem: r.ecosystem, package: r.package,
  version: r.version, score: r.score, reasons: r.reasons ?? [], intent: r.intent, status: r.status, decision: r.decision, assertion: r.assertion,
  decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at,
});
const decision = (r: DecisionRow): DecisionRecord => ({
  id: r.id, deviceId: r.device_id, ts: r.ts, ecosystem: r.ecosystem, package: r.package, version: r.version, verdict: r.verdict, score: r.score,
  reasons: r.reasons ?? [], outcome: r.outcome, via: r.via, agent: r.agent, createdAt: r.created_at,
});
const atlas = (r: AtlasRow): AtlasNameRecord => ({
  ecosystem: r.ecosystem, name: r.name, firstSeen: r.first_seen, models: r.models ?? [], seenCount: r.seen_count, registered: r.registered,
  registeredAt: r.registered_at, source: r.source, lastChecked: r.last_checked,
});

class DbError extends Error {}
function check<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new DbError(`database error (${what}): ${res.error.message}`);
  return res.data;
}

/** Escape LIKE wildcards in user search input. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class SupabaseStore implements Store {
  readonly kind = "supabase" as const;
  private db: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async ping() {
    check(await this.db.from("atlas_names").select("name", { head: true, count: "exact" }).limit(1), "ping");
  }

  async createDevice(d: DeviceRecord) {
    check(await this.db.from("devices").insert({ id: d.id, label: d.label, token_hash: d.tokenHash, kind: "passkey", created_at: d.createdAt }), "create device");
  }
  async getDevice(id: string) {
    const r = check(await this.db.from("devices").select("id,label,token_hash,created_at").eq("id", id).maybeSingle(), "get device") as DeviceRow | null;
    return r ? device(r) : null;
  }
  async getDeviceByTokenHash(tokenHash: string) {
    const r = check(await this.db.from("devices").select("id,label,token_hash,created_at").eq("token_hash", tokenHash).maybeSingle(), "get device") as DeviceRow | null;
    return r ? device(r) : null;
  }

  async createPairCode(p: PairCodeRecord) {
    check(await this.db.from("pair_codes").insert({ code: p.code, device_id: p.deviceId, expires_at: p.expiresAt, used_at: p.usedAt, challenge: p.challenge, created_at: p.createdAt }), "create pair code");
  }
  async getPairCode(code: string) {
    const r = check(await this.db.from("pair_codes").select("*").eq("code", code).maybeSingle(), "get pair code") as PairRow | null;
    return r ? pair(r) : null;
  }
  async setPairChallenge(code: string, challenge: string) {
    check(await this.db.from("pair_codes").update({ challenge }).eq("code", code), "set challenge");
  }
  async consumePairCode(code: string, at: string) {
    const rows = check(await this.db.from("pair_codes").update({ used_at: at }).eq("code", code).is("used_at", null).select("code"), "consume pair code") as { code: string }[] | null;
    return (rows ?? []).length === 1;
  }

  async addPasskey(p: PasskeyRecord) {
    check(
      await this.db.from("passkeys").insert({
        credential_id: p.credentialId, device_id: p.deviceId, public_key: p.publicKey, counter: p.counter, label: p.label, transports: p.transports, created_at: p.createdAt,
      }),
      "add passkey",
    );
  }
  async getPasskey(credentialId: string) {
    const r = check(await this.db.from("passkeys").select("*").eq("credential_id", credentialId).maybeSingle(), "get passkey") as PasskeyRow | null;
    return r ? passkey(r) : null;
  }
  async listPasskeys(deviceId: string) {
    const rows = check(await this.db.from("passkeys").select("*").eq("device_id", deviceId).order("created_at"), "list passkeys") as PasskeyRow[] | null;
    return (rows ?? []).map(passkey);
  }
  async updatePasskeyCounter(credentialId: string, counter: number) {
    check(await this.db.from("passkeys").update({ counter }).eq("credential_id", credentialId), "update counter");
  }

  async createApproval(a: ApprovalRecord) {
    const res = await this.db.from("approval_requests").insert({
      id: a.id, device_id: a.deviceId, command_hash: a.commandHash, nonce: a.nonce, exp: a.exp, ecosystem: a.ecosystem, package: a.package,
      version: a.version, score: a.score, reasons: a.reasons, intent: a.intent, status: a.status, created_at: a.createdAt,
    });
    if (res.error?.code === "23505") return "exists" as const;
    check(res, "create approval");
    return "ok" as const;
  }
  async getApproval(id: string) {
    const r = check(await this.db.from("approval_requests").select("*").eq("id", id).maybeSingle(), "get approval") as ApprovalRow | null;
    return r ? approval(r) : null;
  }
  async transitionApproval(id: string, patch: ApprovalPatch) {
    const upd: Record<string, unknown> = { status: patch.status };
    if (patch.decision !== undefined) upd.decision = patch.decision;
    if (patch.assertion !== undefined) upd.assertion = patch.assertion;
    if (patch.decidedBy !== undefined) upd.decided_by = patch.decidedBy;
    if (patch.decidedAt !== undefined) upd.decided_at = patch.decidedAt;
    const rows = check(await this.db.from("approval_requests").update(upd).eq("id", id).eq("status", "pending").select("id"), "transition approval") as { id: string }[] | null;
    return (rows ?? []).length === 1;
  }
  async listApprovals(deviceId: string, limit: number) {
    const rows = check(await this.db.from("approval_requests").select("*").eq("device_id", deviceId).order("created_at", { ascending: false }).limit(limit), "list approvals") as ApprovalRow[] | null;
    return (rows ?? []).map(approval);
  }

  async addDecision(d: DecisionRecord) {
    check(
      await this.db.from("decisions").insert({
        id: d.id, device_id: d.deviceId, ts: d.ts, ecosystem: d.ecosystem, package: d.package, version: d.version, verdict: d.verdict, score: d.score,
        reasons: d.reasons, outcome: d.outcome, via: d.via, agent: d.agent, created_at: d.createdAt,
      }),
      "add decision",
    );
  }
  async listDecisions(deviceId: string, limit: number) {
    const rows = check(await this.db.from("decisions").select("*").eq("device_id", deviceId).order("ts", { ascending: false }).limit(limit), "list decisions") as DecisionRow[] | null;
    return (rows ?? []).map(decision);
  }

  async getAtlasName(ecosystem: Ecosystem, name: string) {
    const r = check(await this.db.from("atlas_names").select("*").eq("ecosystem", ecosystem).eq("name", name).maybeSingle(), "atlas lookup") as AtlasRow | null;
    return r ? atlas(r) : null;
  }
  async searchAtlas(s: AtlasSearch) {
    let q = this.db.from("atlas_names").select("*", { count: "exact" });
    if (s.ecosystem) q = q.eq("ecosystem", s.ecosystem);
    if (s.q?.trim()) q = q.ilike("name", `%${likeEscape(s.q.trim())}%`);
    const offset = s.offset ?? 0;
    const res = await q
      .order("registered", { ascending: false })
      .order("registered_at", { ascending: false, nullsFirst: false })
      .order("seen_count", { ascending: false })
      .order("name")
      .range(offset, offset + s.limit - 1);
    const rows = check(res, "atlas search") as AtlasRow[] | null;
    return { entries: (rows ?? []).map(atlas), total: res.count ?? 0 };
  }
  async observeAtlasName(o: AtlasObservation) {
    check(
      await this.db.rpc("atlas_observe", { p_ecosystem: o.ecosystem, p_name: o.name, p_model: o.model, p_source: o.source, p_registered: o.registered, p_at: o.at }),
      "atlas observe",
    );
  }
  async setAtlasRegistered(ecosystem: Ecosystem, name: string, registeredAt: string | null, checkedAt: string) {
    const upd: Record<string, unknown> = { last_checked: checkedAt };
    if (registeredAt) Object.assign(upd, { registered: true, registered_at: registeredAt });
    let q = this.db.from("atlas_names").update(upd).eq("ecosystem", ecosystem).eq("name", name);
    if (registeredAt) q = q.is("registered_at", null);
    check(await q, "atlas registered");
  }
  async listAtlasUnregistered(limit: number) {
    const rows = check(
      await this.db.from("atlas_names").select("*").eq("registered", false).order("last_checked", { ascending: true, nullsFirst: true }).limit(limit),
      "atlas unregistered",
    ) as AtlasRow[] | null;
    return (rows ?? []).map(atlas);
  }
  async addAtlasReport(r: AtlasReportRecord) {
    check(await this.db.from("atlas_reports").insert({ ecosystem: r.ecosystem, name: r.name, model: r.model, ts: r.ts }), "atlas report");
  }

  async getVerdict(ecosystem: Ecosystem, name: string, version: string) {
    const r = check(await this.db.from("verdict_cache").select("*").eq("ecosystem", ecosystem).eq("name", name).eq("version", version).maybeSingle(), "verdict cache") as VerdictRow | null;
    return r ? { ecosystem: r.ecosystem, name: r.name, version: r.version, evidence: r.evidence, score: r.score, computedAt: r.computed_at } : null;
  }
  async putVerdict(r: VerdictCacheRecord) {
    check(
      await this.db.from("verdict_cache").upsert({ ecosystem: r.ecosystem, name: r.name, version: r.version, evidence: r.evidence, score: r.score, computed_at: r.computedAt }),
      "verdict cache put",
    );
  }
}
