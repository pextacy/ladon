/**
 * Instruction-file scanner (DOCS §7). Pure text analysis — the CLI supplies file contents and git
 * metadata. Flags the things prompt-injection attacks hide in AGENTS.md / CLAUDE.md / .cursorrules.
 */

export const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "GEMINI.md",
  ".cursorrules",
  ".clinerules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
] as const;
export const INSTRUCTION_DIRS = [".cursor/rules", ".clinerules", ".github/instructions"] as const;

export type Severity = "high" | "medium" | "low";

export interface ScanFinding {
  severity: Severity;
  kind: "install_directive" | "pipe_to_shell" | "hidden_unicode" | "encoded_blob" | "html_comment" | "untracked" | "recently_modified" | "agent_config_directive";
  line?: number;
  detail: string;
  excerpt?: string;
}

export interface FileMeta {
  path: string;
  tracked?: boolean;
  /** modified < 24 h ago with no commit touching it */
  freshUncommitted?: boolean;
}

const INSTALL_RE = /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\s+(?!-)[@\w./-]+|\b(pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+install\s+(?!-r\b)[\w.[\]=<>-]+|\buv\s+add\s+[\w.-]+|\b(npx|bunx|uvx|pnpm\s+dlx)\s+[@\w./-]+/i;
const IMPERATIVE_RE = /\b(always|first|before (anything|you start|doing)|must|required?|make sure|do not skip|silently|without asking|don'?t (tell|mention))\b/i;
const PIPE_SHELL_RE = /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(curl|wget)\b[^\n]*\|\s*python|\biex\s*\(|bash\s+<\(\s*curl/i;
// zero-width, bidi controls, tag characters (ASCII smuggling)
const HIDDEN_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u;
const B64_RE = /[A-Za-z0-9+/]{80,}={0,2}/;
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;
const AGENT_CFG_RE = /(\.claude\/settings|\.claude\/hooks|mcpServers|\.cursor\/mcp\.json|\.vscode\/tasks\.json|PreToolUse|"hooks"\s*:)/i;

function excerpt(s: string): string {
  const visible = s.replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "⟨?⟩").replace(/[\u{E0000}-\u{E007F}]/gu, "⟨tag⟩");
  return visible.trim().slice(0, 120);
}

/** Decode Unicode tag characters (U+E0000 block) that some attacks use to smuggle invisible ASCII. */
export function decodeTagChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

export function scanInstructionText(text: string, meta: FileMeta): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    if (INSTALL_RE.test(line)) {
      const imperative = IMPERATIVE_RE.test(line) || IMPERATIVE_RE.test(lines[i - 1] ?? "");
      findings.push({
        severity: imperative ? "high" : "medium",
        kind: "install_directive",
        line: n,
        detail: imperative ? "tells the agent to install a package (imperative wording)" : "mentions installing a package",
        excerpt: excerpt(line),
      });
    }
    if (PIPE_SHELL_RE.test(line)) findings.push({ severity: "high", kind: "pipe_to_shell", line: n, detail: "downloads and runs a script (pipe to shell)", excerpt: excerpt(line) });
    if (HIDDEN_RE.test(line)) {
      const smuggled = decodeTagChars(line);
      findings.push({
        severity: "high",
        kind: "hidden_unicode",
        line: n,
        detail: smuggled ? `contains invisible characters hiding text: "${smuggled.slice(0, 80)}"` : "contains invisible or direction-changing Unicode characters",
        excerpt: excerpt(line),
      });
    }
    if (B64_RE.test(line) && !/^\s*(!\[|<img|\[.*\]:\s*data:)/.test(line)) findings.push({ severity: "medium", kind: "encoded_blob", line: n, detail: "contains a long encoded (base64-like) blob", excerpt: excerpt(line) });
    if (AGENT_CFG_RE.test(line) && /\b(add|write|create|edit|update|insert|register)\b/i.test(line)) {
      findings.push({ severity: "high", kind: "agent_config_directive", line: n, detail: "asks the agent to change AI-tool hooks or MCP config", excerpt: excerpt(line) });
    }
  });
  for (const m of text.matchAll(HTML_COMMENT_RE)) {
    const body = m[1] ?? "";
    if (/\b(install|run|execute|ignore|instead|agent|assistant|you must|always)\b/i.test(body)) {
      const line = text.slice(0, m.index).split("\n").length;
      findings.push({ severity: "high", kind: "html_comment", line, detail: "hidden HTML comment gives the agent instructions", excerpt: excerpt(body) });
    }
  }
  if (meta.tracked === false) findings.push({ severity: "medium", kind: "untracked", detail: "file is not tracked by git — it may have been dropped here" });
  if (meta.freshUncommitted) findings.push({ severity: "medium", kind: "recently_modified", detail: "modified in the last 24 h and not committed" });
  return findings;
}

/** A file is suspicious when it has any high finding, or install directives combined with untracked/fresh. */
export function fileRisk(findings: ScanFinding[]): Severity | "none" {
  if (findings.some((f) => f.severity === "high")) return "high";
  const hasInstall = findings.some((f) => f.kind === "install_directive");
  const isNew = findings.some((f) => f.kind === "untracked" || f.kind === "recently_modified");
  if (hasInstall && isNew) return "high";
  if (findings.length > 0) return "medium";
  return "none";
}
