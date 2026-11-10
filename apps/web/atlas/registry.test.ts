import { describe, expect, it } from "vitest";
import { checkExists, type FetchLike } from "./registry";

const mock = (routes: Record<string, { status: number; body?: unknown } | Error>): { fetch: FetchLike; urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      const r = routes[url];
      if (!r) return { status: 404, ok: false, json: async () => ({}) };
      if (r instanceof Error) throw r;
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
    },
  };
};

describe("registry existence", () => {
  it("npm: 200 with versions exists, 404 does not, scoped names are encoded", async () => {
    const m = mock({
      "https://registry.npmjs.org/left-pad": { status: 200, body: { versions: { "1.3.0": {} }, time: { created: "2014-03-17T00:00:00Z" } } },
      "https://registry.npmjs.org/@scope%2Fpkg": { status: 200, body: { versions: { "1.0.0": {} } } },
      "https://registry.npmjs.org/unpublished": { status: 200, body: { time: { unpublished: {} } } },
    });
    expect(await checkExists("npm", "left-pad", m.fetch)).toEqual({ exists: true, createdAt: "2014-03-17T00:00:00Z" });
    expect(await checkExists("npm", "@scope/pkg", m.fetch)).toEqual({ exists: true });
    expect(await checkExists("npm", "nope-xyz", m.fetch)).toEqual({ exists: false });
    expect(await checkExists("npm", "unpublished", m.fetch)).toEqual({ exists: false });
    expect(m.urls).toContain("https://registry.npmjs.org/@scope%2Fpkg");
  });

  it("pypi: uses the JSON API and earliest upload time", async () => {
    const m = mock({
      "https://pypi.org/pypi/requests/json": { status: 200, body: { releases: { "2.0": [{ upload_time_iso_8601: "2013-09-24T00:00:00Z" }], "0.2": [{ upload_time_iso_8601: "2011-02-14T00:00:00Z" }] } } },
    });
    expect(await checkExists("pypi", "requests", m.fetch)).toEqual({ exists: true, createdAt: "2011-02-14T00:00:00Z" });
    expect(await checkExists("pypi", "made-up-thing", m.fetch)).toEqual({ exists: false });
  });

  it("never guesses on errors", async () => {
    const m = mock({ "https://registry.npmjs.org/x": { status: 503 }, "https://registry.npmjs.org/y": new Error("ECONNRESET") });
    expect(await checkExists("npm", "x", m.fetch)).toEqual({ exists: null });
    expect(await checkExists("npm", "y", m.fetch)).toEqual({ exists: null });
  });
});
