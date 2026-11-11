import type { Ecosystem, InstallTarget } from "../schemas.js";
import { basename, effectiveCommandsDetailed, expandBraces, isDynamicWord, type EffectiveCommand } from "./shell.js";

export type Manager = "npm" | "pnpm" | "yarn" | "bun" | "deno" | "pip" | "uv" | "poetry" | "pipx" | "pdm" | "pipenv";

/**
 * - add:      installs named packages (npm i foo)
 * - manifest: installs from a manifest/lockfile (npm ci, pip install -r req.txt) — names come from files
 * - exec:     downloads and immediately runs a package (npx foo, uvx foo) — the riskiest form
 */
export type InstallKind = "add" | "manifest" | "exec";

export interface ParsedInstall {
  manager: Manager;
  ecosystem: Ecosystem;
  kind: InstallKind;
  targets: InstallTarget[];
  /** specs that don't come from the registry: git URLs, tarball URLs, local paths, run-time values */
  nonRegistry: string[];
  /** pip -r / -c files */
  requirementFiles: string[];
  /**
   * Local Python project directories being installed (`pip install .`, `pip install -e ./pkg`): the
   * project itself is the user's code; its dependencies come from its pyproject.toml.
   */
  projectDirs?: string[];
  /** custom registry / index URL passed on the command line or via environment */
  registry?: string;
  argv: string[];
}

/** Placeholder recorded in `nonRegistry` when xargs feeds package names from stdin. */
export const STDIN_ARGS = "<arguments read from stdin (xargs)>";

const NPM_INSTALL = new Set(["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add"]);
const NPM_UPDATE = new Set(["update", "up", "upgrade", "udpate"]);
const NPM_INSTALL_TEST = new Set(["install-test", "it"]);
const NPM_MANIFEST = new Set(["ci", "clean-install", "install-clean", "isntall-clean", "ic", "install-ci-test", "cit"]);
const NPM_VALUE_FLAGS = new Set([
  "--registry", "--prefix", "-w", "--workspace", "--omit", "--include", "--cache", "--userconfig", "--globalconfig", "--tag",
  "-C", "--dir", "--filter", "-F", "--cwd", "--modules-folder", "--network-concurrency", "--loglevel", "--script-shell",
  "--install-strategy", "--before", "--node-options",
]);
/** In pnpm/yarn/bun, -w / --workspace(-root) is a boolean flag. */
const PNPM_VALUE_FLAGS = new Set([...NPM_VALUE_FLAGS].filter((f) => f !== "-w" && f !== "--workspace"));
const NPX_VALUE_FLAGS = new Set([...NPM_VALUE_FLAGS, "-p", "--package", "-c", "--call"]);
/** Real pip long options that take a value (pip accepts unambiguous prefixes of these). */
const PIP_LONG_VALUE = [
  "--requirement", "--constraint", "--editable", "--target", "--platform", "--python-version", "--implementation", "--abi",
  "--root", "--prefix", "--src", "--upgrade-strategy", "--config-settings", "--global-option", "--no-binary", "--only-binary",
  "--progress-bar", "--root-user-action", "--report", "--index-url", "--extra-index-url", "--find-links", "--log", "--proxy",
  "--retries", "--timeout", "--exists-action", "--trusted-host", "--cert", "--client-cert", "--cache-dir", "--python",
  "--use-feature", "--use-deprecated", "--keyring-provider", "--resume-retries", "--group", "--dest", "--wheel-dir",
];
const PIP_VALUE_FLAGS = new Set([
  ...PIP_LONG_VALUE,
  "-r", "-c", "-i", "-t", "-f", "-e", "-C", "-d", "-p",
  // uv / poetry / pdm / pipx
  "--optional", "--extra", "--index", "--default-index", "--source", "-G", "--with", "--with-requirements", "--with-editable",
  "--python-platform", "--config-file", "--directory", "--project", "--from", "--spec", "--pip-args", "--suffix", "--rev",
  "--tag", "--branch", "-P", "--upgrade-package", "--package", "--script", "-m", "--marker", "--markers", "--index-strategy",
  "--resolution", "--prerelease", "--exclude-newer", "--link-mode", "--refresh-package", "--reinstall-package",
  "--no-build-package", "--no-binary-package", "--bounds", "-E", "--extras", "--env-file",
]);

