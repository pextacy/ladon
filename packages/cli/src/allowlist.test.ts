import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTopList, keySignedMessage, type CheckDeps, type NpmPackageInfo } from "@ladon/core";
import { allowlistHash, allowTarget, exactVersion, verifiedAllowlist, verifyEntry } from "./allowlist.js";
import { LADON_HOME, loadConfig, loadState, saveConfig, saveState, type AllowlistEntry, type Config } from "./config.js";
import { gate } from "./gate.js";
import { main } from "./index.js";

// own LADON_HOME: these tests pin/unpin a Key, which must not race other test files
await vi.hoisted(async () => {
  const { mkdtempSync: mk } = await import("node:fs");
  const { tmpdir: td } = await import("node:os");
  const { join: j } = await import("node:path");
  process.env.LADON_HOME = mk(j(td(), "ladon-allow-home-"));
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pkHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("hex");
const other = generateKeyPairSync("ed25519");

/** An entry exactly as `ladon allow` stores it after a Key approval. */
function signedEntry(target: string, version?: string, key = privateKey, pub = pkHex): AllowlistEntry {
  const e = { target, ...(version ? { version } : {}) };
  const req = { id: "abc123", h: allowlistHash(e), n: "c".repeat(32), exp: 2_000_000_000 };
  const ctr = 9;
  const sig = sign(null, Buffer.from(keySignedMessage(req, true, ctr)), key).toString("hex");
  return { ...e, approvedAt: "2026-11-10T00:00:00.000Z", via: "key", proof: { via: "key", ...req, ctr, sig, publicKey: pub } };
}

const cfg: Pick<Config, "key" | "passkeys" | "webUrl"> = { key: { publicKey: pkHex, pairedAt: "t" }, passkeys: [], webUrl: "https://ladon.example" };

describe("allowlist helpers", () => {
  it("runs in its own LADON_HOME", () => expect(LADON_HOME).toContain("ladon-allow-home-"));

  it("normalizes targets and exact versions", () => {
    expect(allowTarget("pypi", "Flask_Login")).toBe("pypi:flask-login");
    expect(allowTarget("npm", "@scope/x")).toBe("npm:@scope/x");
    expect(exactVersion("1.2.3")).toBe("1.2.3");
    expect(exactVersion("==2.0.1")).toBe("2.0.1");
    expect(exactVersion("^1.2.3")).toBeNull();
    expect(exactVersion(">=1")).toBeNull();
    expect(exactVersion("latest")).toBeNull();
    expect(exactVersion("1.x")).toBeNull();
    expect(exactVersion(undefined)).toBeNull();
  });
});

describe("verifyEntry", () => {
  it("accepts an entry signed by the pinned Key", async () => {
    expect(await verifyEntry(signedEntry("npm:left-pad"), cfg)).toEqual({ ok: true });
    expect(await verifyEntry(signedEntry("npm:left-pad", "1.3.0"), cfg)).toEqual({ ok: true });
  });

  it("rejects what an agent could write into state.json", async () => {
    const unsigned: AllowlistEntry = { target: "npm:evil", approvedAt: "t", via: "key" };
    expect((await verifyEntry(unsigned, cfg)).ok).toBe(false);
    // proof copied from another entry
    expect(await verifyEntry({ ...signedEntry("npm:left-pad"), target: "npm:evil" }, cfg)).toMatchObject({ ok: false, reason: /different allowlist entry/ });
    // a version-scoped approval widened to every version
    const scoped = signedEntry("npm:left-pad", "1.3.0");
    delete scoped.version;
    expect((await verifyEntry(scoped, cfg)).ok).toBe(false);
    // signed by some other key
    expect(await verifyEntry(signedEntry("npm:evil", undefined, other.privateKey, (other.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("hex")), cfg)).toMatchObject({ ok: false, reason: /not the paired one/ });
    // right public key claimed, wrong signature
    expect(await verifyEntry(signedEntry("npm:evil", undefined, other.privateKey), cfg)).toMatchObject({ ok: false, reason: /bad Ladon Key signature/ });
    // no Key paired any more
    expect((await verifyEntry(signedEntry("npm:left-pad"), { ...cfg, key: undefined })).ok).toBe(false);
    // passkey proof from a passkey that isn't pinned
    const pe: AllowlistEntry = { target: "npm:evil", approvedAt: "t", via: "passkey", proof: { via: "passkey", id: "abc123", h: allowlistHash({ target: "npm:evil" }), n: "d".repeat(32), exp: 1, decision: "approve", assertion: { id: "nope" } } };
    expect(await verifyEntry(pe, cfg)).toMatchObject({ ok: false, reason: /not paired/ });
  });

  it("verifiedAllowlist matches name-only and exact-version entries and warns about bad ones", async () => {
    const warns: string[] = [];
    const v = await verifiedAllowlist(cfg, { allowlist: [signedEntry("npm:any-ver"), signedEntry("npm:one-ver", "2.0.0"), signedEntry("pypi:flask-login"), { ...signedEntry("npm:x"), target: "npm:forged" }] }, (m) => warns.push(m));
    expect(v.entries).toHaveLength(3);
    expect(v.rejected.map((r) => r.entry.target)).toEqual(["npm:forged"]);
    expect(warns[0]).toMatch(/ignored 1 allowlist entry.*npm:forged/);
    expect(v.allows({ ecosystem: "npm", name: "any-ver" })).toBe(true);
    expect(v.allows({ ecosystem: "npm", name: "any-ver", versionSpec: "^9" })).toBe(true);
    expect(v.allows({ ecosystem: "npm", name: "one-ver", versionSpec: "2.0.0" })).toBe(true);
    expect(v.allows({ ecosystem: "npm", name: "one-ver", versionSpec: "2.0.1" })).toBe(false);
    expect(v.allows({ ecosystem: "npm", name: "one-ver", versionSpec: "^2.0.0" })).toBe(false);
    expect(v.allows({ ecosystem: "npm", name: "one-ver" })).toBe(false);
    expect(v.allows({ ecosystem: "pypi", name: "Flask_Login", versionSpec: "0.6.3" })).toBe(true);
    expect(v.allows({ ecosystem: "npm", name: "forged" })).toBe(false);
  });
});

// ---- gate + CLI integration ----
const NOW = new Date();
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const canary: NpmPackageInfo = {
  name: "color-fn-utils",
  created: ago(1),
  distTags: { latest: "1.0.2" },
  versions: { "1.0.2": { version: "1.0.2", time: ago(1), maintainers: ["m"], provenance: false, scripts: { postinstall: "node p.js" }, gypfile: false } },
};
const fakeDeps = (): CheckDeps => ({
  npm: { packument: async (n) => (n === "color-fn-utils" ? canary : null), weeklyDownloads: async () => 0, tarball: async () => null },
  pypi: { project: async () => null, weeklyDownloads: async () => 0, sdist: async () => null },
  osv: { query: async () => ({ malicious: [], vulns: [] }) },
  topLists: { npm: buildTopList("npm", ["react"]), pypi: buildTopList("pypi", ["requests"]) },
});
const cwd = mkdtempSync(join(tmpdir(), "ladon-allow-"));

describe("gate respects only verified allowlist entries", () => {
  afterEach(() => {
    const st = loadState();
    st.allowlist = [];
    saveState(st);
    const c = loadConfig();
    delete c.key;
    saveConfig(c);
  });
  const pin = () => {
    const c = loadConfig();
    c.key = { publicKey: pkHex, pairedAt: "t" };
    saveConfig(c);
  };
  const run = (command: string) => gate({ command, cwd }, { approvers: [], deps: fakeDeps });

  it("a signed entry skips checks", async () => {
    pin();
    const st = loadState();
    st.allowlist.push(signedEntry("npm:color-fn-utils"));
    saveState(st);
    expect((await run("pnpm add color-fn-utils")).decision).toBe("allow");
  });

  it("an unsigned entry (agent-written) is ignored", async () => {
    pin();
    const st = loadState();
    st.allowlist.push({ target: "npm:color-fn-utils", approvedAt: NOW.toISOString(), via: "key" });
    saveState(st);
    const r = await run("pnpm add color-fn-utils");
    expect(r.decision).toBe("deny");
  });

  it("a version-scoped entry allows only that version", async () => {
    pin();
    const st = loadState();
    st.allowlist.push(signedEntry("npm:color-fn-utils", "1.0.2"));
    saveState(st);
    expect((await run("npm i color-fn-utils@1.0.2")).decision).toBe("allow");
    expect((await run("npm i color-fn-utils")).decision).toBe("deny");
  });

  it("ladon allow --list / --remove (no approval needed) and status migrates unsigned entries", async () => {
    pin();
    const st = loadState();
    st.allowlist.push(signedEntry("npm:keep-me"), signedEntry("npm:drop-me", "1.0.0"), { target: "npm:legacy", approvedAt: "t", via: "key" });
    saveState(st);
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as typeof process.stdout.write;
    try {
      expect(await main(["allow", "--list"])).toBe(0);
      expect(await main(["allow", "--remove", "drop-me@1.0.0"])).toBe(0);
      expect(await main(["allow", "--remove", "never-there"])).toBe(1);
      expect(await main(["status"])).toBe(0);
      expect(await main(["status"])).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const text = lines.join("");
    expect(text).toMatch(/✓ npm:keep-me/);
    expect(text).toMatch(/■ npm:legacy\s+IGNORED/);
    expect(text).toMatch(/removed 1 allowlist entry for npm:drop-me@1.0.0/);
    expect(text.match(/added before allowlists were signed/g)).toHaveLength(1); // one-time notice
    expect(loadState().allowlist.map((e) => e.target)).toEqual(["npm:keep-me"]);
  });

  it("ladon allow rejects version ranges", async () => {
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (errs.push(String(s)), true)) as typeof process.stderr.write;
    try {
      expect(await main(["allow", "left-pad@^1.0.0"])).toBe(2);
    } finally {
      process.stderr.write = orig;
    }
    expect(errs.join("")).toMatch(/not an exact version/);
  });
});
