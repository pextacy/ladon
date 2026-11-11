import { z } from "zod";
import { ProbeOutput } from "./extract";

/**
 * Model routing for the Atlas probe. A model id is "<provider>:<model>" or a bare Anthropic id:
 *   claude-opus-5-5                     → Anthropic (SDK, structured output)
 *   openai:gpt-5-mini                   → OPENAI_API_KEY at OPENAI_BASE_URL (default api.openai.com/v1)
 *   openrouter:meta-llama/llama-4-scout → OPENROUTER_API_KEY at openrouter.ai/api/v1
 * Every OpenAI-compatible call asks for JSON output; the answer is validated again by extractNames.
 */

export type Provider = "anthropic" | "openai" | "openrouter";
export interface ModelRoute {
  provider: Provider;
  /** id sent to the provider and recorded in the Atlas */
  model: string;
}

export function routeModel(id: string): ModelRoute {
  const m = /^(anthropic|openai|openrouter):(.+)$/.exec(id.trim());
  if (!m) return { provider: "anthropic", model: id.trim() };
  return { provider: m[1] as Provider, model: m[2]!.trim() };
}

type Env = Record<string, string | undefined>;

export interface CompatConfig {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

/** Endpoint + key for an OpenAI-compatible provider, or null when its key is not set. */
export function compatConfig(provider: Exclude<Provider, "anthropic">, env: Env = process.env): CompatConfig | null {
  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) return null;
    return { baseUrl: (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""), apiKey: env.OPENAI_API_KEY };
  }
  if (!env.OPENROUTER_API_KEY) return null;
  return { baseUrl: "https://openrouter.ai/api/v1", apiKey: env.OPENROUTER_API_KEY, headers: { "x-title": "Ladon Atlas probe" } };
}

export function hasCredentials(provider: Provider, env: Env = process.env): boolean {
  return provider === "anthropic" ? !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) : compatConfig(provider, env) !== null;
}

export type FetchJson = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const ChatResponse = z.object({
  choices: z
    .array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({ content: z.string().nullable().optional(), refusal: z.string().nullable().optional() }) }))
    .min(1),
});

const SCHEMA = z.toJSONSchema(ProbeOutput) as Record<string, unknown>;
delete SCHEMA.$schema;

/** Fatal for the whole run (bad key): the caller stops instead of burning the rest of the cap. */
export class ProviderAuthError extends Error {}

/**
 * One chat completion with JSON output. Tries a strict json_schema first; if the endpoint rejects
 * that (400 — many compatible servers only know json_object), retries once with json_object.
 * Returns the parsed JSON, or null on refusal / truncation / unparseable output / API error.
 */
export async function compatAsk(
  cfg: CompatConfig,
  model: string,
  system: string,
  user: string,
  opts: { fetch?: FetchJson; timeoutMs?: number; log?: (m: string) => void } = {},
): Promise<unknown | null> {
  const f = opts.fetch ?? (fetch as unknown as FetchJson);
  const formats = [{ type: "json_schema", json_schema: { name: "packages", strict: true, schema: SCHEMA } }, { type: "json_object" }];
  const sys = `${system}\nAnswer only with JSON of the form {"packages":[{"ecosystem":"npm"|"pypi","name":"..."}]}.`;
  for (const response_format of formats) {
    let res;
    try {
      res = await f(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}`, ...cfg.headers },
        body: JSON.stringify({ model, max_tokens: 2048, response_format, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
    } catch {
      opts.log?.(`  network error calling ${model}`);
      return null;
    }
    if (res.status === 401 || res.status === 403) throw new ProviderAuthError(`${new URL(cfg.baseUrl).host} rejected the API key (HTTP ${res.status})`);
    if (res.status === 400 && response_format.type === "json_schema") continue;
    if (!res.ok) {
      opts.log?.(`  API error ${res.status} from ${model}`);
      return null;
    }
    const body = ChatResponse.safeParse(await res.json().catch(() => null));
    if (!body.success) return null;
    const c = body.data.choices[0]!;
    if (c.message.refusal || c.finish_reason === "length" || !c.message.content) return null;
    try {
      return JSON.parse(c.message.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      return null;
    }
  }
  return null;
}
