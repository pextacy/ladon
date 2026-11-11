import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./tamper.js", async (orig) => ({
  ...(await orig<typeof import("./tamper.js")>()),
  tamperReasonBash: () => {
    throw new Error("boom");
  },
}));

const { cursorBeforeShell, claudePreToolUse } = await import("./hook.js");

function withStdin(text: string) {
  Object.defineProperty(process, "stdin", { value: Readable.from([Buffer.from(text)]), configurable: true });
}
const realStdin = process.stdin;
afterEach(() => {
  Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
  vi.restoreAllMocks();
});

function captureStdout(): () => string {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  return () => out;
}

describe("hooks fail closed on internal errors", () => {
  it("cursor beforeShellExecution denies (a crashed hook would let Cursor run the command)", async () => {
    withStdin(JSON.stringify({ command: "npm i evil", cwd: "/" }));
    const out = captureStdout();
    expect(await cursorBeforeShell()).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ permission: "deny" });
  });

  it("claude PreToolUse denies with the documented hookSpecificOutput shape", async () => {
    withStdin(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm i evil" }, cwd: "/" }));
    const out = captureStdout();
    expect(await claudePreToolUse()).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
  });
});
