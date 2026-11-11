import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "./config.js";
import { announceKey } from "./web.js";

afterEach(() => vi.unstubAllGlobals());

describe("announceKey (ladon key pair → dashboard)", () => {
  const pk = "ab".repeat(32);
  it("POSTs the public key with the device token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => (calls.push({ url: String(url), init }), new Response(JSON.stringify({ ok: true, fingerprint: "ABABABAB" }), { status: 200 })));
    const logs: string[] = [];
    const cfg = Config.parse({ webUrl: "https://ladon.example", device: { id: "d", token: "tok", label: "l" } });
    await announceKey(cfg, pk, "Ladon Key", (m) => logs.push(m));
    expect(calls[0]!.url).toBe("https://ladon.example/api/devices/me/keys");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ publicKey: pk, label: "Ladon Key" });
    expect(logs[0]).toMatch(/listed the Key/);
  });

  it("does nothing without a registered device and never throws", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", f);
    await announceKey(Config.parse({}), pk, undefined, () => {});
    expect(f).not.toHaveBeenCalled();
    const logs: string[] = [];
    await announceKey(Config.parse({ device: { id: "d", token: "t", label: "l" } }), pk, undefined, (m) => logs.push(m));
    expect(logs[0]).toMatch(/could not list the Key.*pairing is still done/);
  });
});
