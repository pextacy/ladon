import { z } from "zod";
import { PinnedPasskey, type Config } from "./config.js";

/** Client for apps/web — docs/API.md. Never sends code, prompts, paths or env (CLAUDE.md #5). */

export class WebError extends Error {}

async function call<T>(cfg: Config, path: string, schema: z.ZodType<T>, init: RequestInit & { auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) };
  if (init.auth !== false && cfg.device) headers.authorization = `Bearer ${cfg.device.token}`;
  let res: Response;
  try {
    res = await fetch(new URL(path, cfg.webUrl), { ...init, headers, signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 8000) });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new WebError(`cannot reach ${new URL(cfg.webUrl).host}`);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new WebError(`${new URL(cfg.webUrl).host}: ${msg}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new WebError(`${new URL(cfg.webUrl).host} returned unexpected data`);
  return parsed.data;
}

export const createDevice = (cfg: Config, label: string) =>
  call(cfg, "/api/devices", z.object({ deviceId: z.string(), deviceToken: z.string(), pairCode: z.string(), pairUrl: z.string() }), {
    method: "POST",
    body: JSON.stringify({ label }),
    auth: false,
  });

export const deviceMe = (cfg: Config) =>
  call(cfg, "/api/devices/me", z.object({ deviceId: z.string(), label: z.string().optional(), passkeys: z.array(PinnedPasskey.extend({ createdAt: z.string().optional() })) }));

export interface ApprovalCreate {
  id: string;
  commandHash: string;
  nonce: string;
  exp: number;
  ecosystem: "npm" | "pypi";
  package: string;
  version?: string;
  score: number;
  reasons: string[];
  intent?: { drift: string; reason: string };
}

export const createApproval = (cfg: Config, a: ApprovalCreate) =>
  call(cfg, "/api/approvals", z.object({ id: z.string(), approveUrl: z.string() }), { method: "POST", body: JSON.stringify(a) });

export const WaitResult = z.object({
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  decision: z.enum(["approve", "reject"]).optional(),
  assertion: z.unknown().optional(),
});
export type WaitResult = z.infer<typeof WaitResult>;

export const waitApproval = (cfg: Config, id: string, signal: AbortSignal) =>
  call(cfg, `/api/approvals/${encodeURIComponent(id)}/wait?timeout=25`, WaitResult, { signal });

export interface DecisionLog {
  ts: string;
  ecosystem: "npm" | "pypi";
  package: string;
  version?: string;
  verdict: "allow" | "warn" | "hold";
  score: number;
  reasons: string[];
  outcome: "allowed" | "warned" | "approved" | "rejected" | "timeout" | "blocked";
  via?: "key" | "passkey" | null;
  agent?: string;
}

export const postDecision = (cfg: Config, d: DecisionLog) => call(cfg, "/api/decisions", z.object({ ok: z.boolean() }), { method: "POST", body: JSON.stringify(d), timeoutMs: 3000 });

export const atlasReport = (cfg: Config, r: { ecosystem: "npm" | "pypi"; name: string; model?: string }) =>
  call(cfg, "/api/atlas/report", z.object({ ok: z.boolean() }), { method: "POST", body: JSON.stringify(r), auth: false, timeoutMs: 3000 });