/** pip wheel -w/--wheel-dir DIR (pip only: other tools use -w differently). */
const PIP_ONLY_VALUE_FLAGS = new Set([...PIP_VALUE_FLAGS, "-w", "--wheel-dir"]);
/** poetry add -e/--editable is a boolean ("add path deps as editable"). */
const POETRY_VALUE_FLAGS = new Set([...PIP_VALUE_FLAGS].filter((f) => f !== "-e" && f !== "--editable"));
/** pip boolean long options — needed so abbreviations resolve like optparse (exact match wins, ambiguity = no match). */
const PIP_LONG_BOOL = [
  "--pre", "--upgrade", "--user", "--no-deps", "--force-reinstall", "--ignore-installed", "--ignore-requires-python",
  "--no-build-isolation", "--use-pep517", "--no-use-pep517", "--check-build-dependencies", "--break-system-packages",
  "--compile", "--no-compile", "--no-warn-script-location", "--no-warn-conflicts", "--prefer-binary", "--require-hashes",
  "--no-clean", "--dry-run", "--no-index", "--isolated", "--verbose", "--quiet", "--version", "--help", "--debug",
  "--require-virtualenv", "--no-input", "--no-cache-dir", "--disable-pip-version-check", "--no-color",
  "--no-python-version-warning",
];

export function parseInstallCommand(command: string): ParsedInstall[] {
  const out: ParsedInstall[] = [];
  for (const cmd of effectiveCommandsDetailed(command)) out.push(...parseCommand(cmd));
  return out;
}

function parseCommand(cmd: EffectiveCommand): ParsedInstall[] {
  const parsed = parseWords(cmd.words.flatMap((w) => expandBraces(w)), 0);
  for (const p of parsed) {
    if (cmd.stdinArgs) {
      p.nonRegistry.push(STDIN_ARGS);
      if (p.kind === "manifest") p.kind = "add";
    }
    if (p.ecosystem === "pypi") {
      for (const k of ["PIP_FIND_LINKS", "UV_FIND_LINKS"]) if (cmd.env[k]) p.nonRegistry.push(`--find-links ${cmd.env[k]}`);
    }
    if (p.registry === undefined) {
      const reg = registryFromEnv(p.ecosystem, cmd.env);
      if (reg) p.registry = reg;
    }
  }
  return parsed;
}

