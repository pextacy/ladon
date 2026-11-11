import { z } from "zod";
import { parseInstallCommand } from "@ladon/core";
import { gateCommand } from "./client.js";
import { sessionStartContext } from "./scan.js";
import { tamperMessage, tamperReasonBash, tamperReasonEdit } from "./tamper.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Claude Code kills a hook after its timeout (150 s, see init.ts) and then lets the tool call run —
 * fail open. So the hook gives up first and denies. Cursor gets the same budget.
 */
export const HOOK_DEADLINE_MS = 140_000;

export async function gateWithDeadline(
  input: Parameters<typeof gateCommand>[0],
  ms = HOOK_DEADLINE_MS,
  run: typeof gateCommand = gateCommand,
): Promise<Awaited<ReturnType<typeof gateCommand>>> {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`no verdict within ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([run(input, undefined, ctrl.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const PreToolUse = z.object({
  hook_event_name: z.string().optional(),
  tool_name: z.string(),
  tool_input: z.object({ command: z.string().optional(), file_path: z.string().optional(), notebook_path: z.string().optional() }).passthrough(),
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
});

const denyJson = (reason: string, human?: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }, ...(human ? { systemMessage: human } : {}) });

/** Claude Code PreToolUse hook. Any internal failure on an install command denies (fail closed). */
export async function claudePreToolUse(): Promise<number> {
  try {
    return await claudePreToolUseInner();
  } catch (e) {
    const msg = `Ladon could not check this install (${e instanceof Error ? e.message : String(e)}), so it is blocked (fail closed). Tell the user; do not try another way to install it.`;
    process.stdout.write(denyJson(msg, `■ Ladon internal error — install blocked: ${e instanceof Error ? e.message : String(e)}`));
    return 0;
  }
}

async function claudePreToolUseInner(): Promise<number> {
  let input;
  try {
    input = PreToolUse.parse(JSON.parse(await readStdin()));
  } catch {
    return 0; // not our event shape — never break the agent on malformed input
  }
  const cwd0 = input.cwd ?? process.cwd();
  if (input.tool_name !== "Bash") {
    const target = input.tool_input.file_path ?? input.tool_input.notebook_path;
    const reason = target ? tamperReasonEdit(target, cwd0) : null;
    if (reason) process.stdout.write(denyJson(tamperMessage(reason), `■ Ladon blocked the agent from editing protected config: ${target}`));
    return 0;
  }
  const command = input.tool_input.command;
  if (!command) return 0;
  const tamper = tamperReasonBash(command);
  if (tamper) {
    process.stdout.write(denyJson(tamperMessage(tamper), `■ Ladon blocked a command that ${tamper}`));
    return 0;
  }
  if (parseInstallCommand(command).length === 0) return 0;
  const r = await gateWithDeadline({
    command,
    cwd: input.cwd || process.cwd(),
    ...(input.transcript_path ? { transcriptPath: input.transcript_path } : {}),
    agent: "claude-code",
  });
  if (r.decision === "deny") {
    process.stdout.write(denyJson(r.agentText, r.display.replace(/\x1b\[[0-9;]*m/g, "")));
    return 0;
  }
  if (r.verdict === "warn" || r.outcome === "approved") {
    process.stdout.write(JSON.stringify({ systemMessage: r.display.replace(/\x1b\[[0-9;]*m/g, "") + (r.outcome === "approved" ? "\n✓ approved by a human" : "") }));
  }
  return 0;
}

const SessionStart = z.object({ cwd: z.string().optional() }).passthrough();

/** Claude Code SessionStart hook: scan instruction files + agent config, warn the agent up front. */
export async function claudeSessionStart(): Promise<number> {
  let cwd = process.cwd();
  try {
    cwd = SessionStart.parse(JSON.parse(await readStdin())).cwd ?? cwd;
  } catch {
    /* use process cwd */
  }
  const ctx = sessionStartContext(cwd);
  if (ctx) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx.agent },
      systemMessage: ctx.human,
    }));
  }
  return 0;
}

const CursorShell = z.object({ command: z.string(), cwd: z.string().optional() }).passthrough();

/** Cursor `beforeShellExecution` hook (hooks.json). Any internal failure denies (fail closed). */
export async function cursorBeforeShell(): Promise<number> {
  try {
    return await cursorBeforeShellInner();
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    process.stdout.write(JSON.stringify({ permission: "deny", userMessage: `Ladon internal error — command blocked: ${m}`, agentMessage: `Ladon could not check this command (${m}); it is blocked (fail closed). Tell the user; do not try another way.` }));
    return 0;
  }
}

async function cursorBeforeShellInner(): Promise<number> {
  let input;
  try {
    input = CursorShell.parse(JSON.parse(await readStdin()));
  } catch {
    process.stdout.write(JSON.stringify({ permission: "allow" }));
    return 0;
  }
  const tamper = tamperReasonBash(input.command);
  if (tamper) {
    process.stdout.write(JSON.stringify({ permission: "deny", userMessage: `Ladon blocked a command that ${tamper}`, agentMessage: tamperMessage(tamper) }));
    return 0;
  }
  if (parseInstallCommand(input.command).length === 0) {
    process.stdout.write(JSON.stringify({ permission: "allow" }));
    return 0;
  }
  let r;
  try {
    r = await gateWithDeadline({ command: input.command, cwd: input.cwd || process.cwd(), agent: "cursor" });
  } catch (e) {
    process.stdout.write(JSON.stringify({ permission: "deny", userMessage: `Ladon internal error — install blocked`, agentMessage: `Ladon could not check this install (${e instanceof Error ? e.message : String(e)}); it is blocked.` }));
    return 0;
  }
  const plain = r.display.replace(/\x1b\[[0-9;]*m/g, "");
  process.stdout.write(JSON.stringify(r.decision === "deny" ? { permission: "deny", userMessage: plain, agentMessage: r.agentText } : { permission: "allow", ...(r.verdict === "warn" ? { userMessage: plain, agentMessage: r.agentText } : {}) }));
  return 0;
}
