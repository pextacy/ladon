import { describe, expect, it } from "vitest";
import { scoreEvidence } from "../score.js";
import { daysAgo, ev, hoursAgo } from "../test/helpers.js";
import { R01, R02, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13, R14, R15, L01 } from "./rules.js";

const reg = (o: object = {}) => ({ maintainers: ["a"], previousMaintainers: ["a"], installScripts: {}, hasBindingGyp: false, repositoryUrl: "git+https://github.com/a/b.git", ...o });
const scripts = (o: object = {}) => ({ analyzed: true, files: [], network: [], env: [], obfuscation: [], agentConfig: [], ...o });

describe("rules", () => {
  it("R01 not_found", () => {
    expect(R01.evaluate(ev({ exists: false })).hit).toBe(true);
    expect(R01.evaluate(ev({ exists: null })).hit).toBe(false);
    expect(R01.evaluate(ev()).hit).toBe(false);
  });
  it("R02 osv_malicious", () => {
    expect(R02.evaluate(ev({ osv: { malicious: ["MAL-2025-1"], vulns: [] } })).detail).toContain("MAL-2025-1");
    expect(R02.evaluate(ev({ osv: { malicious: [], vulns: ["GHSA-x"] } })).hit).toBe(false);
  });
  it("R03 atlas with recent-registration bonus", () => {
    const old = R03.evaluate(ev({ atlas: { hallucinated: true, models: ["a", "b"], seenCount: 3, registeredAt: daysAgo(90) } }));
    expect(old).toMatchObject({ hit: true, weight: 35 });
    const fresh = R03.evaluate(ev({ atlas: { hallucinated: true, models: [], seenCount: 1, registeredAt: daysAgo(3) } }));
    expect(fresh.weight).toBe(55);
    expect(fresh.detail).toContain("registered it 3 days ago");
  });
  it("R04 typosquat suppressed for popular packages", () => {
    const e = ev({ similarity: { isTop: false, typosquatOf: "express", distance: 1, homoglyph: false }, weeklyDownloads: 5 });
    expect(R04.evaluate(e).detail).toContain('"express" (1 letter off)');
    expect(R04.evaluate({ ...e, weeklyDownloads: 50_000 }).hit).toBe(false);
  });
  it("R05 conflation", () => {
    expect(R05.evaluate(ev({ similarity: { isTop: false, conflationOf: ["react", "jscodeshift"] }, weeklyDownloads: 3 })).hit).toBe(true);
  });
  it("R06 very_new tiers", () => {
    expect(R06.evaluate(ev({ registry: reg({ firstPublished: hoursAgo(30) }) }))).toMatchObject({ hit: true, weight: 30 });
    expect(R06.evaluate(ev({ registry: reg({ firstPublished: daysAgo(5) }) }))).toMatchObject({ hit: true, weight: 20 });
    expect(R06.evaluate(ev({ registry: reg({ firstPublished: daysAgo(30) }) })).hit).toBe(false);
  });
  it("R07 new version by a new publisher", () => {
    const e = ev({ version: "4.2.1", registry: reg({ versionPublished: hoursAgo(5), previousVersion: "4.2.0", publisher: "eve", previousPublisher: "alice", maintainers: ["alice", "eve"], previousMaintainers: ["alice"] }) });
    expect(R07.evaluate(e).hit).toBe(true);
    expect(R07.evaluate({ ...e, registry: { ...e.registry!, versionPublished: daysAgo(10) } }).hit).toBe(false);
    expect(R07.evaluate({ ...e, registry: { ...e.registry!, publisher: "alice", maintainers: ["alice"] } }).hit).toBe(false);
  });
  it("R08 install script / binding.gyp / setup.py", () => {
    expect(R08.evaluate(ev({ registry: reg({ installScripts: { postinstall: "node x.js" } }) })).detail).toContain("postinstall");
    expect(R08.evaluate(ev({ registry: reg({ hasBindingGyp: true }) })).hit).toBe(true);
    expect(R08.evaluate(ev({ registry: reg({ setupPyRuns: true }) })).hit).toBe(true);
    expect(R08.evaluate(ev({ registry: reg() })).hit).toBe(false);
    const b = (o: object) => ev({ ecosystem: "pypi", registry: reg({ setupPyRuns: true, buildBackend: { inTree: false, nonStandard: false, hooks: [], ...o } }) });
    expect(R08.evaluate(b({ backend: "backend", inTree: true, nonStandard: true })).detail).toBe('no wheel available — builds with an in-tree backend "backend" (backend-path) shipped inside the sdist');
    expect(R08.evaluate(b({ backend: "hatchling.build", hooks: ["hatch_build.py"] })).detail).toBe("no wheel available — build hook hatch_build.py runs at install time");
    expect(R08.evaluate(b({ backend: "x.api", nonStandard: true })).detail).toBe('no wheel available — uses the non-standard build backend "x.api"');
    expect(R08.evaluate(b({ backend: "setuptools.build_meta" })).detail).toContain("setup.py");
  });
  it("R15 package-wide writes (no install-time reference)", () => {
    const e = ev({ scripts: scripts({ agentConfigWrites: ["writes to Claude Code config (lib/index.js)", "writes to Cursor config (lib/x.js)"] }) });
    expect(R15.evaluate(e).detail).toBe("package code writes to Claude Code config in lib/index.js (+1 more) — AI-tool persistence pattern");
    expect(R15.evaluate(ev({ scripts: scripts({ agentConfigWrites: [] }) })).hit).toBe(false);
  });
  it("R09–R11, R15 script findings", () => {
    const e = ev({ scripts: scripts({ network: ["loads a network module (x.js)"], env: ["reads environment variables (x.js)"], obfuscation: ["uses eval() (x.js)"], agentConfig: ["references Claude Code config (x.js)"] }) });
    expect(R09.evaluate(e).detail).toBe("install script loads a network module in x.js");
    expect(R10.evaluate(e).hit).toBe(true);
    expect(R11.evaluate(e).hit).toBe(true);
    expect(R15.evaluate(e).hit).toBe(true);
    expect(R09.evaluate(ev({ scripts: scripts() })).hit).toBe(false);
  });
  it("R12 low downloads unless locked", () => {
    expect(R12.evaluate(ev({ weeklyDownloads: 3 })).hit).toBe(true);
    expect(R12.evaluate(ev({ weeklyDownloads: 3, lockfile: { present: true } })).hit).toBe(false);
    expect(R12.evaluate(ev({ weeklyDownloads: null })).hit).toBe(false);
  });
  it("R13 repo mismatch", () => {
    expect(R13.evaluate(ev({ registry: reg({ repositoryUrl: undefined }) })).detail).toBe("no source repository linked");
    expect(R13.evaluate(ev({ registry: reg(), repo: { referencesPackage: false, note: "x" } })).hit).toBe(true);
    expect(R13.evaluate(ev({ registry: reg(), repo: { referencesPackage: null } })).hit).toBe(false);
  });
  it("R14 lost provenance on popular package", () => {
    const e = ev({ version: "2.0.1", weeklyDownloads: 2_000_000, registry: reg({ provenance: false, previousProvenance: true, previousVersion: "2.0.0" }) });
    expect(R14.evaluate(e).hit).toBe(true);
    expect(R14.evaluate({ ...e, weeklyDownloads: 50 }).hit).toBe(false);
  });
  it("L01 lockfile integrity mismatch", () => {
    const e = ev({ lockfile: { present: true, version: "1.0.0", integrity: "mismatch", integrityDetail: "locked sha512-AAA…, registry sha512-BBB…" } });
    expect(L01.evaluate(e)).toMatchObject({ hit: true });
    expect(L01.evaluate(e).detail).toContain("1.0.0");
    expect(L01.evaluate(ev({ lockfile: { present: true, version: "1.0.0", integrity: "verified" } })).hit).toBe(false);
    expect(L01.evaluate(ev({ lockfile: { present: true, integrity: "unchecked" } })).hit).toBe(false);
  });
});

