#!/usr/bin/env node
// Entry point with no static imports, so that a broken install (missing @ladon/core build, bad
// dependency, syntax error) still fails CLOSED. Claude Code treats a hook that crashes with exit 1 as a
// non-blocking error and runs the tool anyway — so every load failure here must answer "deny".

const argv = process.argv.slice(2);

const firstLine = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

function failClosed(e: unknown, stage: "load" | "run" = "load"): never {
  const [cmd, sub] = argv;
  // An interactive command that fails at run time (web unreachable, Key port missing, …) is not a broken
  // install: say what went wrong instead of "could not start". Hooks and shims keep failing closed below.
  if (stage === "run" && cmd !== "hook" && cmd !== "shim-exec") {
    process.stderr.write(`ladon: ${firstLine(e)}\n`);
    process.exit(1);
  }
  const why = `Ladon could not ${stage === "load" ? "start" : "finish"} (${firstLine(e)}). Failing closed.`;
  if (cmd === "hook" && sub === "claude-pre-tool-use") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${why} Ask the human to run \`ladon status\`; do not work around Ladon.` },
        systemMessage: why,
      }) + "\n",
    );
    process.exit(0);
  }
  if (cmd === "hook" && sub === "codex-pre-tool-use") {
    // Codex: JSON deny, plus exit 2 + stderr as the fallback Codex also honours
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${why} Ask the human to run \`ladon status\`; do not work around Ladon.` } }) + "\n",
    );
    process.stderr.write(`${why}\n`);
    process.exit(2);
  }
  if (cmd === "hook" && sub === "cursor-before-submit-prompt") {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n"); // never blocks a prompt
    process.exit(0);
  }
  if (cmd === "hook" && (sub === "cursor" || sub === "cursor-before-shell")) {
    process.stdout.write(JSON.stringify({ permission: "deny", userMessage: why, agentMessage: `${why} Do not work around Ladon.` }) + "\n");
    process.exit(0);
  }
  if (cmd === "hook" && sub === "claude-session-start") process.exit(0); // nothing to block
  process.stderr.write(`ladon: ${why}\n`);
  process.exit(cmd === "shim-exec" ? 126 : 1);
}

import("./main.js").then(
  ({ main }) => main(argv).then((code) => process.exit(code), (e: unknown) => failClosed(e, "run")),
  (e: unknown) => failClosed(e, "load"),
);
