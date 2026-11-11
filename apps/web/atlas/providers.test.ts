import { describe, expect, it } from "vitest";
import { MemoryStore } from "../lib/store/memory";
import { generatePrompts } from "./prompts/generate";
import { compatAsk, compatConfig, hasCredentials, ProviderAuthError, routeModel, type FetchJson } from "./providers";
import { probeRun } from "./run";

const reply = (content: string | null, extra: object = {}) => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "stop", message: { content, ...extra } }] }) });

describe("model routing", () => {
  it("routes by prefix, default Anthropic", () => {
    expect(routeModel("claude-opus-5-5")).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(routeModel("openai:gpt-5-mini")).toEqual({ provider: "openai", model: "gpt-5-mini" });
    expect(routeModel("openrouter:meta-llama/llama-4-scout")).toEqual({ provider: "openrouter", model: "meta-llama/llama-4-scout" });
    expect(routeModel("anthropic:claude-haiku-4-5")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("finds credentials and endpoints from env", () => {
    expect(hasCredentials("openai", {})).toBe(false);
    expect(compatConfig("openai", { OPENAI_API_KEY: "k" })).toMatchObject({ baseUrl: "https://api.openai.com/v1", apiKey: "k" });
    expect(compatConfig("openai", { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "http://localhost:11434/v1/" })?.baseUrl).toBe("http://localhost:11434/v1");
    expect(compatConfig("openai", { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "" })?.baseUrl).toBe("https://api.openai.com/v1");
    expect(compatConfig("openrouter", { OPENROUTER_API_KEY: "r" })?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(hasCredentials("anthropic", { ANTHROPIC_API_KEY: "a" })).toBe(true);
  });
});

describe("compatAsk", () => {
  const cfg = { baseUrl: "https://api.example/v1", apiKey: "sk-test" };

  it("requests JSON schema output and parses the answer", async () => {
    const seen: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    const f: FetchJson = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization! });
      return reply('```json\n{"packages":[{"ecosystem":"npm","name":"zod"}]}\n```');
    };
    expect(await compatAsk(cfg, "gpt-5-mini", "sys", "task", { fetch: f })).toEqual({ packages: [{ ecosystem: "npm", name: "zod" }] });
    expect(seen[0]!.url).toBe("https://api.example/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer sk-test");
    expect(seen[0]!.body).toMatchObject({ model: "gpt-5-mini", response_format: { type: "json_schema" } });
  });

  it("falls back to json_object when the server rejects json_schema", async () => {
    const formats: string[] = [];
    const f: FetchJson = async (_u, init) => {
      const t = (JSON.parse(init.body) as { response_format: { type: string } }).response_format.type;
      formats.push(t);
      return t === "json_schema" ? { ok: false, status: 400, json: async () => ({}) } : reply('{"packages":[]}');
    };
    expect(await compatAsk(cfg, "m", "s", "u", { fetch: f })).toEqual({ packages: [] });
    expect(formats).toEqual(["json_schema", "json_object"]);
  });

  it("refusals, truncation, garbage and API errors are null; a bad key is fatal", async () => {
    expect(await compatAsk(cfg, "m", "s", "u", { fetch: async () => reply(null, { refusal: "no" }) })).toBeNull();
    expect(await compatAsk(cfg, "m", "s", "u", { fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "length", message: { content: "{" } }] }) }) })).toBeNull();
    expect(await compatAsk(cfg, "m", "s", "u", { fetch: async () => reply("not json") })).toBeNull();
    expect(await compatAsk(cfg, "m", "s", "u", { fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) })).toBeNull();
    expect(await compatAsk(cfg, "m", "s", "u", { fetch: async () => { throw new Error("net"); } })).toBeNull();
    await expect(compatAsk(cfg, "m", "s", "u", { fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) })).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe("probeRun across providers", () => {
  it("keeps one total call cap and records the bare model id", async () => {
    const store = new MemoryStore();
    const asked: string[] = [];
    const s = await probeRun(generatePrompts(), ["claude-opus-5-5", "openai:gpt-5-mini", "openrouter:meta-llama/llama-4-scout"], 9, {
      store,
      now: () => new Date(0),
      log: () => {},
      label: (m) => routeModel(m).model,
      ask: async (m) => (asked.push(m), { packages: [{ ecosystem: "npm", name: "made-up-pkg-xyz" }] }),
      exists: async () => ({ exists: false }),
    });
    expect(s.calls).toBe(9);
    expect(new Set(asked).size).toBe(3);
    expect((await store.getAtlasName("npm", "made-up-pkg-xyz"))?.models.sort()).toEqual(["claude-opus-5-5", "gpt-5-mini", "meta-llama/llama-4-scout"]);
  });
});
