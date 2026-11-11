import { describe, expect, it } from "vitest";
import { alertSentence, atomFeed, listAlerts } from "./atlas-alerts";
import { MemoryStore } from "./store/memory";

describe("atlas alerts", () => {
  it("lists alerts in the API shape", async () => {
    const s = new MemoryStore();
    await s.observeAtlasName({ ecosystem: "npm", name: "react-codeshift", model: "claude-opus-5-5", source: "probe", registered: false, at: "2026-11-01T00:00:00.000Z" });
    await s.observeAtlasName({ ecosystem: "npm", name: "react-codeshift", model: "gpt-5", source: "probe", registered: false, at: "2026-11-02T00:00:00.000Z" });
    await s.setAtlasRegistered("npm", "react-codeshift", "2026-11-08T00:00:00.000Z", "2026-11-08T00:00:00.000Z");
    expect(await listAlerts(s, { limit: 10 })).toEqual([
      { ecosystem: "npm", name: "react-codeshift", registeredAt: "2026-11-08T00:00:00.000Z", firstSeen: "2026-11-01T00:00:00.000Z", models: ["claude-opus-5-5", "gpt-5"], seenCount: 2 },
    ]);
  });

  it("renders a valid, escaped Atom feed", () => {
    const a = { ecosystem: "pypi" as const, name: "evil<&>pkg", registeredAt: "2026-11-08T00:00:00.000Z", firstSeen: "2026-11-01T00:00:00.000Z", models: ["m\"1"], seenCount: 3 };
    const xml = atomFeed([a], "https://ladon.example", "2026-11-10T00:00:00.000Z");
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
    expect(xml).toContain("<updated>2026-11-08T00:00:00.000Z</updated>");
    expect(xml).toContain("evil&lt;&amp;&gt;pkg");
    expect(xml).not.toContain("evil<&>pkg");
    expect(xml).toContain('href="https://ladon.example/check?eco=pypi&amp;name=evil%3C%26%3Epkg"');
    expect(xml).toContain('<link rel="self" type="application/atom+xml" href="https://ladon.example/atlas/feed.xml"/>');
    expect(alertSentence(a)).toMatch(/PyPI package "evil<&>pkg" was registered on 2026-11-08 — hallucinated by m"1, first seen 7 days earlier/);
    // empty feed still valid, updated = generation time
    expect(atomFeed([], "https://x", "2026-11-10T00:00:00.000Z")).toContain("<updated>2026-11-10T00:00:00.000Z</updated>");
  });
});