/** Registry / index overrides passed through the environment (npm_config_registry=… npm i x). */
function registryFromEnv(eco: Ecosystem, env: Record<string, string>): string | undefined {
  const get = (names: string[], ci = false) => {
    for (const [k, v] of Object.entries(env)) {
      if (!v) continue;
      if (names.some((n) => (ci ? n.toLowerCase() === k.toLowerCase() : n === k))) return v;
    }
    return undefined;
  };
  if (eco === "npm") {
    const scoped = Object.entries(env).find(([k, v]) => v && /^npm_config_@[^:]+:registry$/i.test(k));
    return get(["npm_config_registry"], true) ?? get(["YARN_REGISTRY", "YARN_NPM_REGISTRY_SERVER", "BUN_CONFIG_REGISTRY", "NPM_REGISTRY"]) ?? scoped?.[1];
  }
  return get(["PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "UV_INDEX_URL", "UV_DEFAULT_INDEX", "UV_INDEX", "UV_EXTRA_INDEX_URL", "PDM_PYPI_URL", "PIPENV_PYPI_MIRROR"]);
}

const PY_BIN = /^pip(\d+(\.\d+)?)?$/;
const PYTHON_BIN = /^(python|pypy)(\d+(\.\d+)?)?$/;

function parseWords(words: string[], depth: number): ParsedInstall[] {
  const head = words[0];
  if (head === undefined || depth > 4) return [];
  // Case-insensitive file systems (macOS, Windows) resolve NPM → npm.
  const bin = basename(head).toLowerCase().replace(/\.(cmd|exe|ps1|bat)$/, "");
  const rest = words.slice(1);
  const one = (p: ParsedInstall | null) => (p ? [p] : []);

  if (bin === "npx" || bin === "bunx" || bin === "pnpx") return one(npmExec(bin === "bunx" ? "bun" : bin === "pnpx" ? "pnpm" : "npm", rest, words));
  if (bin === "uvx") return one(pyExec("uv", rest, words));

  if (bin === "npm") {
    const { sub, pre, args } = subcommand(rest, NPM_VALUE_FLAGS);
    if (sub === undefined) return [];
    const all = [...pre, ...args];
    if (NPM_INSTALL.has(sub) || NPM_UPDATE.has(sub) || NPM_INSTALL_TEST.has(sub)) return [npmLike("npm", all, words)];
    if (NPM_MANIFEST.has(sub)) return [npmLike("npm", all, words, "manifest")];
    if (sub === "link" || sub === "ln") {
      const p = npmLike("npm", all, words);
      return p.kind === "add" ? [p] : [];
    }
    if (sub === "exec" || sub === "x") return one(npmExec("npm", [...pre, ...stripDashDash(args)], words));
    if (sub === "init" || sub === "create" || sub === "innit") return one(npmCreate("npm", all, words));
    return [];
  }
  if (bin === "pnpm") {
    const { sub, pre, args } = subcommand(rest, PNPM_VALUE_FLAGS);
    if (sub === undefined) return [];
    const all = [...pre, ...args];
    if (sub === "add") return [npmLike("pnpm", all, words, "add")];
    if (sub === "install" || sub === "i" || NPM_UPDATE.has(sub) || NPM_INSTALL_TEST.has(sub)) return [npmLike("pnpm", all, words)];
    if (sub === "dlx") return one(npmExec("pnpm", all, words));
    if (sub === "create") return one(npmCreate("pnpm", all, words));
    return [];
  }
  if (bin === "yarn") {
    const { sub, pre, args } = subcommand(rest, PNPM_VALUE_FLAGS);
    if (sub === undefined) return [npmLike("yarn", pre, words, "manifest")];
    const all = [...pre, ...args];
    if (sub === "add") return [npmLike("yarn", all, words, "add")];
    if (sub === "install") return [npmLike("yarn", all, words, "manifest")];
    if (sub === "up" || sub === "upgrade") return [npmLike("yarn", all, words)];
    if (sub === "dlx") return one(npmExec("yarn", all, words));
    if (sub === "create") return one(npmCreate("yarn", all, words));
    // yarn global add x · yarn workspace <name> add x
    if (sub === "global") return parseWords(["yarn", ...pre, ...args], depth + 1);
    if (sub === "workspace") return parseWords(["yarn", ...pre, ...args.slice(1)], depth + 1);
    return [];
  }
  if (bin === "bun") {
    const { sub, pre, args } = subcommand(rest, PNPM_VALUE_FLAGS);
    if (sub === undefined) return [];
    const all = [...pre, ...args];
    if (sub === "add" || sub === "a") return [npmLike("bun", all, words, "add")];
    if (sub === "install" || sub === "i" || sub === "update") return [npmLike("bun", all, words)];
    if (sub === "x") return one(npmExec("bun", all, words));
    if (sub === "create" || sub === "c") return one(npmCreate("bun", all, words));
    return [];
  }
  if (bin === "deno") return one(denoInstall(rest, words));

  // python side
  if (PY_BIN.test(bin)) return one(pipCommand("pip", rest, words));
  if (PYTHON_BIN.test(bin) || bin === "py") {
    const k = rest.findIndex((w) => w === "-m" || /^-m\S/.test(w) || /^-[A-Za-z]*m$/.test(w));
    if (k < 0) return [];
    const w = rest[k]!;
    const mod = w.startsWith("-m") && w.length > 2 ? w.slice(2) : rest[k + 1];
    const after = w.startsWith("-m") && w.length > 2 ? rest.slice(k + 1) : rest.slice(k + 2);
    if (mod !== undefined && PY_BIN.test(mod)) return one(pipCommand("pip", after, words));
    if (mod === "uv") return parseWords(["uv", ...after], depth + 1);
    if (mod === "pipx") return parseWords(["pipx", ...after], depth + 1);
    if (mod === "poetry") return parseWords(["poetry", ...after], depth + 1);
    if (mod === "pdm") return parseWords(["pdm", ...after], depth + 1);
    if (mod === "pipenv") return parseWords(["pipenv", ...after], depth + 1);
    return [];
  }
  if (bin === "uv") {
    const { sub, pre, args } = subcommand(rest, PIP_VALUE_FLAGS);
    const all = [...pre, ...args];
    if (sub === "pip") return one(pipCommand("uv", args, words, pre));
    if (sub === "add") return [pipLike("uv", all, words, "add")];
    if (sub === "sync") return [pipLike("uv", all, words, "manifest")];
    if (sub === "tool") {
      const t = subcommand(args, PIP_VALUE_FLAGS);
      if (t.sub === "install") return [pipLike("uv", [...pre, ...t.pre, ...t.args], words, "add")];
      if (t.sub === "run") return one(pyExec("uv", [...pre, ...t.pre, ...t.args], words));
      return [];
    }
    if (sub === "run") return runWrapper("uv", all, words, depth);
    return [];
  }
  if (bin === "poetry" || bin === "pdm" || bin === "pipenv") {
    const manager: Manager = bin;
    const { sub, pre, args } = subcommand(rest, PIP_VALUE_FLAGS);
    const all = [...pre, ...args];
    if (sub === "add") return [pipLike(manager, all, words, "add")];
    if (sub === "install") return [pipLike(manager, all, words, bin === "pipenv" ? undefined : "manifest")];
    if (sub === "sync" || (bin === "pdm" && sub === "update") || (bin === "poetry" && sub === "update")) return [pipLike(manager, all, words, "manifest")];
    if (sub === "run") return runWrapper(manager, all, words, depth);
    return [];
  }
  if (bin === "pip-sync") {
    const p = pipLike("pip", rest, words, "manifest");
    p.requirementFiles.push(...p.targets.map((t) => t.name), ...p.nonRegistry.filter((n) => !isDynamicWord(n)));
    p.targets = [];
    p.nonRegistry = p.nonRegistry.filter(isDynamicWord);
    if (p.requirementFiles.length === 0) p.requirementFiles.push("requirements.txt");
    return [p];
  }
  if (bin === "pipx") {
    const { sub, pre, args } = subcommand(rest, PIP_VALUE_FLAGS);
    const all = [...pre, ...args];
    if (sub === "install") return [pipLike("pipx", all, words, "add")];
    if (sub === "run") return one(pyExec("pipx", all, words));
    if (sub === "inject") {
      // pipx inject <venv> <package…>: the first positional names an existing venv
      const p = pipLike("pipx", all, words, "add");
      p.targets = p.targets.slice(1);
      return p.targets.length > 0 || p.nonRegistry.length > 0 ? [p] : [];
    }
    return [];
  }
  return [];
}

/** pip <sub> … (also `uv pip <sub>`): install / download / wheel fetch packages and may build sdists. */
function pipCommand(manager: Manager, args: string[], argv: string[], extraPre: string[] = []): ParsedInstall | null {
  const { sub, pre, args: subArgs } = subcommand(args, PIP_VALUE_FLAGS);
  const all = [...extraPre, ...pre, ...subArgs];
  if (sub === "install" || sub === "download" || sub === "wheel") return pipLike(manager, all, argv, "add");
  if (sub === "sync" && manager === "uv") {
    const p = pipLike(manager, all, argv, "manifest");
    p.requirementFiles.push(...p.targets.map((t) => t.name), ...p.nonRegistry.filter((n) => !isDynamicWord(n)));
    p.targets = [];
    p.nonRegistry = p.nonRegistry.filter(isDynamicWord);
    return p;
  }
  return null;
}

/** `uv run [--with x] cmd …` / `poetry run cmd …`: --with packages are fetched, and cmd itself may be an install. */
function runWrapper(manager: Manager, args: string[], argv: string[], depth: number): ParsedInstall[] {
  const out: ParsedInstall[] = [];
  const { pos, flags } = positionals(args, PIP_VALUE_FLAGS, { stopAtPositional: true, pyStyle: true });
  const withs = [...(flags.get("--with") ?? [])].flatMap(splitWith);
  const reqs = flags.get("--with-requirements") ?? [];
  const editable = flags.get("--with-editable") ?? [];
  if (withs.length > 0 || reqs.length > 0 || editable.length > 0) {
    const res: ParsedInstall = { manager, ecosystem: "pypi", kind: "exec", targets: [], nonRegistry: [...editable], requirementFiles: [...reqs], argv };
    for (const w of withs) addPip(res, w);
    setPyRegistry(res, flags);
    out.push(res);
  }
  const inner = pos[0] === "--" ? pos.slice(1) : pos;
  if (inner.length > 0) out.push(...parseWords(inner, depth + 1));
  return out;
}

function subcommand(args: string[], valueFlags: Set<string>): { sub: string | undefined; pre: string[]; args: string[] } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    return { sub: a, pre: args.slice(0, i), args: args.slice(i + 1) };
  }
  return { sub: undefined, pre: [...args], args: [] };
}

