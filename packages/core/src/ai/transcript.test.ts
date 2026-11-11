import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCodexTranscript, parseAgentTranscript, parseClaudeTranscript, parseCodexTranscript } from "./transcript.js";

const codex = readFileSync(new URL("./__fixtures__/codex-rollout.jsonl", import.meta.url), "utf8");

describe("Codex rollout transcript", () => {
  it("finds the last real human request, skipping AGENTS.md / environment injections", () => {
    const r = parseCodexTranscript(codex);
    expect(r.userRequest).toBe("make the navbar sticky");
  });
  it("lists tool calls since that request (shell argv, exec_command, local_shell, apply_patch)", () => {
    expect(parseCodexTranscript(codex).recentAgentSteps).toEqual([
      "bash: cat src/Navbar.tsx",
      "bash: cat AGENTS.md",
      "apply_patch components/Navbar.tsx",
      "bash: npm i color-fn-utils",
    ]);
  });
  it("keeps only the last N steps", () => {
    expect(parseCodexTranscript(codex, 2).recentAgentSteps).toHaveLength(2);
  });
  it("tolerates bare (legacy) response items and garbage", () => {
    const legacy = [
      JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "add a date picker" }] }),
      "{broken",
      JSON.stringify({ type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["npm", "i", "react-day-picker"] }) }),
      JSON.stringify({ type: "function_call", name: "shell", arguments: "not json" }),
      "[]",
      "null",
    ].join("\n");
    expect(parseCodexTranscript(legacy)).toEqual({ userRequest: "add a date picker", recentAgentSteps: ["bash: npm i react-day-picker", "shell"] });
    expect(parseCodexTranscript("")).toEqual({ userRequest: "", recentAgentSteps: [] });
  });
  it("auto-detects the format", () => {
    expect(isCodexTranscript(codex)).toBe(true);
    const claude = [
      JSON.stringify({ type: "user", message: { role: "user", content: "fix the footer" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "npm i x" } }] } }),
    ].join("\n");
    expect(isCodexTranscript(claude)).toBe(false);
    expect(parseAgentTranscript(claude)).toEqual(parseClaudeTranscript(claude));
    expect(parseAgentTranscript(codex).userRequest).toBe("make the navbar sticky");
  });
});
