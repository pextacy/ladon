export type ProbeStatus = "ok" | "down" | "not_configured";
export interface Probe { status: ProbeStatus; ms?: number; error?: string }

export async function probe(url: string, init: RequestInit = {}, timeoutMs = 3000): Promise<Probe> {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    const ms = Date.now() - started;
    return res.ok ? { status: "ok", ms } : { status: "down", ms, error: `HTTP ${res.status}` };
  } catch (e) {
    return { status: "down", ms: Date.now() - started, error: e instanceof Error ? e.name : "error" };
  }
}

export async function probeDb(env: Record<string, string | undefined>): Promise<Probe> {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_ANON_KEY;
  if (!url || !key) return { status: "not_configured" };
  return probe(`${url.replace(/\/$/, "")}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
}

/** Core data sources must be reachable; DB may be not_configured during Phase 0. */
export function overall(checks: Record<string, Probe>): "ok" | "degraded" {
  return Object.values(checks).some((c) => c.status === "down") ? "degraded" : "ok";
}