function stripDashDash(args: string[]): string[] {
  const i = args.indexOf("--");
  return i >= 0 ? [...args.slice(0, i), ...args.slice(i + 1)] : args;
}

interface PositionalOptions {
  /** everything from the first positional on belongs to the executed command (npx, uvx) */
  stopAtPositional?: boolean;
  /** optparse-style short clusters: -Ur req.txt, -rreq.txt */
  pyStyle?: boolean;
  /** resolve unambiguous prefixes of these long options (pip / npm accept abbreviations) */
  abbrev?: string[];
  /** boolean long options considered when resolving abbreviations */
  booleans?: string[];
}

function positionals(args: string[], valueFlags: Set<string>, o: PositionalOptions = {}): { pos: string[]; flags: Map<string, string[]> } {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  const put = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  const resolve = (k: string) => {
    if (valueFlags.has(k) || !o.abbrev || !k.startsWith("--") || k.length < 5 || o.booleans?.includes(k)) return k;
    const m = [...o.abbrev, ...(o.booleans ?? [])].filter((f) => f.startsWith(k));
    return m.length === 1 ? m[0]! : k;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      const eq = a.indexOf("=");
      if (a.startsWith("--") && eq > 0) {
        put(resolve(a.slice(0, eq)), a.slice(eq + 1));
      } else if (a.startsWith("--")) {
        const k = resolve(a);
        if (valueFlags.has(k) || /^--@[^:]+:registry$/.test(k)) {
          const v = args[i + 1];
          if (v !== undefined) put(k, v);
          i++;
        } else put(k, "");
      } else if (valueFlags.has(a)) {
        const v = args[i + 1];
        if (v !== undefined) put(a, v);
        i++;
      } else if (o.pyStyle && a.length > 2) {
        // short cluster: -Ur file, -rfile, -e.
        for (let j = 1; j < a.length; j++) {
          const f = `-${a[j]}`;
          if (valueFlags.has(f)) {
            const attached = a.slice(j + 1);
            if (attached) put(f, attached);
            else {
              const v = args[i + 1];
              if (v !== undefined) put(f, v);
              i++;
            }
            break;
          }
          put(f, "");
        }
      } else if (eq > 0) {
        put(a.slice(0, eq), a.slice(eq + 1));
      } else put(a, "");
      continue;
    }
    if (o.stopAtPositional) {
      pos.push(...args.slice(i));
      break;
    }
    pos.push(a);
  }
  return { pos, flags };
}

