/** Alert webhook for newly registered Atlas names (ATLAS_ALERT_WEBHOOK_URL). Never throws. */

export interface RegistrationAlert {
  ecosystem: "npm" | "pypi";
  name: string;
  registeredAt: string;
  models: string[];
}

export type PostLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export function webhookPayload(a: RegistrationAlert) {
  const who = a.models.length ? `hallucinated by ${a.models.join(", ")}` : "a known hallucinated name";
  const text = `Ladon Atlas: ${a.ecosystem === "pypi" ? "PyPI" : "npm"} package "${a.name}" was just registered (${a.registeredAt.slice(0, 10)}) — ${who}. Likely slopsquat.`;
  // `text` for Slack, `content` for Discord; the structured fields for anything else.
  return { text, content: text, ecosystem: a.ecosystem, name: a.name, registeredAt: a.registeredAt, models: a.models };
}

/** POST one alert. Returns whether it was delivered; errors and timeouts are reported, not thrown. */
export async function postAlertWebhook(
  url: string,
  a: RegistrationAlert,
  opts: { fetch?: PostLike; timeoutMs?: number; log?: (m: string) => void } = {},
): Promise<boolean> {
  const f = opts.fetch ?? (fetch as unknown as PostLike);
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "ladon-atlas" },
      body: JSON.stringify(webhookPayload(a)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) opts.log?.(`  alert webhook answered HTTP ${res.status} for ${a.ecosystem}:${a.name}`);
    return res.ok;
  } catch (e) {
    opts.log?.(`  alert webhook failed for ${a.ecosystem}:${a.name}: ${e instanceof Error ? e.name : "error"}`);
    return false;
  }
}
