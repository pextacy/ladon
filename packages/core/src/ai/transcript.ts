/**
 * Read a Claude Code session transcript (JSONL at hook input `transcript_path`) and extract the last
 * real human request plus a short list of the agent's recent steps. Never returns file contents.
 */

export interface TranscriptContext {
  userRequest: string;
  recentAgentSteps: string[];
}

type Json = Record<string, unknown>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as Json).type === "text" ? String((c as Json).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function isToolResultOnly(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 && content.every((c) => c && typeof c === "object" && (c as Json).type === "tool_result");
}

function describeToolUse(block: Json): string | null {
  const name = String(block.name ?? "tool");
  const input = (block.input ?? {}) as Json;
  const path = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  if (path) return `${name.toLowerCase()} ${String(path).split("/").slice(-2).join("/")}`;
  if (typeof input.command === "string") return `bash: ${input.command.slice(0, 120)}`;
  if (typeof input.url === "string") return `${name.toLowerCase()} ${input.url.slice(0, 120)}`;
  if (typeof input.pattern === "string") return `${name.toLowerCase()} "${input.pattern.slice(0, 60)}"`;
  return name.toLowerCase();
}

export function parseClaudeTranscript(jsonl: string, maxSteps = 8): TranscriptContext {
  let userRequest = "";
  let steps: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Json;
    try {
      entry = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const msg = (entry.message ?? entry) as Json;
    const role = msg.role ?? entry.type;
    if (role === "user") {
      if (entry.isMeta === true || isToolResultOnly(msg.content)) continue;
      const t = textOf(msg.content).trim();
      // skip harness-injected wrappers (command output, reminders)
      if (!t || /^<(command-|local-command|system-reminder)/.test(t)) continue;
      userRequest = t;
      steps = [];
    } else if (role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Json[]) {
        if (block?.type === "tool_use") {
          const d = describeToolUse(block);
          if (d) steps.push(d);
        }
      }
    }
  }
  return { userRequest: userRequest.slice(0, 2000), recentAgentSteps: steps.slice(-maxSteps) };
}

// ---------- Codex CLI rollout transcripts ----------

/** Codex injects these as "user" messages; they are not what the human asked. */
const CODEX_INJECTED = /^\s*(<(environment_context|user_instructions|permissions|turn_aborted|user_shell_command|subagent)|# AGENTS\.md instructions|<INSTRUCTIONS>)/;

function codexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as Json).text === "string" && /^(input_text|text|output_text)$/.test(String((c as Json).type ?? "text")) ? String((c as Json).text) : ""))
    .filter(Boolean)
    .join("\n");
}

function argvToString(cmd: unknown): string | null {
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd) && cmd.every((x) => typeof x === "string")) {
    const a = cmd as string[];
    // ["bash", "-lc", "<script>"] → the script
    if (a.length === 3 && /(^|\/)(ba|z|da)?sh$/.test(a[0]!) && /^-\w*c$/.test(a[1]!)) return a[2]!;
    return a.join(" ");
  }
  return null;
}

function describeCodexCall(p: Json): string | null {
  const type = String(p.type ?? "");
  if (type === "local_shell_call") {
    const c = argvToString(((p.action ?? {}) as Json).command);
    return c ? `bash: ${c.slice(0, 120)}` : "shell";
  }
  const name = String(p.name ?? "tool");
  let args: Json = {};
  const raw = p.arguments ?? p.input;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) args = v as Json;
    } catch {
      // custom tools (apply_patch) pass a raw string
      if (name === "apply_patch") {
        const files = [...raw.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.split("/").slice(-2).join("/"));
        return `apply_patch ${files.slice(0, 3).join(", ")}`.trim();
      }
    }
  } else if (raw && typeof raw === "object") args = raw as Json;
  const cmd = argvToString(args.command ?? args.cmd);
  if (cmd) return `bash: ${cmd.slice(0, 120)}`;
  const path = (args.path ?? args.file_path) as unknown;
  if (typeof path === "string") return `${name.toLowerCase()} ${path.split("/").slice(-2).join("/")}`;
  if (typeof args.url === "string") return `${name.toLowerCase()} ${args.url.slice(0, 120)}`;
  return name.toLowerCase();
}

/**
 * Codex CLI rollout JSONL (`~/.codex/sessions/.../rollout-*.jsonl`, hook `transcript_path`). Lines look like
 * `{"timestamp", "type": "response_item" | "event_msg" | "session_meta" | "turn_context", "payload": {...}}`;
 * older versions wrote bare response items. Codex calls the format unstable, so this is deliberately
 * tolerant: unknown lines are skipped.
 */
export function parseCodexTranscript(jsonl: string, maxSteps = 8): TranscriptContext {
  let userRequest = "";
  let steps: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Json;
    try {
      entry = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const p = (entry.payload && typeof entry.payload === "object" ? entry.payload : entry) as Json;
    const t = String(p.type ?? "");
    let human: string | null = null;
    if (entry.type === "event_msg" && t === "user_message" && typeof p.message === "string") human = p.message;
    else if (t === "message" && p.role === "user") human = codexText(p.content);
    if (human !== null) {
      const text = human.trim();
      if (!text || CODEX_INJECTED.test(text)) continue;
      // event_msg and response_item usually carry the same prompt twice; don't reset steps for the echo
      if (text !== userRequest) steps = [];
      userRequest = text;
      continue;
    }
    if (t === "function_call" || t === "custom_tool_call" || t === "local_shell_call") {
      const d = describeCodexCall(p);
      if (d) steps.push(d);
    }
  }
  return { userRequest: userRequest.slice(0, 2000), recentAgentSteps: steps.slice(-maxSteps) };
}

/** True when the JSONL looks like a Codex rollout rather than a Claude Code transcript. */
export function isCodexTranscript(jsonl: string): boolean {
  for (const line of jsonl.split("\n").slice(0, 20)) {
    if (/^\s*\{"timestamp"[^\n]*"type"\s*:\s*"(session_meta|response_item|event_msg|turn_context)"/.test(line) || /"type"\s*:\s*"session_meta"/.test(line)) return true;
  }
  return false;
}

/** Claude Code or Codex transcript → last human request + recent agent steps. */
export function parseAgentTranscript(jsonl: string, maxSteps = 8): TranscriptContext {
  return isCodexTranscript(jsonl) ? parseCodexTranscript(jsonl, maxSteps) : parseClaudeTranscript(jsonl, maxSteps);
}