// ---------- npm family ----------

const NON_REGISTRY_NPM = /^(git\+|git:|git@|ssh:|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:|workspace:|portal:|patch:|exec:|jsr:|\.{0,2}\/|~|[A-Za-z]:[\\/])/;

/** Parse an npm spec: name, name@range, @scope/name@range, alias@npm:real@range. */
export function parseNpmSpec(spec: string): { target?: InstallTarget; nonRegistry?: string } {
  if (spec === "") return {};
  if (isDynamicWord(spec)) return { nonRegistry: spec };
  if (NON_REGISTRY_NPM.test(spec) || /\.(tgz|tar\.gz|tar)$/i.test(spec)) return { nonRegistry: spec };
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith("npm:")) return { nonRegistry: spec }; // any other URL scheme
  if (/^[^@/][^@]*\/[^@]*$/.test(spec)) return { nonRegistry: spec }; // user/repo shorthand, paths
  let s = spec;
  const alias = /^(@?[^@]+)@npm:(.+)$/.exec(s) ?? /^npm:(.+)$/.exec(s);
  if (alias) s = alias[alias.length - 1]!;
  const m = /^(@[^/@\s]+\/[^@\s]+|[^@\s]+)(?:@(.*))?$/.exec(s);
  if (!m) return { nonRegistry: spec };
  const name = m[1]!;
  const versionSpec = m[2];
  if (!isValidNpmName(name)) return { nonRegistry: spec };
  // name@github:a/b, name@a/b, name@https://…, name@file:../x — not from the registry
  if (versionSpec !== undefined && /[:/\\]/.test(versionSpec)) return { nonRegistry: spec };
  return { target: versionSpec ? { ecosystem: "npm", name, versionSpec } : { ecosystem: "npm", name } };
}

function isValidNpmName(name: string): boolean {
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-zA-Z0-9-~][a-zA-Z0-9-._~]*$/.test(name) && name.length <= 214;
}

function addNpm(res: ParsedInstall, spec: string) {
  const r = parseNpmSpec(spec);
  if (r.target) res.targets.push(r.target);
  if (r.nonRegistry) res.nonRegistry.push(r.nonRegistry);
}

function npmRegistryFlag(flags: Map<string, string[]>): string | undefined {
  for (const [k, v] of flags) {
    if (v[0] && (k === "--registry" || /^--@[^:]+:registry$/.test(k))) return v[0];
  }
  return undefined;
}

