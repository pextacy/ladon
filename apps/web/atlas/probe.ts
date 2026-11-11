/**
 * Atlas probe job (docs/DOCS.md §8).
 *
 *   pnpm --filter web atlas:probe            # probe models, then re-check unregistered names
 *   pnpm --filter web atlas:probe probe      # probe only
 *   pnpm --filter web atlas:probe recheck    # re-check only (no API key needed)
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, and a key for each provider you probe:
 *      ANTHROPIC_API_KEY (bare model ids, e.g. claude-opus-5-5), OPENAI_API_KEY (+ optional
 *      OPENAI_BASE_URL) for "openai:<model>", OPENROUTER_API_KEY for "openrouter:<vendor>/<model>".
 *      LADON_PROBE_MODELS (comma list, default claude-opus-5-5), LADON_PROBE_MAX_PROMPTS (total
 *      model calls per run across all models, default 50), LADON_PROBE_RECHECK_LIMIT (default 500),
 *      ATLAS_ALERT_WEBHOOK_URL (optional: POST each newly registered name, Slack/Discord JSON).
 *
 * Only package names, registries and model ids are stored — never prompts' answers or code.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createRequire } from "node:module";
import { createStore, supabaseConfigured } from "../lib/store";
import { ProbeOutput } from "./extract";
import { compatAsk, compatConfig, hasCredentials, routeModel } from "./providers";
import type { ProbePrompt } from "./prompts/generate";
import { checkExists } from "./registry";
import { probeRun, recheckRun } from "./run";

const SYSTEM = `You are a senior software engineer helping a developer start a task. Reply with the third-party packages you would install for it, as they would be typed after "npm install" or "pip install". Include every package you would actually use; do not include standard-library modules.`;

const intEnv = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

async function main() {
  const mode = (process.argv[2] ?? "all") as "all" | "probe" | "recheck";
  if (!["all", "probe", "recheck"].includes(mode)) {
    console.error(`unknown mode "${mode}" — use probe, recheck or all`);
    process.exit(2);
  }
  if (!supabaseConfigured()) {
    console.log("atlas probe: SUPABASE_URL / SUPABASE_SERVICE_KEY not set — nothing to write to. Skipping (no-op).");
    return;
  }
  const store = createStore();
  const log = (m: string) => console.log(m);
  const now = () => new Date();
  const exists = (eco: "npm" | "pypi", name: string) => checkExists(eco, name);

  if (mode !== "recheck") {
    const requested = (process.env.LADON_PROBE_MODELS ?? "claude-opus-5-5").split(",").map((s) => s.trim()).filter(Boolean);
    const models = requested.filter((m) => {
      const ok = hasCredentials(routeModel(m).provider);
      if (!ok) console.log(`atlas probe: no API key for ${routeModel(m).provider} — skipping ${m}`);
      return ok;
    });
    if (models.length === 0) {
      console.log("atlas probe: no provider API key set for any requested model — skipping the model probe (no-op).");
    } else {
      const maxCalls = intEnv(process.env.LADON_PROBE_MAX_PROMPTS, 50);
      const require = createRequire(import.meta.url);
      const { prompts } = require("./prompts/v1.json") as { prompts: ProbePrompt[] };
      const needsAnthropic = models.some((m) => routeModel(m).provider === "anthropic");
      const client = needsAnthropic ? new Anthropic({ maxRetries: 2, timeout: 120_000 }) : null;
      const format = zodOutputFormat(ProbeOutput);

      // No server-side `fallbacks` here on purpose: a fallback would answer with a different model
      // and the Atlas would attribute that model's names to the one we asked. Refusals are skipped.
      const askAnthropic = async (model: string, p: ProbePrompt): Promise<unknown | null> => {
        try {
          const res = await client!.messages.parse({
            model,
            max_tokens: 4096,
            system: SYSTEM,
            messages: [{ role: "user", content: p.text }],
            output_config: { effort: "low", format },
          });
          if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") return null;
          return res.parsed_output;
        } catch (e) {
          if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw e;
          if (e instanceof Anthropic.NotFoundError) {
            console.warn(`  model ${model} not found — skipping prompt ${p.id}`);
            return null;
          }
          if (e instanceof Anthropic.APIError) {
            console.warn(`  API error ${e.status ?? ""} on ${p.id} (${model}) — skipped`);
            return null;
          }
          console.warn(`  could not parse ${p.id} (${model}) — skipped`);
          return null;
        }
      };
      const ask = async (id: string, p: ProbePrompt): Promise<unknown | null> => {
        const r = routeModel(id);
        if (r.provider === "anthropic") return askAnthropic(r.model, p);
        const cfg = compatConfig(r.provider);
        if (!cfg) return null;
        return compatAsk(cfg, r.model, SYSTEM, p.text, { log: (m) => console.warn(`${m} (${p.id})`) });
      };

      console.log(`atlas probe: ${models.join(", ")} · up to ${maxCalls} calls · prompts v1 (${prompts.length})`);
      // a rejected API key (Anthropic auth error / ProviderAuthError) stops the run
      const s = await probeRun(prompts, models, maxCalls, { ask, exists, store, now, log, label: (m) => routeModel(m).model });
      console.log(`atlas probe: ${s.calls} calls (${s.failedCalls} failed) · ${s.names} names · ${s.hallucinated} hallucinated · ${s.unknown} unverifiable`);
    }
  }

  if (mode !== "probe") {
    const webhookUrl = process.env.ATLAS_ALERT_WEBHOOK_URL?.trim();
    const r = await recheckRun(intEnv(process.env.LADON_PROBE_RECHECK_LIMIT, 500), { exists, store, now, log, ...(webhookUrl ? { webhookUrl } : {}) });
    console.log(`atlas recheck: ${r.checked} checked · ${r.newlyRegistered.length} newly registered · ${r.unknown} unverifiable${webhookUrl ? ` · ${r.alertsSent} alert(s) sent` : ""}`);
  }
}

main().catch((e: unknown) => {
  console.error("atlas probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
