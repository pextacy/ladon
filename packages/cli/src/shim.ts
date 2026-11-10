import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { parseInstallCommand } from "@ladon/core";
import { CLI_ENTRY, gateCommand } from "./client.js";
import { PATHS } from "./config.js";

export const SHIMMED = ["npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "pip", "pip3", "uv", "uvx", "poetry", "pipx"] as const;
const MARK = "# ladon shim";

/** Shell-quote for reconstructing the command line the parser sees. */
export function shq(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/** The real binary: first match on PATH that isn't our shim directory. */
export function realBinary(name: string, path = process.env.PATH ?? ""): string | undefined {
  const shimDir = resolve(PATHS.shims);
  for (const dir of path.split(delimiter)) {
    if (!dir || resolve(dir) === shimDir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

function detectAgent(env = process.env): string {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return "cursor";
  if (env.CODEX_SANDBOX || env.CODEX_HOME) return "codex";
  if (env.CLINE_ACTIVE) return "cline";
  return process.stdin.isTTY ? "human" : "unknown";
}

export async function shimExec(tool: string, args: string[]): Promise<number> {
  const real = realBinary(tool);
  if (!real) {
    process.stderr.write(`ladon: real ${tool} not found on PATH\n`);
    return 127;
  }
  const command = [tool, ...args].map(shq).join(" ");
  if (parseInstallCommand(command).length > 0) {
    let r;
    try {
      r = await gateCommand({ command, cwd: process.cwd(), agent: detectAgent() }, (m) => process.stderr.write(m + "\n"));
    } catch (e) {
      process.stderr.write(`■ Ladon could not check this install (${e instanceof Error ? e.message : String(e)}) — blocked (fail closed).\n`);
      return 1;
    }
    if (r.display && r.verdict !== "allow") process.stderr.write(r.display + "\n");
    if (r.decision === "deny") {
      process.stderr.write(`\n${r.agentText}\n`);
      return 1;
    }
    if (r.outcome === "approved") process.stderr.write("✓ approved by a human — installing\n");
  }
  const res = spawnSync(real, args, { stdio: "inherit" });
  if (res.error) {
    process.stderr.write(`ladon: ${res.error.message}\n`);
    return 1;
  }
  return res.status ?? (res.signal ? 128 : 1);
}

export function installShims(): string[] {
  mkdirSync(PATHS.shims, { recursive: true });
  const written: string[] = [];
  for (const tool of SHIMMED) {
    const p = join(PATHS.shims, tool);
    const body = `#!/bin/sh\n${MARK}\nexec ${shq(process.execPath)} ${shq(CLI_ENTRY)} shim-exec ${tool} "$@"\n`;
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    written.push(p);
  }
  return written;
}

export function uninstallShims(): number {
  if (!existsSync(PATHS.shims)) return 0;
  let n = 0;
  for (const f of readdirSync(PATHS.shims)) {
    const p = join(PATHS.shims, f);
    if (readFileSync(p, "utf8").includes(MARK)) {
      rmSync(p);
      n++;
    }
  }
  return n;
}

export function shimsActive(path = process.env.PATH ?? ""): boolean {
  const first = path.split(delimiter).find((d) => SHIMMED.some((t) => existsSync(join(d, t))));
  return !!first && resolve(first) === resolve(PATHS.shims);
}

export const PATH_LINE = `export PATH="${PATHS.shims}:$PATH"  # ladon shims`;