/** `--registry`/`--@scope:registry` set the registry; `--userconfig`/`--globalconfig` load an npmrc that can change it unseen. */
function applyNpmConfigFlags(res: ParsedInstall, flags: Map<string, string[]>) {
  const reg = npmRegistryFlag(flags);
  if (reg) res.registry = reg;
  for (const f of ["--userconfig", "--globalconfig"]) {
    const v = flags.get(f)?.[0];
    if (v) res.nonRegistry.push(`${f} ${v} (npm config file may change the registry)`);
  }
}

function npmLike(manager: Manager, args: string[], argv: string[], kind?: InstallKind): ParsedInstall {
  const { pos, flags } = positionals(args, manager === "npm" ? NPM_VALUE_FLAGS : PNPM_VALUE_FLAGS, { abbrev: ["--registry"] });
  const res: ParsedInstall = { manager, ecosystem: "npm", kind: kind ?? (pos.length > 0 ? "add" : "manifest"), targets: [], nonRegistry: [], requirementFiles: [], argv };
  applyNpmConfigFlags(res, flags);
  for (const p of pos) addNpm(res, p);
  return res;
}

function npmExec(manager: Manager, args: string[], argv: string[]): ParsedInstall | null {
  const { pos, flags } = positionals(args, NPX_VALUE_FLAGS, { stopAtPositional: true, abbrev: ["--registry"] });
  const res: ParsedInstall = { manager, ecosystem: "npm", kind: "exec", targets: [], nonRegistry: [], requirementFiles: [], argv };
  const pkgs = [...(flags.get("-p") ?? []), ...(flags.get("--package") ?? [])];
  applyNpmConfigFlags(res, flags);
  const specs = pkgs.length > 0 ? pkgs : pos.slice(0, 1);
  for (const p of specs) addNpm(res, p);
  return res.targets.length > 0 || res.nonRegistry.length > 0 ? res : null;
}

/** `npm init foo` runs create-foo; `@scope` → @scope/create; `@scope/foo` → @scope/create-foo. */
export function initializerPackage(spec: string): string {
  if (spec.startsWith("@")) {
    const m = /^(@[^/@]+)(?:\/([^@]+))?(@.*)?$/.exec(spec);
    if (!m) return spec;
    return `${m[1]}/create${m[2] ? `-${m[2]}` : ""}${m[3] ?? ""}`;
  }
  const m = /^([^@]+)(@.*)?$/.exec(spec);
  return m ? `create-${m[1]}${m[2] ?? ""}` : spec;
}

function npmCreate(manager: Manager, args: string[], argv: string[]): ParsedInstall | null {
  const { pos, flags } = positionals(args, manager === "npm" ? NPM_VALUE_FLAGS : PNPM_VALUE_FLAGS, { stopAtPositional: true, abbrev: ["--registry"] });
  const first = pos[0] === "--" ? undefined : pos[0];
  if (first === undefined) return null; // plain `npm init`: writes package.json only
  const res: ParsedInstall = { manager, ecosystem: "npm", kind: "exec", targets: [], nonRegistry: [], requirementFiles: [], argv };
  applyNpmConfigFlags(res, flags);
  const direct = /^@[^/@]+(@[^/]*)?$/.test(first) ? parseNpmSpec(initializerPackage(first)) : parseNpmSpec(first);
  if (direct.nonRegistry) res.nonRegistry.push(direct.nonRegistry);
  else if (direct.target) addNpm(res, initializerPackage(first));
  return res;
}

/** deno add / install / run with npm: specifiers (jsr: and URLs are not verifiable here). */
function denoInstall(args: string[], argv: string[]): ParsedInstall | null {
  const { sub, pre, args: rest } = subcommand(args, new Set(["--config", "-c", "--import-map", "--lock", "--cert", "--location", "--env-file"]));
  if (sub === undefined) return null;
  const isAdd = sub === "add" || sub === "install" || sub === "i";
  const isExec = sub === "run" || sub === "x";
  if (!isAdd && !isExec) return null;
  const { pos } = positionals([...pre, ...rest], new Set(["--config", "-c", "--import-map", "--lock", "--cert", "--location", "--env-file", "--root", "-n", "--name", "--allow-scripts"]), isExec ? { stopAtPositional: true } : {});
  const res: ParsedInstall = { manager: "deno", ecosystem: "npm", kind: isExec ? "exec" : "add", targets: [], nonRegistry: [], requirementFiles: [], argv };
  for (const p of isExec ? pos.slice(0, 1) : pos) {
    if (p.startsWith("npm:")) addNpm(res, p.slice(4));
    else if (p.startsWith("jsr:") || /^https?:/.test(p) || isDynamicWord(p)) res.nonRegistry.push(p);
  }
  if (isAdd && pos.length === 0) {
    res.kind = "manifest";
    return res;
  }
  return res.targets.length > 0 || res.nonRegistry.length > 0 ? res : null;
}

