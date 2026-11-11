import { beforeEach, describe, expect, it } from "vitest";
import { GET as alertsGET } from "@/app/api/atlas/alerts/route";
import { GET as feedGET } from "@/app/atlas/feed.xml/route";
import { POST as keysPOST } from "@/app/api/devices/me/keys/route";
import { GET as meGET } from "@/app/api/devices/me/route";
import { MemoryStore } from "./store/memory";
import { sha256Hex } from "./tokens";

const TOKEN = "t".repeat(43);
const g = globalThis as unknown as { __ladonStore?: MemoryStore };

beforeEach(async () => {
  const s = new MemoryStore();
  g.__ladonStore = s;
  await s.createDevice({ id: "d1", label: "laptop", tokenHash: sha256Hex(TOKEN), createdAt: "2026-11-01T00:00:00Z" });
  for (const [eco, name, reg] of [["npm", "old-taken", "2026-11-03T00:00:00.000Z"], ["pypi", "new-taken", "2026-11-09T00:00:00.000Z"]] as const) {
    await s.observeAtlasName({ ecosystem: eco, name, model: "m1", source: "probe", registered: false, at: "2026-11-01T00:00:00.000Z" });
    await s.setAtlasRegistered(eco, name, reg, reg);
  }
});

describe("GET /api/atlas/alerts", () => {
  it("returns alerts newest first with filters", async () => {
    const r = await alertsGET(new Request("http://x/api/atlas/alerts"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { alerts: { name: string }[]; generatedAt: string };
    expect(body.alerts.map((a) => a.name)).toEqual(["new-taken", "old-taken"]);
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    const npm = (await (await alertsGET(new Request("http://x/api/atlas/alerts?eco=npm"))).json()) as { alerts: { name: string }[] };
    expect(npm.alerts.map((a) => a.name)).toEqual(["old-taken"]);
    const since = (await (await alertsGET(new Request("http://x/api/atlas/alerts?since=2026-11-05T00:00:00Z&limit=5"))).json()) as { alerts: { name: string }[] };
    expect(since.alerts.map((a) => a.name)).toEqual(["new-taken"]);
  });
  it("rejects bad queries", async () => {
    expect((await alertsGET(new Request("http://x/api/atlas/alerts?since=yesterday"))).status).toBe(400);
    expect((await alertsGET(new Request("http://x/api/atlas/alerts?limit=0"))).status).toBe(400);
  });
});

describe("GET /atlas/feed.xml", () => {
  it("serves Atom", async () => {
    const r = await feedGET(new Request("http://localhost:3000/atlas/feed.xml", { headers: { host: "localhost:3000" } }));
    expect(r.headers.get("content-type")).toMatch(/application\/atom\+xml/);
    const xml = await r.text();
    expect(xml.match(/<entry>/g)).toHaveLength(2);
    expect(xml).toContain("http://localhost:3000/atlas/feed.xml");
  });
});

describe("POST /api/devices/me/keys", () => {
  const post = (body: unknown, token = TOKEN) =>
    keysPOST(new Request("http://x/api/devices/me/keys", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(body) }));

  it("registers a Key and lists it on /api/devices/me", async () => {
    const pk = "AB".repeat(32);
    const r = await post({ publicKey: pk, label: "desk Key" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, fingerprint: "ABABABAB" });
    await post({ publicKey: pk, label: "desk Key" }); // idempotent
    const me = (await (await meGET(new Request("http://x/api/devices/me", { headers: { authorization: `Bearer ${TOKEN}` } }))).json()) as { keys: { publicKey: string; fingerprint: string; label: string }[] };
    expect(me.keys).toEqual([expect.objectContaining({ publicKey: pk.toLowerCase(), fingerprint: "ABABABAB", label: "desk Key" })]);
  });

  it("needs a device token and a valid key", async () => {
    expect((await post({ publicKey: "a".repeat(64) }, "x".repeat(43))).status).toBe(401);
    expect((await post({ publicKey: "zz" })).status).toBe(400);
  });
});
