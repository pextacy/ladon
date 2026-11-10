import type { Ecosystem, InstallTarget } from "../schemas.js";
import { basename, effectiveCommands } from "./shell.js";

export type Manager = "npm" | "pnpm" | "yarn" | "bun" | "pip" | "uv" | "poetry" | "pipx";

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
  /** specs that don't come from the registry: git URLs, tarball URLs, local paths */
  nonRegistry: string[];
  /** pip -r / -c files */
  requirementFiles: string[];
  /** custom registry / index URL passed on the command line */
  registry?: string;
  argv: string[];
}

const NPM_INSTALL = new Set(["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add"]);
const NPM_MANIFEST = new Set(["ci", "clean-install", "install-clean", "isntall-clean", "ic"]);
const NPM_VALUE_FLAGS = new Set([
  "--registry", "--prefix", "-w", "--workspace", "--omit", "--include", "--cache", "--userconfig", "--tag",
  "-C", "--dir", "--filter", "-F", "--cwd", "--modules-folder", "--network-concurrency", "--loglevel", "--script-shell",
]);
/** In pnpm/yarn/bun, -w / --workspace(-root) is a boolean flag. */
const PNPM_VALUE_FLAGS = new Set([...NPM_VALUE_FLAGS].filter((f) => f !== "-w" && f !== "--workspace"));
const PIP_VALUE_FLAGS = new Set([
  "-r", "--requirement", "-c", "--constraint", "-i", "--index-url", "--extra-index-url", "-t", "--target",
  "--prefix", "--root", "-f", "--find-links", "--platform", "--python-version", "--implementation", "--abi",
  "--only-binary", "--no-binary", "--upgrade-strategy", "--src", "--log", "--cache-dir", "--trusted-host",
  "--progress-bar", "--python", "-p", "--group", "--optional", "--extra", "--index", "--default-index",
  "--source", "-G", "--with", "--python-platform", "--config-file", "--directory", "--project", "-e", "--editable",
]);

export function parseInstallCommand(command: string): ParsedInstall[] {
  const out: ParsedInstall[] = [];
  for (const words of effectiveCommands(command)) {
    const parsed = parseWords(words);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseWords(words: string[]): ParsedInstall | null {
  const head = words[0];
  if (head === undefined) return null;
  const bin = basename(head).replace(/\.(cmd|exe)$/i, "");
  const rest = words.slice(1);

  if (bin === "npx" || bin === "bunx") return npmExec(bin === "npx" ? "npm" : "bun", rest, words);
  if (bin === "uvx") return pyExec("uv", rest, words);

  if (bin === "npm") {
    const { sub, args } = subcommand(rest, NPM_VALUE_FLAGS);
    if (sub === undefined) return null;
    if (NPM_INSTALL.has(sub)) return npmLike("npm", args, words, args.some(isPositional) ? "add" : "manifest");
    if (NPM_MANIFEST.has(sub)) return npmLike("npm", args, words, "manifest");
    if (sub === "exec" || sub === "x") return npmExec("npm", stripDashDash(args), words);
    return null;
  }
  if (bin === "pnpm") {
    const { sub, args } = subcommand(rest, PNPM_VALUE_FLAGS);
    if (sub === undefined) return null;
    if (sub === "add") return npmLike("pnpm", args, words, "add");
    if (sub === "install" || sub === "i") return npmLike("pnpm", args, words, args.some(isPositional) ? "add" : "manifest");
    if (sub === "dlx") return npmExec("pnpm", args, words);
    return null;
  }
  if (bin === "yarn") {
    const { sub, args } = subcommand(rest, PNPM_VALUE_FLAGS);
    if (sub === undefined) return npmLike("yarn", [], words, "manifest");
    if (sub === "add") return npmLike("yarn", args, words, "add");
    if (sub === "install") return npmLike("yarn", args, words, "manifest");
    if (sub === "dlx") return npmExec("yarn", args, words);
    return null;
  }
  if (bin === "bun") {
    const { sub, args } = subcommand(rest, PNPM_VALUE_FLAGS);
    if (sub === undefined) return null;
    if (sub === "add" || sub === "a") return npmLike("bun", args, words, "add");
    if (sub === "install" || sub === "i") return npmLike("bun", args, words, args.some(isPositional) ? "add" : "manifest");
    if (sub === "x") return npmExec("bun", args, words);
    return null;
  }

  // python side
  let pyArgs: string[] | null = null;
  let manager: Manager = "pip";
  if (/^pip(\d+(\.\d+)?)?$/.test(bin)) pyArgs = rest;
  else if (/^python(\d+(\.\d+)?)?$/.test(bin) || bin === "py") {
    const m = rest.indexOf("-m");
    if (m >= 0 && /^pip(\d+(\.\d+)?)?$/.test(rest[m + 1] ?? "")) pyArgs = rest.slice(m + 2);
  } else if (bin === "uv") {
    const { sub, args } = subcommand(rest, PIP_VALUE_FLAGS);
    manager = "uv";
    if (sub === "pip") pyArgs = args;
    else if (sub === "add") return pipLike("uv", args, words, "add");
    else if (sub === "tool") {
      const t = subcommand(args, PIP_VALUE_FLAGS);
      if (t.sub === "install") return pipLike("uv", t.args, words, "add");
      if (t.sub === "run") return pyExec("uv", t.args, words);
      return null;
    } else if (sub === "sync") return pipLike("uv", args, words, "manifest");
    else return null;
  } else if (bin === "poetry") {
    const { sub, args } = subcommand(rest, PIP_VALUE_FLAGS);
    if (sub === "add") return pipLike("poetry", args, words, "add");
    if (sub === "install") return pipLike("poetry", args, words, "manifest");
    return null;
  } else if (bin === "pipx") {
    const { sub, args } = subcommand(rest, PIP_VALUE_FLAGS);
    if (sub === "install") return pipLike("pipx", args, words, "add");
    if (sub === "run") return pyExec("pipx", args, words);
    return null;
  }
  if (pyArgs === null) return null;
  const { sub, args } = subcommand(pyArgs, PIP_VALUE_FLAGS);
  if (sub !== "install") return null;
  return pipLike(manager, args, words, "add");
}

function subcommand(args: string[], valueFlags: Set<string>): { sub: string | undefined; args: string[] } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    return { sub: a, args: args.slice(i + 1) };
  }
  return { sub: undefined, args: [] };
}