// ---------- python family ----------

/** PEP 503 normalisation. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const PEP440_CLAUSE = String.raw`(~=|===|==|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+`;
const PEP440_SPEC = new RegExp(String.raw`^\(?\s*${PEP440_CLAUSE}\s*(,\s*${PEP440_CLAUSE}\s*)*\)?$`);

export function parsePipSpec(spec: string): { target?: InstallTarget; nonRegistry?: string } {
  const s = spec.trim();
  if (s === "") return {};
  if (isDynamicWord(s)) return { nonRegistry: s };
  // VCS / URLs / archives / local paths
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || /^(git|hg|svn|bzr)\+/i.test(s) || /[/\\]/.test(s.split(";")[0]!) || /^~/.test(s) || s === "." || s === "..") return { nonRegistry: s };
  if (/\.(whl|tar\.gz|tgz|tar\.bz2|tar\.xz|tar|zip|egg)$/i.test(s.split(";")[0]!.trim())) return { nonRegistry: s };
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m) return { nonRegistry: s };
  const name = m[1]!;
  const rest = (m[3] ?? "").split(";")[0]!.trim();
  if (rest.startsWith("@")) return { nonRegistry: s }; // PEP 508 direct reference
  if (rest === "") return { target: { ecosystem: "pypi", name } };
  if (!PEP440_SPEC.test(rest)) return { nonRegistry: s }; // not a version specifier: pip won't treat it as a registry name
  const exact = /^\(?\s*===?\s*([^\s,()]+)\s*\)?$/.exec(rest);
  if (exact && !exact[1]!.includes("*")) return { target: { ecosystem: "pypi", name, versionSpec: exact[1]! } };
  return { target: { ecosystem: "pypi", name, versionSpec: rest.replace(/\s+/g, "") } };
}

function addPip(res: ParsedInstall, spec: string) {
  const r = parsePipSpec(spec);
  if (r.target) res.targets.push(r.target);
  if (r.nonRegistry) res.nonRegistry.push(r.nonRegistry);
}

/** uv / poetry also accept `name@1.2` and `name@latest` (not a direct reference). */
function atVersion(spec: string): string {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?)@([^:/@\s]+)$/.exec(spec.trim());
  if (!m) return spec;
  if (m[2] === "latest") return m[1]!;
  return /^[~^]/.test(m[2]!) ? `${m[1]}>=${m[2]!.slice(1)}` : /^[<>=!~]/.test(m[2]!) ? `${m[1]}${m[2]}` : `${m[1]}==${m[2]}`;
}

/** uv --with accepts comma-separated lists. */
function splitWith(v: string): string[] {
  return v.split(/,(?=\s*[A-Za-z])/).map((x) => x.trim()).filter(Boolean);
}

function setPyRegistry(res: ParsedInstall, flags: Map<string, string[]>) {
  const idx = ["-i", "--index-url", "--extra-index-url", "--index", "--default-index"].map((k) => flags.get(k)?.find(Boolean)).find(Boolean);
  if (idx) res.registry = idx;
  // --find-links: archives from a URL / local directory can satisfy any requirement
  for (const f of ["-f", "--find-links"].flatMap((k) => flags.get(k) ?? [])) if (f) res.nonRegistry.push(`--find-links ${f}`);
}

function pipLike(manager: Manager, args: string[], argv: string[], kind?: InstallKind): ParsedInstall {
  const { pos, flags } = positionals(args, manager === "poetry" ? POETRY_VALUE_FLAGS : manager === "pip" ? PIP_ONLY_VALUE_FLAGS : PIP_VALUE_FLAGS, {
    pyStyle: true,
    ...(manager === "pip" ? { abbrev: PIP_LONG_VALUE, booleans: PIP_LONG_BOOL } : {}),
  });
  const res: ParsedInstall = { manager, ecosystem: "pypi", kind: kind ?? (pos.length > 0 ? "add" : "manifest"), targets: [], nonRegistry: [], requirementFiles: [], argv };
  const reqs = ["-r", "--requirement", "-c", "--constraint", "--with-requirements"].flatMap((k) => flags.get(k) ?? []).filter(Boolean);
  res.requirementFiles.push(...reqs);
  for (const e of ["-e", "--editable", "--with-editable"].flatMap((k) => flags.get(k) ?? [])) {
    if (!e) continue;
    // local project: still reported as unverifiable code, and its pyproject dependencies get checked
    if (isLocalDir(e)) (res.projectDirs ??= []).push(e);
    res.nonRegistry.push(e);
  }
  setPyRegistry(res, flags);
  const uvLike = manager === "uv" || manager === "poetry" || manager === "pdm" || manager === "pipx";
  for (const p of pos) {
    if (manager !== "pipx" && isLocalDir(p)) (res.projectDirs ??= []).push(p);
    addPip(res, uvLike ? atVersion(p) : p);
  }
  for (const w of (flags.get("--with") ?? []).flatMap(splitWith)) addPip(res, atVersion(w));
  if (reqs.length > 0 && res.targets.length === 0 && res.nonRegistry.length === 0) res.kind = "manifest";
  if (res.projectDirs && res.targets.length === 0) res.kind = "manifest";
  return res;
}

