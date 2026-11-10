import type { ScriptFindings } from "../evidence.js";
import { analyzeJsAst } from "./js.js";
import { AGENT_CONFIG, ENV, matchAll, NETWORK, OBFUSCATION, PY_EXEC, PY_NETWORK } from "./patterns.js";
import { readTarGz, stripRoot, type TarFile } from "./tar.js";

export const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"] as const;

export function installScriptsOf(scripts: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INSTALL_HOOKS) if (scripts[k]) out[k] = scripts[k]!;
  return out;
}

const CODE_EXT = /\.(c?js|mjs|ts|cts|mts|sh|ps1|py|gyp)$/;

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

/** File paths an install command refers to, e.g. "node scripts/postinstall.js && sh x.sh". */
export function referencedFiles(command: string): string[] {
  const out: string[] = [];
  for (const tok of command.split(/[\s;&|()'"]+/)) {
    if (!tok || tok.startsWith("-")) continue;
    if (CODE_EXT.test(tok) || /^\.{0,2}\//.test(tok)) out.push(normalizePath(tok));
  }
  // "node scripts/setup" without extension
  const m = /\bnode\s+(?:-\S+\s+)*([\w./-]+)/.exec(command);
  if (m && !CODE_EXT.test(m[1]!)) out.push(normalizePath(m[1]!));
  return [...new Set(out)];
}

function resolveIn(files: Map<string, string>, p: string): string | undefined {
  for (const c of [p, `${p}.js`, `${p}.cjs`, `${p}.mjs`, `${p}/index.js`]) if (files.has(c)) return c;
  return undefined;
}

const emptyFindings = (): ScriptFindings => ({ analyzed: true, files: [], network: [], env: [], obfuscation: [], agentConfig: [] });

function addAll(target: string[], items: string[], where: string) {
  for (const i of items) {
    const s = `${i} (${where})`;
    if (!target.includes(s)) target.push(s);
  }
}

/**
 * Analyse what runs at install time in an npm package: the lifecycle commands themselves, the files
 * they invoke (depth ≤ 2 via relative requires), and binding.gyp command expansions.
 */
export function analyzeNpmFiles(installScripts: Record<string, string>, tar: TarFile[]): ScriptFindings & { hasBindingGyp: boolean } {
  const dec = new TextDecoder();
  const files = new Map<string, string>();
  for (const f of tar) files.set(stripRoot(f.path), dec.decode(f.data));
  const f = { ...emptyFindings(), hasBindingGyp: files.has("binding.gyp") };

  for (const [hook, cmd] of Object.entries(installScripts)) {
    const where = `${hook} script`;
    addAll(f.network, matchAll(cmd, NETWORK), where);
    addAll(f.env, matchAll(cmd, ENV), where);
    addAll(f.obfuscation, matchAll(cmd, OBFUSCATION), where);
    addAll(f.agentConfig, matchAll(cmd, AGENT_CONFIG), where);
    if (/\bnode\s+-e\b|\bnode\s+--eval\b/.test(cmd)) addAll(f.obfuscation, ["runs inline node -e code"], where);
  }

  const queue: { path: string; depth: number }[] = [];
  for (const cmd of Object.values(installScripts)) for (const p of referencedFiles(cmd)) queue.push({ path: p, depth: 1 });
  const gyp = files.get("binding.gyp");
  if (gyp && /<!@?\(/.test(gyp)) {
    queue.push({ path: "binding.gyp", depth: 1 });
    addAll(f.obfuscation, ["binding.gyp runs shell commands during build"], "binding.gyp");
  }

  const seen = new Set<string>();
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    const resolved = resolveIn(files, path);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    const code = files.get(resolved)!;
    f.files.push(resolved);
    const isJs = /\.(c?js|mjs|ts|cts|mts)$/.test(resolved) || !/\.\w+$/.test(resolved);
    addAll(f.network, matchAll(code, NETWORK), resolved);
    addAll(f.env, matchAll(code, ENV), resolved);
    addAll(f.obfuscation, matchAll(code, OBFUSCATION), resolved);
    addAll(f.agentConfig, matchAll(code, AGENT_CONFIG), resolved);
    if (isJs) {
      const ast = analyzeJsAst(code);
      if (ast.dynamicExec) addAll(f.obfuscation, ["runs child_process with a computed command"], resolved);
      if (depth < 2) {
        for (const r of ast.requires) {
          if (r.startsWith(".")) queue.push({ path: normalizePath(`${dirOf(resolved)}/${r}`), depth: depth + 1 });
        }
      }
    }
  }
  if (Object.keys(installScripts).length > 0 && f.files.length === 0 && Object.values(installScripts).some((c) => referencedFiles(c).length > 0)) {
    f.note = "install script references files that are not in the package";
  }
  return f;
}

/** Which tarball entries we need to read for npm analysis. */
export function npmWanted(installScripts: Record<string, string>): (path: string, size: number) => boolean {
  const any = Object.keys(installScripts).length > 0;
  return (path, size) => {
    const p = stripRoot(path);
    if (p === "binding.gyp" || p === "package.json") return true;
    return any && size < 512 * 1024 && (CODE_EXT.test(p) || !/\.\w+$/.test(p));
  };
}

export function analyzeNpmTarball(installScripts: Record<string, string>, tgz: Uint8Array) {
  return analyzeNpmFiles(installScripts, readTarGz(tgz, npmWanted(installScripts)));
}

/** Python sdist: setup.py runs at install time when no wheel is available. */
export function analyzeSetupPy(code: string, where = "setup.py"): ScriptFindings & { runsCode: boolean } {
  const f = { ...emptyFindings(), runsCode: false, files: [where] };
  addAll(f.network, matchAll(code, PY_NETWORK), where);
  addAll(f.env, matchAll(code, ENV), where);
  addAll(f.obfuscation, matchAll(code, OBFUSCATION).filter((l) => l !== "uses eval()"), where);
  const exec = matchAll(code, PY_EXEC);
  if (exec.length > 0) f.runsCode = true;
  addAll(f.obfuscation, exec.filter((l) => l === "executes dynamic code"), where);
  addAll(f.agentConfig, matchAll(code, AGENT_CONFIG), where);
  return f;
}

export function analyzeSdist(tgz: Uint8Array): (ScriptFindings & { runsCode: boolean }) | null {
  const files = readTarGz(tgz, (p) => /^[^/]+\/setup\.py$/.test(p), 1024 * 1024);
  const setup = files[0];
  if (!setup) return null;
  return analyzeSetupPy(new TextDecoder().decode(setup.data));
}