function isPositional(a: string): boolean {
  return !a.startsWith("-");
}

function stripDashDash(args: string[]): string[] {
  const i = args.indexOf("--");
  return i >= 0 ? [...args.slice(0, i), ...args.slice(i + 1)] : args;
}

function positionals(args: string[], valueFlags: Set<string>): { pos: string[]; flags: Map<string, string[]> } {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        const k = a.slice(0, eq);
        flags.set(k, [...(flags.get(k) ?? []), a.slice(eq + 1)]);
      } else if (valueFlags.has(a)) {
        const v = args[i + 1];
        if (v !== undefined) flags.set(a, [...(flags.get(a) ?? []), v]);
        i++;
      } else {
        flags.set(a, [...(flags.get(a) ?? []), ""]);
      }
      continue;
    }
    pos.push(a);
  }
  return { pos, flags };
}

// ---------- npm family ----------

/** Parse an npm spec: name, name@range, @scope/name@range, alias@npm:real@range. */
export function parseNpmSpec(spec: string): { target?: InstallTarget; nonRegistry?: string } {
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:|workspace:|\.{0,2}\/|~\/)/.test(spec) || spec.endsWith(".tgz") || spec.endsWith(".tar.gz")) {
    return { nonRegistry: spec };
  }
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec) && !spec.startsWith("@")) return { nonRegistry: spec }; // user/repo shorthand
  let s = spec;
  const alias = /^(@?[^@]+)@npm:(.+)$/.exec(s);
  if (alias) s = alias[2]!;
  const m = /^(@[^/@\s]+\/[^@\s]+|[^@\s]+)(?:@(.*))?$/.exec(s);
  if (!m) return { nonRegistry: spec };
  const name = m[1]!;
  const versionSpec = m[2];
  if (!isValidNpmName(name)) return { nonRegistry: spec };
  return { target: versionSpec ? { ecosystem: "npm", name, versionSpec } : { ecosystem: "npm", name } };
}

function isValidNpmName(name: string): boolean {
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-zA-Z0-9-~][a-zA-Z0-9-._~]*$/.test(name) && name.length <= 214;
}

function npmLike(manager: Manager, args: string[], argv: string[], kind: InstallKind): ParsedInstall {
  const { pos, flags } = positionals(args, manager === "npm" ? NPM_VALUE_FLAGS : PNPM_VALUE_FLAGS);
  const res: ParsedInstall = { manager, ecosystem: "npm", kind, targets: [], nonRegistry: [], requirementFiles: [], argv };
  const reg = flags.get("--registry")?.[0];
  if (reg) res.registry = reg;
  for (const p of pos) {
    const r = parseNpmSpec(p);
    if (r.target) res.targets.push(r.target);
    if (r.nonRegistry) res.nonRegistry.push(r.nonRegistry);
  }
  return res;
}

function npmExec(manager: Manager, args: string[], argv: string[]): ParsedInstall {
  const { pos, flags } = positionals(args, new Set([...NPM_VALUE_FLAGS, "-p", "--package", "-c", "--call"]));
  const res: ParsedInstall = { manager, ecosystem: "npm", kind: "exec", targets: [], nonRegistry: [], requirementFiles: [], argv };
  const pkgs = [...(flags.get("-p") ?? []), ...(flags.get("--package") ?? [])];
  const reg = flags.get("--registry")?.[0];
  if (reg) res.registry = reg;
  const specs = pkgs.length > 0 ? pkgs : pos.slice(0, 1);
  for (const p of specs) {
    const r = parseNpmSpec(p);
    if (r.target) res.targets.push(r.target);
    if (r.nonRegistry) res.nonRegistry.push(r.nonRegistry);
  }
  return res;
}

