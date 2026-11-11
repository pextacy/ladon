import { z } from "zod";
import { parseInstallCommand } from "@ladon/core";
import { gateCommand } from "./client.js";
import { sessionStartContext } from "./scan.js";
import { recordPrompt, recordStep, sessionContext } from "./sessions.js";
import { shq } from "./shim.js";
import { tamperMessage, tamperReasonBash, tamperReasonEdit } from "./tamper.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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
  const r = await gateCommand({
    command,
    cwd: input.cwd ?? process.cwd(),
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

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** What a hook handler wants written: stdout, stderr and the process exit code. */
export interface HookOutput {
  stdout: string;
  stderr: string;
  code: number;
}
type GateFn = typeof gateCommand;

// ---------- Cursor ----------

const CursorShell = z.object({ command: z.string(), cwd: z.string().optional(), conversation_id: z.string().optional() }).passthrough();
const CursorPrompt = z.object({ prompt: z.string(), conversation_id: z.string().optional() }).passthrough();

/** Cursor `beforeShellExecution`. Install commands go through the gate; the user's last prompt (stored by beforeSubmitPrompt) feeds the intent judge. */
export async function handleCursorBeforeShell(raw: string, gateFn: GateFn = gateCommand): Promise<HookOutput> {
  const out = (o: unknown): HookOutput => ({ stdout: JSON.stringify(o), stderr: "", code: 0 });
  let input;
  try {
    input = CursorShell.parse(JSON.parse(raw));
  } catch {
    return out({ permission: "allow" });
  }
  const conv = input.conversation_id;
  const ctx = conv ? sessionContext(conv) : null;
  try {
    if (conv) recordStep(conv, `bash: ${input.command.slice(0, 120)}`);
  } catch {
    /* session memory is best-effort */
  }
  const tamper = tamperReasonBash(input.command);
  if (tamper) return out({ permission: "deny", userMessage: `Ladon blocked a command that ${tamper}`, agentMessage: tamperMessage(tamper) });
  if (parseInstallCommand(input.command).length === 0) return out({ permission: "allow" });
  let r;
  try {
    r = await gateFn({ command: input.command, cwd: input.cwd ?? process.cwd(), agent: "cursor", ...(ctx ? { userRequest: ctx.userRequest, recentAgentSteps: ctx.recentAgentSteps } : {}) });
  } catch (e) {
    return out({ permission: "deny", userMessage: `Ladon internal error — install blocked`, agentMessage: `Ladon could not check this install (${e instanceof Error ? e.message : String(e)}); it is blocked.` });
  }
  const plain = strip(r.display);
  if (r.decision === "deny") return out({ permission: "deny", userMessage: plain, agentMessage: r.agentText });
  return out({ permission: "allow", ...(r.verdict === "warn" || r.notice ? { userMessage: plain, agentMessage: r.agentText } : {}) });
}

/** Cursor `beforeSubmitPrompt`: remember the prompt locally for the intent judge. Never blocks. */
export function handleCursorBeforeSubmitPrompt(raw: string): HookOutput {
  try {
    const input = CursorPrompt.parse(JSON.parse(raw));
    if (input.conversation_id) recordPrompt(input.conversation_id, input.prompt);
  } catch {
    /* never break the user's prompt */
  }
  return { stdout: JSON.stringify({ continue: true }), stderr: "", code: 0 };
}

async function emit(p: Promise<HookOutput> | HookOutput): Promise<number> {
  const o = await p;
  if (o.stdout) process.stdout.write(o.stdout);
  if (o.stderr) process.stderr.write(o.stderr.endsWith("\n") ? o.stderr : o.stderr + "\n");
  return o.code;
}

/** Cursor `beforeShellExecution` hook (hooks.json). */
export async function cursorBeforeShell(): Promise<number> {
  return emit(handleCursorBeforeShell(await readStdin()));
}

export async function cursorBeforeSubmitPrompt(): Promise<number> {
  return emit(handleCursorBeforeSubmitPrompt(await readStdin()));
}

// ---------- Codex CLI ----------

/** Codex shell tool names across versions (Bash is the canonical hook name). */
const CODEX_SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell", "container.exec", "shell_command", "unified_exec"]);
const CODEX_PATCH_TOOLS = new Set(["apply_patch", "Edit", "Write"]);

const CodexPreToolUse = z
  .object({
    tool_name: z.string(),
    tool_input: z.unknown().optional(),
    cwd: z.string().optional(),
    transcript_path: z.string().nullable().optional(),
  })
  .passthrough();

/** argv (["bash","-lc","npm i x"] or ["npm","i","x"]) or a string → one shell command line. */
export function codexCommandString(cmd: unknown): string | null {
  if (typeof cmd === "string") return cmd;
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((x) => typeof x === "string")) return null;
  const a = cmd as string[];
  if (a.length === 3 && /(^|\/)(ba|z|da|k)?sh$/.test(a[0]!) && /^-\w*c$/.test(a[1]!)) return a[2]!;
  return a.map(shq).join(" ");
}

function codexToolCommand(toolInput: unknown): string | null {
  if (typeof toolInput === "string" || Array.isArray(toolInput)) return codexCommandString(toolInput);
  if (!toolInput || typeof toolInput !== "object") return null;
  const t = toolInput as Record<string, unknown>;
  return codexCommandString(t.command ?? t.cmd ?? t.argv);
}

function patchFiles(toolInput: unknown): string[] {
  const texts: string[] = [];
  if (typeof toolInput === "string") texts.push(toolInput);
  else if (toolInput && typeof toolInput === "object") {
    for (const k of ["command", "input", "patch"]) {
      const v = (toolInput as Record<string, unknown>)[k];
      if (typeof v === "string") texts.push(v);
      else if (Array.isArray(v)) texts.push(...v.filter((x): x is string => typeof x === "string"));
    }
    const fp = (toolInput as Record<string, unknown>).file_path ?? (toolInput as Record<string, unknown>).path;
    if (typeof fp === "string") return [fp];
  }
  return texts.flatMap((t) => [...t.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim()));
}

/** Codex blocks on `permissionDecision: "deny"` JSON or on exit code 2 + stderr — send both. */
function codexDeny(reason: string, human?: string): HookOutput {
  return {
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }),
    stderr: human ? `${human}\n${reason}` : reason,
    code: 2,
  };
}

