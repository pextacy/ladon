import type { BuildBackendInfo, ScriptFindings } from "../evidence.js";
import { parseTomlSubset } from "../parse/pyproject.js";
import { analyzeJsAst } from "./js.js";
import { agentConfigWrites } from "./agentconfig.js";
import { AGENT_CONFIG, AGENT_CONFIG_OWNERS, ENV, EVAL_LABEL, FUNCTION_LABEL, matchAll, NETWORK, OBFUSCATION, PY_EXEC, PY_NETWORK } from "./patterns.js";
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
export function analyzeNpmFiles(installScripts: Record<string, string>, tar: TarFile[], opts: NpmAnalysisOptions = {}): ScriptFindings & { hasBindingGyp: boolean } {
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
      // AST sees eval/Function calls the regexes miss (e.g. `Function(code)()`, `globalThis.eval`);
      // same labels as the regex patterns, so addAll keeps one entry per file
      addAll(f.obfuscation, ast.evalKinds.map((k) => (k === "eval" ? EVAL_LABEL : FUNCTION_LABEL)), resolved);
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

  // R15 across the whole package: code anywhere in it that writes the user's global AI-tool config.
  const owned = (opts.packageName && AGENT_CONFIG_OWNERS[opts.packageName]) || [];
  const writes: string[] = [];
  let n = 0;
  for (const [path, code] of files) {
    if (seen.has(path) || !isScanCandidate(path)) continue;
    if (++n > R15_SCAN_MAX_FILES) break;
    const lang = /\.py$/.test(path) ? "py" : /\.(sh|bash|ps1)$/.test(path) ? "sh" : "js";
    addAll(writes, agentConfigWrites(code, lang, { skipFamilies: owned, homeOnly: true }), path);
  }
  if (writes.length > 0) f.agentConfigWrites = writes;
  return f;
}

