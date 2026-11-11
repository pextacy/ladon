import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLocalOnlyPackage, demoRegistry } from "./registry-guard.mjs";

test("defaults to localhost:4873", () => {
  assert.equal(demoRegistry({}), "http://localhost:4873/");
});
test("accepts loopback", () => {
  assert.equal(demoRegistry({ LADON_DEMO_REGISTRY: "http://127.0.0.1:4873" }), "http://127.0.0.1:4873/");
});
test("refuses public registries", () => {
  for (const r of ["https://registry.npmjs.org/", "https://pypi.org/", "http://localhost.evil.com:4873/"]) {
    assert.throws(() => demoRegistry({ LADON_DEMO_REGISTRY: r }), /Refusing/);
  }
});
test("refuses look-alike, userinfo, trailing-dot and non-http hosts", () => {
  for (const r of [
    "http://LOCALHOST.evil.com/",
    "http://localhost.:4873/",
    "http://127.0.0.1@evil.com/",
    "http://localhost:4873@registry.npmjs.org/",
    "http://127.0.0.1.nip.io/",
    "http://0.0.0.0:4873/",
    "file://localhost/tmp/x",
  ]) {
    assert.throws(() => demoRegistry({ LADON_DEMO_REGISTRY: r }), /Refusing/, r);
  }
});
test("accepts uppercase and IPv6 loopback spellings", () => {
  assert.equal(demoRegistry({ LADON_DEMO_REGISTRY: "http://LOCALHOST:4873" }), "http://localhost:4873/");
  assert.equal(demoRegistry({ LADON_DEMO_REGISTRY: "http://[0:0:0:0:0:0:0:1]:4873/" }), "http://[::1]:4873/");
});
test("ignores npm_config_registry (only LADON_DEMO_REGISTRY is honoured)", () => {
  assert.equal(demoRegistry({ npm_config_registry: "https://registry.npmjs.org/" }), "http://localhost:4873/");
});
test("assertLocalOnlyPackage refuses scoped names, public publishConfig registries and per-package .npmrc", () => {
  const none = { existsSync: () => false };
  assert.throws(() => assertLocalOnlyPackage({ name: "@evil/x" }, "/d", none), /scoped/);
  assert.throws(() => assertLocalOnlyPackage({ name: "x", publishConfig: { registry: "https://registry.npmjs.org/" } }, "/d", none), /Refusing/);
  assert.throws(() => assertLocalOnlyPackage({ name: "x", publishConfig: { "@x:registry": "https://registry.npmjs.org/" } }, "/d", none), /Refusing/);
  assert.throws(() => assertLocalOnlyPackage({ name: "x" }, "/d", { existsSync: () => true }), /\.npmrc/);
  assert.doesNotThrow(() => assertLocalOnlyPackage({ name: "x", publishConfig: { registry: "http://localhost:4873/" } }, "/d", none));
});