/** Codex CLI PreToolUse hook (~/.codex/hooks.json). Fail closed on internal errors for install commands. */
export async function handleCodexPreToolUse(raw: string, gateFn: GateFn = gateCommand): Promise<HookOutput> {
  const pass: HookOutput = { stdout: "", stderr: "", code: 0 };
  let input;
  try {
    input = CodexPreToolUse.parse(JSON.parse(raw));
  } catch {
    return pass; // not our event shape — never break the agent on malformed input
  }
  const cwd = input.cwd ?? process.cwd();
  if (CODEX_PATCH_TOOLS.has(input.tool_name)) {
    for (const f of patchFiles(input.tool_input)) {
      const reason = tamperReasonEdit(f, cwd);
      if (reason) return codexDeny(tamperMessage(reason), `■ Ladon blocked the agent from editing protected config: ${f}`);
    }
    return pass;
  }
  if (!CODEX_SHELL_TOOLS.has(input.tool_name)) return pass;
  const command = codexToolCommand(input.tool_input);
  if (!command) return pass;
  const tamper = tamperReasonBash(command);
  if (tamper) return codexDeny(tamperMessage(tamper), `■ Ladon blocked a command that ${tamper}`);
  if (parseInstallCommand(command).length === 0) return pass;
  try {
    const r = await gateFn({ command, cwd, ...(input.transcript_path ? { transcriptPath: input.transcript_path } : {}), agent: "codex" });
    if (r.decision === "deny") return codexDeny(r.agentText, strip(r.display));
    if (r.verdict === "warn" || r.outcome === "approved" || r.notice) {
      const msg = strip(r.display) + (r.outcome === "approved" ? "\n✓ approved by a human" : "");
      return { stdout: JSON.stringify({ systemMessage: msg }), stderr: msg, code: 0 };
    }
    return pass;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return codexDeny(`Ladon could not check this install (${m}), so it is blocked (fail closed). Tell the user; do not try another way to install it.`, `■ Ladon internal error — install blocked: ${m}`);
  }
}

export async function codexPreToolUse(): Promise<number> {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    return 0;
  }
  return emit(handleCodexPreToolUse(raw));
}
