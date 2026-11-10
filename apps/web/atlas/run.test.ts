import { describe, expect, it } from "vitest";
import { MemoryStore } from "../lib/store/memory";
import { generatePrompts } from "./prompts/generate";
import type { Existence } from "./registry";
import { probeRun, recheckRun, selectPrompts } from "./run";

const prompts = generatePrompts();
const REAL = new Set(["npm:zod", "npm:express", "pypi:requests"]);

describe("prompt set", () => {
  it("has ~200 unique, versioned prompts across both registries", async () => {
    expect(prompts).toHaveLength(200);
    expect(new Set(prompts.map((p) => p.id)).size).toBe(200);
    expect(prompts.filter((p) => p.ecosystem === "pypi")).toHaveLength(100);
    const file = (await import("./prompts/v1.json")).default as { prompts: unknown[] };
    expect(file.prompts).toEqual(prompts);
  });
  it("rotates deterministically under the cap", () => {
    expect(selectPrompts(prompts, 50, 0).map((p) => p.id)).toEqual(prompts.slice(0, 50).map((p) => p.id));
    expect(selectPrompts(prompts, 50, 1)[0]!.id).toBe(prompts[50]!.id);
    expect(selectPrompts(prompts, 50, 4)[0]!.id).toBe(prompts[0]!.id);
    expect(selectPrompts(prompts, 0, 3)).toEqual([]);
  });
});

describe("probeRun", () => {
  it("records only non-existent names, per model, within the call cap", async () => {
    const store = new MemoryStore();
    const asked: string[] = [];
    const existsCalls: string[] = [];
    const s = await probeRun(prompts, ["model-a", "model-b"], 6, {
      store,
      now: () => new Date(0),
      log: () => {},
      ask: async (model, p) => {
        asked.push(`${model}:${p.id}`);
        if (p.id.endsWith("-03")) return null; // refusal
        return { packages: [{ ecosystem: "npm", name: "zod" }, { ecosystem: "npm", name: "react-codeshift-utils" }, { ecosystem: "pypi", name: "Requests" }, { ecosystem: "pypi", name: "flaky_registry" }] };
      },
      exists: async (eco, name): Promise<Existence> => {
        existsCalls.push(`${eco}:${name}`);
        if (name === "flaky-registry") return { exists: null };
        return { exists: REAL.has(`${eco}:${name}`) };
      },
    });
    expect(s.calls).toBe(6);
    expect(asked.filter((a) => a.startsWith("model-a"))).toHaveLength(3);
    expect(s.failedCalls).toBe(2);
    const e = await store.getAtlasName("npm", "react-codeshift-utils");
    expect(e?.models.sort()).toEqual(["model-a", "model-b"]);
    expect(e?.seenCount).toBe(4);
    expect(e?.registered).toBe(false);
    expect(await store.getAtlasName("npm", "zod")).toBeNull();
    expect(await store.getAtlasName("pypi", "flaky-registry")).toBeNull(); // unverifiable is never recorded
    // existence is cached per run
    expect(existsCalls.filter((c) => c === "npm:zod")).toHaveLength(1);
  });
});

describe("recheckRun", () => {
  it("flags newly registered names with the registry's publish date", async () => {
    const store = new MemoryStore();
    await store.observeAtlasName({ ecosystem: "npm", name: "now-taken", model: "m", source: "probe", registered: false, at: "2026-11-01T00:00:00Z" });
    await store.observeAtlasName({ ecosystem: "npm", name: "still-free", model: "m", source: "probe", registered: false, at: "2026-11-01T00:00:00Z" });
    const r = await recheckRun(100, {
      store,
      now: () => new Date("2026-11-10T00:00:00Z"),
      log: () => {},
      exists: async (_eco, name) => (name === "now-taken" ? { exists: true, createdAt: "2026-11-08T00:00:00Z" } : { exists: false }),
    });
    expect(r.newlyRegistered).toEqual([{ ecosystem: "npm", name: "now-taken", registeredAt: "2026-11-08T00:00:00Z" }]);
    const taken = await store.getAtlasName("npm", "now-taken");
    expect(taken?.registered).toBe(true);
    expect(taken?.registeredAt).toBe("2026-11-08T00:00:00Z");
    expect((await store.getAtlasName("npm", "still-free"))?.lastChecked).toBe("2026-11-10T00:00:00.000Z");
  });
});
