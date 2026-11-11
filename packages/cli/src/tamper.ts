import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { LADON_HOME } from "./config.js";

/**
 * Tamper protection for the agent channel (CLAUDE.md #4). A hijacked agent runs as the same OS user,
 * so it could try to edit Ladon's config, pair its own approver, or remove the hook. The PreToolUse
 * hook refuses those tool calls; the human can still do all of it in their own terminal.
 * This raises the bar against an agent — it is not protection against arbitrary local malware.
 */

const home = homedir();
const ladonHome = resolve(LADON_HOME);

/** macOS (APFS/HFS+) and Windows file systems are case-insensitive by default: `~/.LADON` is `~/.ladon`. */
const FOLD = process.platform === "darwin" || process.platform === "win32";
const fold = (p: string) => (FOLD ? p.toLowerCase() : p);

/** Resolve symlinks of the longest existing prefix (the file itself may not exist yet, e.g. Write). */
function realish(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) break;
      tail.push(basename(head));
      head = up;
    }
  }
  return abs;
}

const LADON_HOMES = [...new Set([ladonHome, realish(ladonHome)].map(fold))];
const PROTECTED_FILES = [/\/\.claude\/settings(\.local)?\.json$/i, /\/\.cursor\/hooks\.json$/i, /\/\.claude\.json$/i];

function expand(p: string, cwd: string): string {
  return resolve(cwd, p.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home));
}

export function protectedPath(p: string, cwd: string): string | null {
  const abs = expand(p, cwd);
  for (const cand of new Set([abs, realish(abs)])) {
    const c = fold(cand);
    if (LADON_HOMES.some((h) => c === h || c.startsWith(h + "/"))) return "Ladon's configuration and approval state";
    if (PROTECTED_FILES.some((re) => re.test(cand))) return "AI-tool hook configuration";
  }
  return null;
}

const SENSITIVE_SUB = /\b(?:ladon|index\.js)['"]?\s+(?:init|key\s+pair|passkey\s+pair|shim\s+uninstall|config)\b/i;
const WRITEISH =
  /(>|\btee\b|\bg?sed\b[^|;&]*\s-[a-zA-Z]*i|\bmv\b|\bcp\b|\brm\b|\bln\b|\bchmod\b|\btruncate\b|\bjq\b|\bpython[\d.]*\b|\b(?:node|bun|deno)\b[^|;&]*\s(?:-e|-p|--eval|--print|eval)\b|\bperl\b|\bruby\b|\bphp\b|\bawk\b|\bgawk\b|\bosascript\b|\bdd\b|\binstall\b|\bunlink\b|\brsync\b|\bditto\b|\btar\b|\bunzip\b|\bcurl\b|\bwget\b|\bgit\s+(?:checkout|restore|apply|stash|reset)\b|\b(?:vi|vim|nvim|ex|ed|nano|emacs)\b|\bopen\(|writeFile)/i;

/** `.ladon` as a path component anywhere: `~/.ladon`, `"$HOME"/.ladon`, `cd ~ && rm -rf .ladon`, `~/./.ladon`. */
const LADON_DIR = /(?:^|[^\w.-])\.ladon(?![\w.-])/i;

export function tamperReasonBash(command: string): string | null {
  const ladonRef =
    LADON_HOMES.some((h) => fold(command).includes(h)) ||
    command.includes(ladonHome) ||
    LADON_DIR.test(command) ||
    /\bLADON_HOME\s*=/i.test(command);
  if (ladonRef) return "touches Ladon's configuration (~/.ladon)";
  if (SENSITIVE_SUB.test(command)) return "changes who can approve installs (pairing / init / removing shims)";
  if (/\.claude\/settings(\.local)?\.json|\.cursor\/hooks\.json|\.claude\.json/i.test(command) && WRITEISH.test(command)) return "modifies AI-tool hook configuration";
  if (/\bLADON_(?:DAEMON_PORT|KEY_PORT|WEB_URL)\s*=/i.test(command)) return "redirects Ladon to a different daemon / key / server";
  return null;
}

export function tamperReasonEdit(filePath: string, cwd: string): string | null {
  const what = protectedPath(filePath, cwd);
  return what ? `edits ${what}` : null;
}

export function tamperMessage(reason: string): string {
  return `Ladon BLOCKED this tool call: it ${reason}. Only the human may change Ladon's settings, pairing or hooks, from their own terminal. Do not try another way. Tell the user if you think this change is needed.`;
}