// ---------- python family ----------

/** PEP 503 normalisation. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export function parsePipSpec(spec: string): { target?: InstallTarget; nonRegistry?: string } {
  const s = spec.trim();
  if (/^(git\+|https?:|file:|\.{0,2}\/|~\/)/.test(s) || /\.(whl|tar\.gz|zip)$/.test(s) || s === ".") return { nonRegistry: s };
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m) return { nonRegistry: s };
  const name = m[1]!;
  let rest = (m[3] ?? "").split(";")[0]!.trim();
  if (rest.startsWith("@")) return { nonRegistry: s }; // PEP 508 direct reference
  const exact = /^===?\s*([^\s,]+)$/.exec(rest);
  if (exact) return { target: { ecosystem: "pypi", name, versionSpec: exact[1]! } };
  if (rest.startsWith("@") || rest === "") return { target: { ecosystem: "pypi", name } };
  rest = rest.replace(/\s+/g, "");
  return { target: { ecosystem: "pypi", name, versionSpec: rest } };
}

function pipLike(manager: Manager, args: string[], argv: string[], kind: InstallKind): ParsedInstall {
  const { pos, flags } = positionals(args, PIP_VALUE_FLAGS);
  const res: ParsedInstall = { manager, ecosystem: "pypi", kind, targets: [], nonRegistry: [], requirementFiles: [], argv };
  const reqs = [...(flags.get("-r") ?? []), ...(flags.get("--requirement") ?? []), ...(flags.get("-c") ?? []), ...(flags.get("--constraint") ?? [])];
  res.requirementFiles.push(...reqs);
  for (const e of [...(flags.get("-e") ?? []), ...(flags.get("--editable") ?? [])]) res.nonRegistry.push(e);
  const idx = flags.get("-i")?.[0] ?? flags.get("--index-url")?.[0] ?? flags.get("--extra-index-url")?.[0] ?? flags.get("--index")?.[0];
  if (idx) res.registry = idx;
  for (const p of pos) {
    const r = parsePipSpec(p);
    if (r.target) res.targets.push(r.target);
    if (r.nonRegistry) res.nonRegistry.push(r.nonRegistry);
  }
  if (reqs.length > 0 && res.targets.length === 0) res.kind = "manifest";
  return res;
}

function pyExec(manager: Manager, args: string[], argv: string[]): ParsedInstall {
  const { pos, flags } = positionals(args, PIP_VALUE_FLAGS);
  const res: ParsedInstall = { manager, ecosystem: "pypi", kind: "exec", targets: [], nonRegistry: [], requirementFiles: [], argv };
  const from = flags.get("--from")?.[0] ?? flags.get("--spec")?.[0];
  const specs = [from ?? pos[0], ...(flags.get("--with") ?? [])].filter((x): x is string => x !== undefined);
  for (const p of specs) {
    const r = parsePipSpec(p);
    if (r.target) res.targets.push(r.target);
    if (r.nonRegistry) res.nonRegistry.push(r.nonRegistry);
  }
  return res;
}

/** Parse requirements.txt content into targets (ignores options, comments, URLs → nonRegistry). */
export function parseRequirementsTxt(text: string): { targets: InstallTarget[]; nonRegistry: string[]; includes: string[] } {
  const targets: InstallTarget[] = [];
  const nonRegistry: string[] = [];
  const includes: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const inc = /^(-r|--requirement|-c|--constraint)\s*=?\s*(\S+)/.exec(line);
    if (inc) {
      includes.push(inc[2]!);
      continue;
    }
    if (line.startsWith("-e ") || line.startsWith("--editable")) {
      nonRegistry.push(line);
      continue;
    }
    if (line.startsWith("-")) continue;
    const r = parsePipSpec(line);
    if (r.target) targets.push(r.target);
    if (r.nonRegistry) nonRegistry.push(r.nonRegistry);
  }
  return { targets, nonRegistry, includes };
}

/** Dependencies from a package.json (dependencies + devDependencies + optional). */
export function parsePackageJsonDeps(json: unknown): { targets: InstallTarget[]; nonRegistry: string[] } {
  const targets: InstallTarget[] = [];
  const nonRegistry: string[] = [];
  if (typeof json !== "object" || json === null) return { targets, nonRegistry };
  const obj = json as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = obj[field];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range !== "string") continue;
      const r = parseNpmSpec(range.startsWith("npm:") ? `${name}@${range}` : `${name}@${range}`);
      if (/^(git|github:|https?:|file:|link:|workspace:|\.)/.test(range)) nonRegistry.push(`${name}@${range}`);
      else if (r.target) targets.push(r.target);
    }
  }
  return { targets, nonRegistry };
}