/** Package-wide R15 scan bounds (on top of readTarGz's 2 MB total). */
export const R15_SCAN_MAX_FILES = 200;
const SCAN_EXT = /\.(c?js|mjs|cts|mts|ts|jsx|tsx|sh|bash|ps1|py)$/;
// not shipped code paths: tests, fixtures, examples, docs, type declarations, source maps
const SCAN_SKIP = /(?:^|\/)(?:test|tests|__tests__|spec|fixtures?|examples?|docs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|\.min\.map$|\.map$/;

const isScanCandidate = (p: string) => SCAN_EXT.test(p) && !SCAN_SKIP.test(p);

/** Which tarball entries we need to read for npm analysis (install-time code + R15 scan files). */
export function npmWanted(installScripts: Record<string, string>): (path: string, size: number) => boolean {
  const any = Object.keys(installScripts).length > 0;
  let scanned = 0;
  return (path, size) => {
    const p = stripRoot(path);
    if (p === "binding.gyp" || p === "package.json") return true;
    if (size >= 512 * 1024) return false;
    if (any && (CODE_EXT.test(p) || !/\.\w+$/.test(p))) return true;
    if (scanned < R15_SCAN_MAX_FILES && isScanCandidate(p)) {
      scanned++;
      return true;
    }
    return false;
  };
}

export interface NpmAnalysisOptions {
  /** package name, so agent CLIs writing their own config are not flagged (AGENT_CONFIG_OWNERS) */
  packageName?: string;
}

export function analyzeNpmTarball(installScripts: Record<string, string>, tgz: Uint8Array, opts: NpmAnalysisOptions = {}) {
  return analyzeNpmFiles(installScripts, readTarGz(tgz, npmWanted(installScripts)), opts);
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

/** PEP 517 backends published by well-known projects. Anything else is "non-standard". */
export const STANDARD_BUILD_BACKENDS = new Set([
  "setuptools.build_meta",
  "setuptools.build_meta:__legacy__",
  "hatchling.build",
  "flit_core.buildapi",
  "flit.buildapi",
  "poetry.core.masonry.api",
  "poetry.masonry.api",
  "pdm.backend",
  "pdm.pep517.api",
  "maturin",
  "scikit_build_core.build",
  "mesonpy",
  "sipbuild.api",
  "uv_build",
  "whey",
  "enscons.api",
  "pbr.build",
]);

const SDIST_ROOT_FILES = new Set(["setup.py", "pyproject.toml", "hatch_build.py", "pdm_build.py", "build.py"]);
const relPath = (p: string) => normalizePath(p.replace(/^\.\//, ""));

/** What the PEP 517 build of an sdist will execute, from pyproject.toml. */
export function sdistBuildPlan(pyproject: string, present: (path: string) => boolean): BuildBackendInfo & { files: string[] } {
  const toml = parseTomlSubset(pyproject);
  const bs = toml.get("build-system");
  const backendRaw = bs?.get("build-backend");
  const backend = typeof backendRaw === "string" ? backendRaw.trim() : undefined;
  const pathsRaw = bs?.get("backend-path");
  const backendPath = Array.isArray(pathsRaw) ? pathsRaw : typeof pathsRaw === "string" ? [pathsRaw] : [];
  const out: BuildBackendInfo & { files: string[] } = { inTree: backendPath.length > 0, nonStandard: !!backend && !STANDARD_BUILD_BACKENDS.has(backend), hooks: [], files: [] };
  if (backend) out.backend = backend;
  if (out.inTree && backend) {
    const mod = backend.split(":")[0]!.replace(/\./g, "/");
    for (const dir of backendPath) {
      const base = relPath(dir);
      for (const c of [`${mod}.py`, `${mod}/__init__.py`]) out.files.push(base ? `${base}/${c}` : c);
    }
  }
  const hook = (path: string) => {
    const p = relPath(path);
    if (!out.hooks.includes(p)) out.hooks.push(p);
  };
  // hatchling custom build / metadata hooks (default file hatch_build.py)
  for (const [table, entries] of toml) {
    if (/^tool\.hatch\.(build(\.targets\.[^.]+)?|metadata)\.hooks\.custom$/.test(table)) {
      const pth = entries.get("path");
      hook(typeof pth === "string" ? pth : "hatch_build.py");
    }
  }
  // poetry-core build script
  const poetryBuild = toml.get("tool.poetry.build")?.get("script") ?? toml.get("tool.poetry")?.get("build");
  if (typeof poetryBuild === "string") hook(poetryBuild);
  // pdm-backend loads pdm_build.py automatically (or tool.pdm.build.custom-hook)
  if (backend?.startsWith("pdm.")) {
    const custom = toml.get("tool.pdm.build")?.get("custom-hook");
    const p = typeof custom === "string" ? custom : "pdm_build.py";
    if (present(relPath(p))) hook(p);
  }
  out.files.push(...out.hooks);
  return out;
}

/**
 * Python sdist (no wheel → pip builds it, running code): setup.py, or — for pyproject-only sdists —
 * an in-tree PEP 517 backend (`backend-path`), build hooks (hatch_build.py, poetry build.py,
 * pdm_build.py) and non-standard backends. Every file that runs is pattern-analysed.
 */
export function analyzeSdist(tgz: Uint8Array): (ScriptFindings & { runsCode: boolean; build?: BuildBackendInfo }) | null {
  const dec = new TextDecoder();
  const rootFiles = new Map<string, string>();
  const all = new Set<string>();
  for (const f of readTarGz(tgz, (p) => {
    const rel = stripRoot(p);
    all.add(rel);
    return SDIST_ROOT_FILES.has(rel);
  }, 1024 * 1024))
    rootFiles.set(stripRoot(f.path), dec.decode(f.data));

  const setup = rootFiles.get("setup.py");
  const pyproject = rootFiles.get("pyproject.toml");
  if (setup === undefined && pyproject === undefined) return null;
  const f = setup !== undefined ? analyzeSetupPy(setup) : { ...emptyFindings(), runsCode: false };
  if (pyproject === undefined) return f;

  const plan = sdistBuildPlan(pyproject, (p) => all.has(p));
  const { files: wanted, ...build } = plan;
  const flagged = build.inTree || build.nonStandard || build.hooks.length > 0;
  if (!flagged) return f;

  const wantedSet = new Set(wanted);
  const code = new Map(rootFiles);
  const missing = wanted.filter((w) => !code.has(w) && all.has(w));
  if (missing.length > 0) {
    const need = new Set(missing);
    for (const x of readTarGz(tgz, (p, size) => need.has(stripRoot(p)) && size < 512 * 1024, 2 * 1024 * 1024)) code.set(stripRoot(x.path), dec.decode(x.data));
  }
  for (const w of wantedSet) {
    const src = code.get(w);
    if (src === undefined) continue;
    const a = analyzeSetupPy(src, w);
    f.files.push(w);
    for (const k of ["network", "env", "obfuscation", "agentConfig"] as const) for (const x of a[k]) if (!f[k].includes(x)) f[k].push(x);
  }
  // in-tree backends and build hooks always execute during the build
  if (build.inTree || build.hooks.length > 0) f.runsCode = true;
  return { ...f, build };
}