/** `.`, `./pkg`, `../x`, `/abs/dir` (optionally with `[extras]`) — not an archive or URL. */
function isLocalDir(spec: string): boolean {
  const s = spec.replace(/\[[^\]]*\]$/, "");
  return (s === "." || s === ".." || /^(\.{1,2}\/|\/|~\/)/.test(s)) && !/\.(whl|tar\.gz|tgz|zip)$/.test(s) && !/[$`*?]/.test(s);
}

function pyExec(manager: Manager, args: string[], argv: string[]): ParsedInstall | null {
  const { pos, flags } = positionals(args, PIP_VALUE_FLAGS, { stopAtPositional: true, pyStyle: true });
  const res: ParsedInstall = { manager, ecosystem: "pypi", kind: "exec", targets: [], nonRegistry: [], requirementFiles: [], argv };
  const from = flags.get("--from")?.find(Boolean) ?? flags.get("--spec")?.find(Boolean);
  const specs = [from ?? pos[0], ...(flags.get("--with") ?? []).flatMap(splitWith)].filter((x): x is string => x !== undefined);
  for (const p of specs) addPip(res, atVersion(p));
  res.requirementFiles.push(...(flags.get("--with-requirements") ?? []).filter(Boolean));
  for (const e of flags.get("--with-editable") ?? []) if (e) res.nonRegistry.push(e);
  setPyRegistry(res, flags);
  return res.targets.length > 0 || res.nonRegistry.length > 0 || res.requirementFiles.length > 0 ? res : null;
}

/** Parse requirements.txt content into targets (options, comments; URLs / paths / index overrides → nonRegistry). */
export function parseRequirementsTxt(text: string): { targets: InstallTarget[]; nonRegistry: string[]; includes: string[] } {
  const targets: InstallTarget[] = [];
  const nonRegistry: string[] = [];
  const includes: string[] = [];
  // pip joins lines ending in a backslash before parsing
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const inc = /^(-r|--requirement|-c|--constraint)\s*=?\s*(\S+)/.exec(line);
    if (inc) {
      includes.push(inc[2]!);
      continue;
    }
    if (/^(-e|--editable)\b/.test(line)) {
      nonRegistry.push(line);
      continue;
    }
    // an index / find-links override changes where every other line is fetched from
    if (/^(-i|--index-url|--extra-index-url|-f|--find-links)\b/.test(line)) {
      nonRegistry.push(line);
      continue;
    }
    if (line.startsWith("-")) continue;
    // per-requirement options: requests==2.31.0 --hash=sha256:…
    const spec = line.replace(/\s+--?[A-Za-z][\s\S]*$/, "").trim();
    const r = parsePipSpec(spec);
    if (r.target) targets.push(r.target);
    if (r.nonRegistry) nonRegistry.push(r.nonRegistry);
  }
  return { targets, nonRegistry, includes };
}

/** Dependencies from a package.json (dependencies + dev + optional + peer — npm ≥ 7 installs peers). */
export function parsePackageJsonDeps(json: unknown): { targets: InstallTarget[]; nonRegistry: string[] } {
  const targets: InstallTarget[] = [];
  const nonRegistry: string[] = [];
  if (typeof json !== "object" || json === null) return { targets, nonRegistry };
  const obj = json as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = obj[field];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range !== "string") continue;
      // workspace:/link:/portal: point at packages inside this repo — nothing is fetched.
      if (/^(workspace|link|portal):/.test(range.trim())) continue;
      const r = parseNpmSpec(`${name}@${range.trim()}`);
      if (r.nonRegistry) nonRegistry.push(`${name}@${range}`);
      else if (r.target) targets.push(r.target);
    }
  }
  return { targets, nonRegistry };
}
