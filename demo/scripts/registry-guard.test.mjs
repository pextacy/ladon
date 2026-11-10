import { test } from "node:test";
import assert from "node:assert/strict";
import { demoRegistry } from "./registry-guard.mjs";

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
