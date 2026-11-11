import { describe, expect, it } from "vitest";
import { MemoryStore } from "../lib/store/memory";
import { recheckRun } from "./run";
import { postAlertWebhook, webhookPayload, type PostLike } from "./webhook";

const alert = { ecosystem: "npm" as const, name: "now-taken", registeredAt: "2026-11-08T00:00:00Z", models: ["claude-opus-5-5"] };

describe("alert webhook", () => {
  it("payload is Slack (text) and Discord (content) compatible", () => {
    const p = webhookPayload(alert);
    expect(p.text).toBe(p.content);
    expect(p.text).toMatch(/npm package "now-taken" was just registered \(2026-11-08\) — hallucinated by claude-opus-5-5/);
    expect(p).toMatchObject({ ecosystem: "npm", name: "now-taken", registeredAt: "2026-11-08T00:00:00Z", models: ["claude-opus-5-5"] });
  });

  it("never throws: errors, HTTP failures and timeouts are logged", async () => {
    const logs: string[] = [];
    expect(await postAlertWebhook("https://hook", alert, { fetch: async () => { throw new Error("boom"); }, log: (m) => logs.push(m) })).toBe(false);
    expect(await postAlertWebhook("https://hook", alert, { fetch: async () => ({ ok: false, status: 500 }), log: (m) => logs.push(m) })).toBe(false);
    const hang: PostLike = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
    expect(await postAlertWebhook("https://hook", alert, { fetch: hang, timeoutMs: 20, log: (m) => logs.push(m) })).toBe(false);
    expect(logs).toHaveLength(3);
  });

  it("recheckRun posts each newly registered name and survives a failing webhook", async () => {
    const store = new MemoryStore();
    for (const name of ["a-taken", "b-taken", "free"]) await store.observeAtlasName({ ecosystem: "npm", name, model: "m", source: "probe", registered: false, at: "2026-11-01T00:00:00Z" });
    const posted: { url: string; body: unknown }[] = [];
    let n = 0;
    const fetch: PostLike = async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      if (n++ === 0) throw new Error("network down");
      return { ok: true, status: 200 };
    };
    const r = await recheckRun(100, {
      store,
      now: () => new Date("2026-11-10T00:00:00Z"),
      log: () => {},
      exists: async (_e, name) => (name.endsWith("-taken") ? { exists: true, createdAt: "2026-11-08T00:00:00Z" } : { exists: false }),
      webhookUrl: "https://hooks.example/x",
      webhookFetch: fetch,
    });
    expect(r.newlyRegistered).toHaveLength(2);
    expect(r.alertsSent).toBe(1);
    expect(posted.map((p) => (p.body as { name: string }).name)).toEqual(["a-taken", "b-taken"]);
    expect(posted[0]!.url).toBe("https://hooks.example/x");
    expect(posted[0]!.body).toMatchObject({ models: ["m"], registeredAt: "2026-11-08T00:00:00Z" });
  });

  it("no webhook URL → nothing posted", async () => {
    const store = new MemoryStore();
    await store.observeAtlasName({ ecosystem: "npm", name: "x-taken", model: "m", source: "probe", registered: false, at: "2026-11-01T00:00:00Z" });
    const r = await recheckRun(10, { store, now: () => new Date(), log: () => {}, exists: async () => ({ exists: true }) });
    expect(r.alertsSent).toBe(0);
  });
});