describe("scoreEvidence", () => {
  it("override → 100 hold", () => {
    expect(scoreEvidence(ev({ exists: false }))).toMatchObject({ score: 100, verdict: "hold" });
  });
  it("sums weights into bands", () => {
    const s = scoreEvidence(ev({ weeklyDownloads: 2, registry: reg({ firstPublished: daysAgo(5), installScripts: { postinstall: "node a.js" } }) }));
    expect(s.score).toBe(20 + 15 + 10);
    expect(s.verdict).toBe("warn");
    expect(s.hits[0]!.id).toBe("R06");
  });
  it("benign package allows", () => {
    expect(scoreEvidence(ev({ weeklyDownloads: 1e6, registry: reg({ firstPublished: daysAgo(3000) }) }))).toMatchObject({ score: 0, verdict: "allow" });
  });
  it("fails closed on critical source errors, open when configured", () => {
    const e = ev({ exists: null, errors: [{ source: "npm registry", message: "cannot reach registry.npmjs.org", critical: true }] });
    expect(scoreEvidence(e).verdict).toBe("hold");
    expect(scoreEvidence(e, { failMode: "open" }).verdict).toBe("allow");
  });
});

describe("established-package discount", () => {
  const scriptsHit = { analyzed: true, files: ["install.js"], network: ["loads a network module (install.js)"], env: ["reads environment variables (install.js)"], obfuscation: [], agentConfig: [] };
  const base = { weeklyDownloads: 5_000_000, scripts: scriptsHit, registry: reg({ firstPublished: daysAgo(2000), versionPublished: daysAgo(30), installScripts: { postinstall: "node install.js" } }) };
  it("does not count install-script heuristics for an old version of a popular package", () => {
    const s = scoreEvidence(ev(base));
    expect(s.verdict).toBe("allow");
    expect(s.hits.every((h) => h.discounted)).toBe(true);
  });
  it("still counts them when the version is brand new", () => {
    const s = scoreEvidence(ev({ ...base, registry: { ...base.registry, versionPublished: hoursAgo(10) } }));
    expect(s.verdict).not.toBe("allow");
  });
  const fresh = { ...base, registry: { ...base.registry, versionPublished: hoursAgo(10), previousVersion: "1.0.0", publisher: "alice", previousPublisher: "alice", maintainers: ["alice"], previousMaintainers: ["alice"] } };
  it("discounts a fresh routine release that keeps the previous install scripts and publisher", () => {
    const s = scoreEvidence(ev({ ...fresh, registry: { ...fresh.registry, previousInstallScripts: { postinstall: "node install.js" } } }));
    expect(s.hits.filter((h) => !h.discounted).map((h) => h.id)).toEqual([]);
    expect(s.verdict).toBe("allow");
  });
  it("no discount when the fresh release adds or changes an install script", () => {
    expect(scoreEvidence(ev({ ...fresh, registry: { ...fresh.registry, previousInstallScripts: {} } })).verdict).not.toBe("allow");
    expect(scoreEvidence(ev({ ...fresh, registry: { ...fresh.registry, previousInstallScripts: { postinstall: "node other.js" } } })).verdict).not.toBe("allow");
  });
  it("no discount when the fresh release comes from a new publisher or drops provenance", () => {
    const same = { postinstall: "node install.js" };
    expect(scoreEvidence(ev({ ...fresh, registry: { ...fresh.registry, previousInstallScripts: same, publisher: "mallory" } })).verdict).not.toBe("allow");
    expect(scoreEvidence(ev({ ...fresh, registry: { ...fresh.registry, previousInstallScripts: same, previousProvenance: true, provenance: false } })).verdict).not.toBe("allow");
  });
  it("never discounts agent-config writes", () => {
    const s = scoreEvidence(ev({ ...base, scripts: { ...scriptsHit, agentConfig: ["references Claude Code config (install.js)"] } }));
    expect(s.hits.find((h) => h.id === "R15")?.discounted).toBeUndefined();
    expect(s.score).toBe(30);
  });
});
