/**
 * Atlas probe job (docs/DOCS.md §8).
 *
 *   pnpm --filter web atlas:probe            # probe models, then re-check unregistered names
 *   pnpm --filter web atlas:probe probe      # probe only
 *   pnpm --filter web atlas:probe recheck    # re-check only (no API key needed)
 *
 * Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *      LADON_PROBE_MODELS (comma list, default claude-opus-5-5), LADON_PROBE_MAX_PROMPTS (total
 *      model calls per run, default 50), LADON_PROBE_RECHECK_LIMIT (default 500).
 *
 * Only package names, registries and model ids are stored — never prompts' answers or code.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createRequire } from "node:module";
import { createStore, supabaseConfigured } from "../lib/store";
import { ProbeOutput } from "./extract";
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
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.log("atlas probe: ANTHROPIC_API_KEY not set — skipping the model probe (no-op).");
    } else {
      const models = (process.env.LADON_PROBE_MODELS ?? "claude-opus-5-5").split(",").map((s) => s.trim()).filter(Boolean);
      const maxCalls = intEnv(process.env.LADON_PROBE_MAX_PROMPTS, 50);
      const require = createRequire(import.meta.url);
      const { prompts } = require("./prompts/v1.json") as { prompts: ProbePrompt[] };
      const client = new Anthropic({ maxRetries: 2, timeout: 120_000 });
      const format = zodOutputFormat(ProbeOutput);

      // No server-side `fallbacks` here on purpose: a fallback would answer with a different model
      // and the Atlas would attribute that model's names to the one we asked. Refusals are skipped.
      const ask = async (model: string, p: ProbePrompt): Promise<unknown | null> => {
        try {
          const res = await client.messages.parse({
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

      console.log(`atlas probe: ${models.join(", ")} · up to ${maxCalls} calls · prompts v1 (${prompts.length})`);
      const s = await probeRun(prompts, models, maxCalls, { ask, exists, store, now, log });
      console.log(`atlas probe: ${s.calls} calls (${s.failedCalls} failed) · ${s.names} names · ${s.hallucinated} hallucinated · ${s.unknown} unverifiable`);
    }
  }

  if (mode !== "probe") {
    const r = await recheckRun(intEnv(process.env.LADON_PROBE_RECHECK_LIMIT, 500), { exists, store, now, log });
    console.log(`atlas recheck: ${r.checked} checked · ${r.newlyRegistered.length} newly registered · ${r.unknown} unverifiable`);
  }
}

main().catch((e: unknown) => {
  console.error("atlas probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
