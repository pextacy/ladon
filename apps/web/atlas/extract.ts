import { builtinModules, createRequire } from "node:module";
import { z } from "zod";

/** Structured output the probe asks each model for (validated again here; never trusted). */
export const ProbeOutput = z.object({
  packages: z
    .array(
      z.object({
        ecosystem: z.enum(["npm", "pypi"]).describe("registry the package is installed from"),
        name: z.string().describe("exact package name as typed in npm install / pip install"),
      }),
    )
    .describe("every third-party package you would install for this task"),
});
export type ProbeOutput = z.infer<typeof ProbeOutput>;

export interface ExtractedName {
  ecosystem: "npm" | "pypi";
  name: string;
}

const require = createRequire(import.meta.url);
const PY_STDLIB = new Set((require("./python-stdlib.json") as { names: string[] }).names.map((n) => n.toLowerCase()));
const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]!));

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;

export const pep503 = (n: string) => n.toLowerCase().replace(/[-_.]+/g, "-");

/** Turn one model-supplied string into a registry name, or null if it is not a plausible package. */
export function normalizeName(ecosystem: "npm" | "pypi", raw: string): string | null {
  let s = raw.trim().replace(/^[`'"]+|[`'"]+$/g, "");
  s = s.replace(/^(npm|pnpm|yarn|bun)\s+(i|install|add)\s+(-[\w-]+\s+)*/i, "").replace(/^(pip3?|uv|poetry)\s+(install|add)\s+(-[\w-]+\s+)*/i, "");
  // one package per entry; prose like "the requests library" is not a name
  if (/\s/.test(s.trim())) return null;
  s = s.trim();
  if (!s || s.length > 214) return null;
  if (ecosystem === "npm") {
    s = s.toLowerCase();
    // strip a version: name@1.2.3 or @scope/name@^1
    const at = s.indexOf("@", 1);
    if (at > 0) s = s.slice(0, at);
    if (s.startsWith("node:")) return null;
    if (!NPM_NAME.test(s)) return null;
    if (!s.startsWith("@") && NODE_BUILTINS.has(s)) return null;
    return s;
  }
  s = s.replace(/\[.*?\]/g, "").split(/[=<>!~;@ ]/)[0] ?? "";
  if (!PYPI_NAME.test(s)) return null;
  if (PY_STDLIB.has(s.toLowerCase())) return null;
  return pep503(s);
}

/** Validate + normalize + dedupe a model's answer. */
export function extractNames(output: unknown): ExtractedName[] {
  const parsed = ProbeOutput.safeParse(output);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  const out: ExtractedName[] = [];
  for (const p of parsed.data.packages.slice(0, 40)) {
    const name = normalizeName(p.ecosystem, p.name);
    if (!name) continue;
    const k = `${p.ecosystem}:${name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ecosystem: p.ecosystem, name });
  }
  return out;
}
