import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { LADON_HOME: mkdtempSync(join(tmpdir(), "ladon-test-")), LADON_NO_NOTIFY: "1", LADON_AI: "off" },
    testTimeout: 20_000,
  },
});
