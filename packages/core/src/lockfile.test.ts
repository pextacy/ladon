import { describe, expect, it } from "vitest";
import { compareIntegrity, integrityTokens, parseLockfile } from "./lockfile.js";

const SHA512 = "sha512-Q8Hk2XvYbAJe5bW2V3N5Gq1mJm0D4nBf0x3uQzK6dE+5C2tWd0w5x1rT5pPb4h3ZsW4L9u7m8cV2nX1yKzA==";
const OTHER = "sha512-AAAk2XvYbAJe5bW2V3N5Gq1mJm0D4nBf0x3uQzK6dE+5C2tWd0w5x1rT5pPb4h3ZsW4L9u7m8cV2nX1yKzA==";
const H1 = "sha256:" + "a".repeat(64);
const H2 = "sha256:" + "b".repeat(64);

describe("lockfile integrity", () => {
  it("package-lock v3 and v1 record integrity", () => {
    const v3 = JSON.stringify({ packages: { "": { name: "app" }, "node_modules/lodash": { version: "4.17.21", integrity: SHA512 }, "node_modules/@s/x": { version: "1.0.0" } } });
    const idx = parseLockfile("package-lock.json", v3);
    expect(idx.integrity("npm", "lodash", "4.17.21")).toEqual([SHA512]);
    expect(idx.integrity("npm", "@s/x", "1.0.0")).toEqual([]);
    const v1 = JSON.stringify({ dependencies: { a: { version: "1.0.0", integrity: "sha1-abc= sha512-def==", dependencies: { b: { version: "2.0.0", integrity: OTHER } } } } });
    const i1 = parseLockfile("package-lock.json", v1);
    expect(i1.integrity("npm", "a", "1.0.0")).toEqual(["sha1-abc=", "sha512-def=="]);
    expect(i1.integrity("npm", "b", "2.0.0")).toEqual([OTHER]);
  });

  it("pnpm-lock (v6/v9 and v5 multi-line resolution)", () => {
    const v9 = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4\n        version: 4.17.21\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: ${SHA512}}\n\n  '@types/node@24.0.1':\n    resolution: {integrity: ${OTHER}}\n\nsnapshots:\n\n  lodash@4.17.21: {}\n`;
    const idx = parseLockfile("pnpm-lock.yaml", v9);
    expect(idx.integrity("npm", "lodash", "4.17.21")).toEqual([SHA512]);
    expect(idx.integrity("npm", "@types/node", "24.0.1")).toEqual([OTHER]);
    const v5 = `packages:\n\n  /left-pad/1.3.0:\n    resolution:\n      integrity: ${SHA512}\n    dev: false\n`;
    expect(parseLockfile("pnpm-lock.yaml", v5).integrity("npm", "left-pad", "1.3.0")).toEqual([SHA512]);
  });

  it("yarn.lock v1", () => {
    const y = `# yarn lockfile v1\n\nlodash@^4.17.21:\n  version "4.17.21"\n  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#abc"\n  integrity ${SHA512}\n`;
    expect(parseLockfile("yarn.lock", y).integrity("npm", "lodash", "4.17.21")).toEqual([SHA512]);
  });

  it("uv.lock, poetry.lock (files + legacy metadata.files), requirements --hash", () => {
    const uv = `version = 1\n\n[[package]]\nname = "requests"\nversion = "2.32.3"\nsource = { registry = "https://pypi.org/simple" }\nsdist = { url = "https://x/requests-2.32.3.tar.gz", hash = "${H1}", size = 1 }\nwheels = [\n    { url = "https://x/requests-2.32.3-py3-none-any.whl", hash = "${H2}", size = 2 },\n]\n\n[package.optional-dependencies]\nsocks = [{ name = "pysocks" }]\n`;
    expect(parseLockfile("uv.lock", uv).integrity("pypi", "requests", "2.32.3").sort()).toEqual([H1, H2]);
    const poetry = `[[package]]\nname = "Flask"\nversion = "3.0.0"\nfiles = [\n    {file = "flask-3.0.0.tar.gz", hash = "${H1}"},\n]\n\n[[package]]\nname = "six"\nversion = "1.16.0"\n\n[metadata]\ncontent-hash = "x"\n\n[metadata.files]\nsix = [\n    {file = "six-1.16.0.tar.gz", hash = "${H2}"},\n]\n`;
    const p = parseLockfile("poetry.lock", poetry);
    expect(p.integrity("pypi", "flask", "3.0.0")).toEqual([H1]);
    expect(p.integrity("pypi", "six", "1.16.0")).toEqual([H2]);
    const req = `requests==2.32.3 \\\n    --hash=${H1} \\\n    --hash=${H2}\nflask==3.0.0\n`;
    const r = parseLockfile("requirements.txt", req);
    expect(r.integrity("pypi", "requests", "2.32.3").sort()).toEqual([H1, H2]);
    expect(r.versions("pypi", "flask")).toEqual(["3.0.0"]);
  });

  it("compareIntegrity", () => {
    expect(compareIntegrity([SHA512], [SHA512, "sha1-x"])).toBe("match");
    expect(compareIntegrity([OTHER], [SHA512])).toBe("mismatch");
    expect(compareIntegrity(["sha1-x"], [SHA512])).toBe("unknown");
    expect(compareIntegrity([H1], [H2, H1])).toBe("match");
    expect(compareIntegrity([H1, "sha256:" + "c".repeat(64)], [H1, H2])).toBe("mismatch");
    expect(compareIntegrity([H1], [])).toBe("unknown");
    expect(integrityTokens("sha256:ABC junk")).toEqual(["sha256:abc"]);
  });
});
