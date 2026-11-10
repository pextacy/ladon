import { homedir } from "node:os";
import { resolve } from "node:path";
import { LADON_HOME } from "./config.js";

/**
 * Tamper protection for the agent channel (CLAUDE.md #4). A hijacked agent runs as the same OS user,
 * so it could try to edit Ladon's config, pair its own approver, or remove the hook. The PreToolUse
 * hook refuses those tool calls; the human can still do all of it in their own terminal.
 * This raises the bar against an agent — it is not protection against arbitrary local malware.
 */

const home = homedir();
const ladonHome = resolve(LADON_HOME);

const PROTECTED_FILES = [/\/\.claude\/settings(\.local)?\.json$/, /\/\.cursor\/hooks\.json$/, /\/\.claude\.json$/];

function expand(p: string, cwd: string): string {
  return resolve(cwd, p.replace(/^~(?=\/|$)/, home));
}

export function protectedPath(p: string, cwd: string): string | null {
  const abs = expand(p, cwd);
  if (abs === ladonHome || abs.startsWith(ladonHome + "/")) return "Ladon's configuration and approval state";
  if (PROTECTED_FILES.some((re) => re.test(abs))) return "AI-tool hook configuration";
  return null;
}

const SENSITIVE_SUB = /\b(?:ladon|index\.js)['"]?\s+(?:init|key\s+pair|passkey\s+pair|shim\s+uninstall|config)\b/;
const WRITEISH = /(>|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\bln\b|\bchmod\b|\btruncate\b|\bjq\b|\bpython3?\b|\bnode\s+-e|\bperl\b|\bdd\b|\binstall\b|\bunlink\b|\bopen\(|writeFile)/;

export function tamperReasonBash(command: string): string | null {
  const ladonRef = command.includes(ladonHome) || /~\/\.ladon\b|\$HOME\/\.ladon\b|\$\{HOME\}\/\.ladon\b|\/\.ladon\//.test(command) || /\bLADON_HOME=/.test(command);
  if (ladonRef) return "touches Ladon's configuration (~/.ladon)";
  if (SENSITIVE_SUB.test(command)) return "changes who can approve installs (pairing / init / removing shims)";
  if (/\.claude\/settings(\.local)?\.json|\.cursor\/hooks\.json|\.claude\.json/.test(command) && WRITEISH.test(command)) return "modifies AI-tool hook configuration";
  if (/\bLADON_(?:DAEMON_PORT|KEY_PORT|WEB_URL)=/.test(command)) return "redirects Ladon to a different daemon / key / server";
  return null;
}

export function tamperReasonEdit(filePath: string, cwd: string): string | null {
  const what = protectedPath(filePath, cwd);
  return what ? `edits ${what}` : null;
}

export function tamperMessage(reason: string): string {
  return `Ladon BLOCKED this tool call: it ${reason}. Only the human may change Ladon's settings, pairing or hooks, from their own terminal. Do not try another way. Tell the user if you think this change is needed.`;
}
