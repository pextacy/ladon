import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OsvSource } from "@ladon/core";
import { audit, fetchAtlasAlerts, findLockfiles, lockedDeps, type AtlasAlert } from "./audit.js";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ladon-audit-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/react": { version: "19.0.0" }, "node_modules/react-codeshift": { version: "1.0.1" }, "node_modules/evil-pkg": { version: "0.0.3" } } }),
  );
  writeFileSync(join(dir, "requirements.txt"), "Flask_Login==0.6.3\nrequests==2.32.3\n");
  mkdirSync(join(dir, "src"));
  return dir;
}

const alerts: AtlasAlert[] = [
  { ecosystem: "npm", name: "react-codeshift", registeredAt: "2026-11-08T00:00:00Z", firstSeen: "2026-10-01T00:00:00Z", models: ["claude-opus-5-5", "gpt-5"], seenCount: 4 },
  { ecosystem: "pypi", name: "flask-login", registeredAt: "2026-11-02T00:00:00Z", firstSeen: "2026-10-01T00:00:00Z", models: [], seenCount: 1 },
  { ecosystem: "npm", name: "not-in-project", registeredAt: "2026-11-02T00:00:00Z", firstSeen: "2026-10-01T00:00:00Z", models: ["m"], seenCount: 1 },
];
const osv = (bad: Record<string, string[]> = {}, fail = false): OsvSource & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    query: async (eco, name, version) => {
      calls.push(`${eco}:${name}@${version ?? ""}`);
      if (fail) throw new Error("OSV down");
      return { malicious: bad[`${eco}:${name}`] ?? [], vulns: [] };
    },
  };
};

describe("ladon audit", () => {
  it("finds lockfiles from a subdirectory and lists every locked dependency", () => {
    const dir = project();
    const files = findLockfiles(join(dir, "src"));
    expect(files.map((f) => f.slice(dir.length + 1)).sort()).toEqual(["package-lock.json", "requirements.txt"]);
    const { deps } = lockedDeps(files);
    expect(deps.map((d) => `${d.ecosystem}:${d.name}@${d.versions.join(",")}`).sort()).toEqual(["npm:evil-pkg@0.0.3", "npm:react-codeshift@1.0.1", "npm:react@19.0.0", "pypi:flask-login@0.6.3", "pypi:requests@2.32.3"]);
  });

  it("reports Atlas alerts and OSV MAL advisories", async () => {
    const dir = project();
    const o = osv({ "npm:evil-pkg": ["MAL-2026-1234"] });
    const r = await audit(dir, { alerts: async () => alerts, osv: o });
    expect(r.deps).toBe(5);
    expect(r.errors).toEqual([]);
    expect(r.findings.map((f) => `${f.kind} ${f.ecosystem}:${f.name}`)).toEqual(["malicious npm:evil-pkg", "atlas pypi:flask-login", "atlas npm:react-codeshift"]);
    expect(r.findings[0]!.detail).toContain("MAL-2026-1234");
    expect(r.findings[2]!.detail).toMatch(/hallucinated by claude-opus-5-5, gpt-5, registered 2026-11-08/);
    expect(o.calls).toContain("npm:react@19.0.0");
  });

  it("is honest when sources fail (incomplete, not clean)", async () => {
    const r = await audit(project(), { alerts: async () => { throw new Error("cannot reach ladon.example"); }, osv: osv({}, true) });
    expect(r.findings).toEqual([]);
    expect(r.errors).toEqual(["Atlas alerts: cannot reach ladon.example", "OSV: 5 of 5 lookups failed"]);
  });

  it("fetchAtlasAlerts calls GET /api/atlas/alerts and validates the response", async () => {
    let url = "";
    const ok = (async (u: URL) => ((url = String(u)), new Response(JSON.stringify({ alerts, generatedAt: "t" }), { status: 200 }))) as unknown as typeof fetch;
    expect(await fetchAtlasAlerts("https://ladon.example/", ok)).toHaveLength(3);
    expect(url).toBe("https://ladon.example/api/atlas/alerts?limit=500");
    const bad = (async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchAtlasAlerts("https://ladon.example/", bad)).rejects.toThrow(/unexpected data/);
    const down = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchAtlasAlerts("https://ladon.example/", down)).rejects.toThrow(/HTTP 503/);
  });
});
