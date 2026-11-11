import { describe, expect, it } from "vitest";
import { MemoryCache } from "./cache.js";
import { previousPypiVersion, provenanceFile, pypiPeople, pypiSource, resolvePypiVersion, type PypiPackageInfo } from "./pypi.js";

const rel = (version: string) => ({ version, hasWheel: true });
const info: PypiPackageInfo = {
  name: "requests",
  latest: "2.32.3",
  releases: Object.fromEntries(["2.0.0", "2.28.2", "2.31.0", "2.32.3", "3.0.0b1"].map((v) => [v, rel(v)])),
};

describe("resolvePypiVersion (PEP 440)", () => {
  it("exact, range, wildcard, compatible release", () => {
    expect(resolvePypiVersion(info, undefined)).toBe("2.32.3");
    expect(resolvePypiVersion(info, "2.31.0")).toBe("2.31.0");
    expect(resolvePypiVersion(info, "2.0")).toBe("2.0.0");
    expect(resolvePypiVersion(info, ">=2,<2.30")).toBe("2.28.2");
    expect(resolvePypiVersion(info, "==2.31.*")).toBe("2.31.0");
    expect(resolvePypiVersion(info, "~=2.28")).toBe("2.32.3");
    expect(resolvePypiVersion(info, ">=3.0.0b1")).toBe("3.0.0b1");
    expect(resolvePypiVersion(info, ">2.32.3")).toBe("3.0.0b1");
  });
  it("no match → undefined; non-PEP 440 spec → latest", () => {
    expect(resolvePypiVersion(info, ">=4")).toBeUndefined();
    expect(resolvePypiVersion(info, "^2.0")).toBe("2.32.3");
  });
});

// Recorded-shape responses (trimmed) from pypi.org/pypi/<name>/json, /pypi/<name>/<ver>/json and
// pypi.org/integrity/<name>/<ver>/<file>/provenance.
const projectJson = {
  info: { name: "sampleproject", version: "4.0.0", summary: "A sample Python project", author: null, author_email: '"A. Random Developer" <author@example.com>', maintainer: null, maintainer_email: null, project_urls: { Source: "https://github.com/pypa/sampleproject" } },
  releases: {
    "3.0.0": [
      { filename: "sampleproject-3.0.0-py3-none-any.whl", packagetype: "bdist_wheel", upload_time_iso_8601: "2022-01-01T00:00:00.000000Z", url: "https://files/s-3.whl", yanked: false, digests: { sha256: "AA".repeat(32) } },
      { filename: "sampleproject-3.0.0.tar.gz", packagetype: "sdist", upload_time_iso_8601: "2022-01-01T00:00:01.000000Z", url: "https://files/s-3.tar.gz", yanked: false, digests: { sha256: "bb".repeat(32) } },
    ],
    "4.0.0": [{ filename: "sampleproject-4.0.0.tar.gz", packagetype: "sdist", upload_time_iso_8601: "2024-10-01T00:00:00.000000Z", url: "https://files/s-4.tar.gz", yanked: false, digests: { sha256: "cc".repeat(32) } }],
    "0.1": [{ filename: "sampleproject-0.1.tar.gz", packagetype: "sdist", url: "https://files/s-01.tar.gz", yanked: true }],
  },
};
const versionJson = { info: { name: "sampleproject", version: "3.0.0", author: "A. Random Developer", author_email: "author@example.com, other@example.com", maintainer: null, maintainer_email: null } };
const provenanceJson = {
  version: 1,
  attestation_bundles: [{ publisher: { kind: "GitHub", repository: "pypa/sampleproject", workflow: "release.yml", environment: "pypi" }, attestations: [{ version: 1 }] }],
};

function recorded(routes: Record<string, unknown>) {
  const calls: { url: string; accept: string | null }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, accept: new Headers(init?.headers).get("accept") });
    const body = routes[url];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { f, calls };
}

describe("pypiSource (recorded fetch)", () => {
  it("project JSON → files with sha256, identities, previous release", async () => {
    const { f } = recorded({ "https://pypi.org/pypi/sampleproject/json": projectJson });
    const p = (await pypiSource({ fetch: f }).project("SampleProject"))!;
    expect(p.people).toEqual(["author@example.com"]);
    expect(p.releases["0.1"]).toBeUndefined(); // all files yanked
    expect(p.releases["3.0.0"]!.files!.map((x) => x.sha256)).toEqual(["aa".repeat(32), "bb".repeat(32)]);
    expect(previousPypiVersion(p, "4.0.0")?.version).toBe("3.0.0");
    expect(provenanceFile(p.releases["3.0.0"])?.filename).toBe("sampleproject-3.0.0.tar.gz");
    expect(provenanceFile(p.releases["3.0.0"], "bdist_wheel")?.filename).toBe("sampleproject-3.0.0-py3-none-any.whl");
  });
  it("per-version metadata and PEP 740 provenance (404 = none), cached", async () => {
    const { f, calls } = recorded({
      "https://pypi.org/pypi/sampleproject/3.0.0/json": versionJson,
      "https://pypi.org/integrity/sampleproject/3.0.0/sampleproject-3.0.0.tar.gz/provenance": provenanceJson,
    });
    const src = pypiSource({ fetch: f, cache: new MemoryCache() });
    expect(await src.release!("sampleproject", "3.0.0")).toEqual({ version: "3.0.0", people: ["author@example.com", "other@example.com"] });
    expect(await src.release!("sampleproject", "9.9")).toBeNull();
    expect(await src.provenance!("sampleproject", "3.0.0", "sampleproject-3.0.0.tar.gz")).toEqual({ publisher: "GitHub:pypa/sampleproject" });
    expect(await src.provenance!("sampleproject", "4.0.0", "sampleproject-4.0.0.tar.gz")).toBeNull();
    await src.provenance!("sampleproject", "3.0.0", "sampleproject-3.0.0.tar.gz");
    expect(calls.filter((c) => c.url.includes("/integrity/")).length).toBe(2);
    expect(calls.find((c) => c.url.includes("/integrity/"))?.accept).toBe("application/vnd.pypi.integrity.v1+json");
  });
  it("pypiPeople prefers e-mails and falls back to names", () => {
    expect(pypiPeople({ author: "Kenneth Reitz", author_email: "me@kennethreitz.org" })).toEqual(["me@kennethreitz.org"]);
    expect(pypiPeople({ author: "Alice, Bob", maintainer: "alice" })).toEqual(["alice", "bob"]);
    expect(pypiPeople({})).toEqual([]);
  });
});
