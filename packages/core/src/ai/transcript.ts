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
