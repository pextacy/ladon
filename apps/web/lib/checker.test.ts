import { describe, expect, it } from "vitest";
import { atlasName, storeAtlasSource } from "./checker";
import { MemoryStore } from "./store/memory";

describe("store-backed atlas source", () => {
  it("reads the store first, then the core seed", async () => {
    const s = new MemoryStore();
    await s.observeAtlasName({ ecosystem: "pypi", name: "fake-pkg", model: "m1", source: "probe", registered: false, at: "2026-11-10T00:00:00Z" });
    const src = storeAtlasSource(s);
    const hit = await src.lookup("pypi", "Fake_Pkg");
    expect(hit).toMatchObject({ hallucinated: true, models: ["m1"], seenCount: 1, registeredAt: null });
    expect(await src.lookup("pypi", "huggingface-cli")).toMatchObject({ hallucinated: true });
    expect(await src.lookup("npm", "left-pad")).toBeNull();
  });
  it("normalizes PyPI names only", () => {
    expect(atlasName("pypi", "Foo_Bar.baz")).toBe("foo-bar-baz");
    expect(atlasName("npm", "Foo_Bar")).toBe("Foo_Bar");
  });
});
