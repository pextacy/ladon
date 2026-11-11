import { normalizePypiName, parsePackageJsonDeps, parsePipfileDeps, parsePyprojectDeps, parseRequirementsTxt, type InstallTarget } from "@ladon/core";
import { MANIFEST_MAX_BYTES, MANIFEST_MAX_DEPS } from "./validate";

export type ManifestKind = "package.json" | "requirements.txt" | "pyproject.toml" | "Pipfile";
export const MANIFEST_KINDS: readonly ManifestKind[] = ["package.json", "requirements.txt", "pyproject.toml", "Pipfile"];
export type ManifestParse =
  | { ok: true; kind: ManifestKind; targets: InstallTarget[]; skipped: string[] }
  | { ok: false; error: string };

export function manifestKind(filename: string): ManifestKind | null {
  const base = filename.split(/[\\/]/).pop()!.toLowerCase();
  if (base === "package.json") return "package.json";
  if (base.endsWith(".txt")) return "requirements.txt";
  if (base === "pyproject.toml") return "pyproject.toml";
  if (base === "pipfile") return "Pipfile";
  return null;
}

/** Parse a manifest with the public checker's limits (≤ 200 KB, ≤ 60 registry deps). */
export function parseManifest(filename: string, content: string, maxDeps = MANIFEST_MAX_DEPS): ManifestParse {
  const kind = manifestKind(filename);
  if (!kind) return { ok: false, error: "unsupported file — upload a package.json, requirements.txt, pyproject.toml or Pipfile" };
  if (Buffer.byteLength(content) > MANIFEST_MAX_BYTES) return { ok: false, error: "manifest is larger than 200 KB" };
  let targets: InstallTarget[];
  let skipped: string[];
  if (kind === "package.json") {
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      return { ok: false, error: "package.json is not valid JSON" };
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, error: "package.json must be a JSON object" };
    // A dependency section must be a name → range object; an array would turn its indexes ("0", "1") into package names.
    const sane = Object.fromEntries(Object.entries(json).filter(([, v]) => !Array.isArray(v)));
    const r = parsePackageJsonDeps(sane);
    targets = r.targets;
    skipped = r.nonRegistry.map((s) => `${s} (not from the registry — not checked)`);
  } else if (kind === "pyproject.toml" || kind === "Pipfile") {
    const r = kind === "pyproject.toml" ? parsePyprojectDeps(content) : parsePipfileDeps(content);
    targets = r.targets;
    skipped = r.nonRegistry.map((s) => `${s} (not from the registry — not checked)`);
  } else {
    const r = parseRequirementsTxt(content);
    targets = r.targets;
    skipped = [
      ...r.nonRegistry.map((s) => `${s} (not from the registry — not checked)`),
      ...r.includes.map((s) => `-r ${s} (included file — upload it separately)`),
    ];
  }
  const seen = new Set<string>();
  targets = targets.filter((t) => {
    const k = `${t.ecosystem}:${t.ecosystem === "pypi" ? normalizePypiName(t.name) : t.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (targets.length === 0) return { ok: false, error: `no registry dependencies found in ${kind}` };
  if (targets.length > maxDeps) return { ok: false, error: `${kind} lists ${targets.length} dependencies; the public checker handles at most ${maxDeps} — use \`ladon check\` locally for bigger projects` };
  return { ok: true, kind, targets, skipped };
}
