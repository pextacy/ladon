import { ageMs, DAY, HOUR, humanAge, type Evidence } from "../evidence.js";

export interface RuleResult {
  hit: boolean;
  detail: string;
  /** dynamic weight for rules with tiers (R03, R06); defaults to rule.weight */
  weight?: number;
}

export interface Rule {
  id: string;
  name: string;
  /** "override" → always hold, score 100 (DOCS §1) */
  weight: number | "override";
  evaluate(ev: Evidence): RuleResult;
}

const miss: RuleResult = { hit: false, detail: "" };
const reg = (ev: Evidence) => (ev.ecosystem === "npm" ? "npm" : "PyPI");
const first = (xs: string[]) => xs[0]!.replace(/ \((.*)\)$/, " in $1");
const more = (xs: string[]) => (xs.length > 1 ? ` (+${xs.length - 1} more)` : "");

export const R01: Rule = {
  id: "R01",
  name: "not_found",
  weight: "override",
  evaluate: (ev) =>
    ev.exists === false
      ? { hit: true, detail: `"${ev.name}" does not exist on ${reg(ev)} — the agent likely hallucinated this name` }
      : miss,
};

export const R02: Rule = {
  id: "R02",
  name: "osv_malicious",
  weight: "override",
  evaluate: (ev) =>
    ev.osv && ev.osv.malicious.length > 0
      ? { hit: true, detail: `known malicious package (OSV ${ev.osv.malicious.slice(0, 2).join(", ")})` }
      : miss,
};

export const R03: Rule = {
  id: "R03",
  name: "atlas_hallucinated",
  weight: 35,
  evaluate: (ev) => {
    const a = ev.atlas;
    if (!a?.hallucinated) return miss;
    const models = a.models.length > 0 ? ` by ${a.models.length} model${a.models.length === 1 ? "" : "s"}` : "";
    let detail = `AI models hallucinate this name${models} (Hallucination Atlas)`;
    let weight = 35;
    const age = ageMs(ev, a.registeredAt ?? undefined);
    if (age !== undefined && age < 30 * DAY) {
      weight += 20;
      detail += ` — and someone registered it ${humanAge(age)} ago`;
    }
    return { hit: true, detail, weight };
  },
};

const POPULAR_ENOUGH = 10_000;

export const R04: Rule = {
  id: "R04",
  name: "typosquat",
  weight: 25,
  evaluate: (ev) => {
    const s = ev.similarity;
    if (!s?.typosquatOf || (ev.weeklyDownloads ?? 0) >= POPULAR_ENOUGH) return miss;
    const how = s.distance === 0 ? "same name under a different scope" : s.homoglyph ? "look-alike characters" : `${s.distance} letter${s.distance === 1 ? "" : "s"} off`;
    return { hit: true, detail: `looks like the popular "${s.typosquatOf}" (${how})` };
  },
};

export const R05: Rule = {
  id: "R05",
  name: "conflation",
  weight: 20,
  evaluate: (ev) => {
    const c = ev.similarity?.conflationOf;
    if (!c || (ev.weeklyDownloads ?? 0) >= POPULAR_ENOUGH) return miss;
    return { hit: true, detail: `name blends "${c[0]}" and "${c[1]}" — a typical AI-hallucinated shape` };
  },
};

export const R06: Rule = {
  id: "R06",
  name: "very_new",
  weight: 20,
  evaluate: (ev) => {
    const age = ageMs(ev, ev.registry?.firstPublished);
    if (age === undefined || age >= 7 * DAY) return miss;
    return { hit: true, detail: `package first published ${humanAge(age)} ago`, weight: age < 72 * HOUR ? 30 : 20 };
  },
};

export const R07: Rule = {
  id: "R07",
  name: "new_version_spike",
  weight: 30,
  evaluate: (ev) => {
    const r = ev.registry;
    if (!r?.previousVersion) return miss;
    const age = ageMs(ev, r.versionPublished);
    if (age === undefined || age >= 48 * HOUR) return miss;
    const publisherChanged = !!r.publisher && !!r.previousPublisher && r.publisher !== r.previousPublisher && !r.previousMaintainers.includes(r.publisher);
    const added = r.maintainers.filter((m) => !r.previousMaintainers.includes(m));
    const maintainersChanged = r.previousMaintainers.length > 0 && added.length > 0;
    if (!publisherChanged && !maintainersChanged) return miss;
    const who = publisherChanged ? `published by ${r.publisher}, previous release by ${r.previousPublisher}` : `new maintainer ${added.join(", ")}`;
    return { hit: true, detail: `version ${ev.version} is ${humanAge(age)} old and ${who} — worm pattern` };
  },
};

export const R08: Rule = {
  id: "R08",
  name: "install_script",
  weight: 15,
  evaluate: (ev) => {
    const r = ev.registry;
    if (!r) return miss;
    const hooks = Object.entries(r.installScripts);
    if (hooks.length > 0) {
      const [k, v] = hooks[0]!;
      return { hit: true, detail: `runs code at install time (${k}: "${v.length > 60 ? v.slice(0, 57) + "..." : v}")` };
    }
    if (r.hasBindingGyp) return { hit: true, detail: "builds native code at install time (binding.gyp)" };
    const b = r.buildBackend;
    if (b && (b.inTree || b.nonStandard || b.hooks.length > 0)) {
      const name = b.backend ? `"${b.backend}"` : "";
      const what = b.inTree
        ? `builds with an in-tree backend ${name} (backend-path) shipped inside the sdist`
        : b.hooks.length > 0
          ? `build hook ${b.hooks.join(", ")} runs at install time`
          : `uses the non-standard build backend ${name}`;
      const extra = b.inTree && b.hooks.length > 0 ? ` + build hook ${b.hooks.join(", ")}` : !b.inTree && b.hooks.length > 0 && b.nonStandard ? ` (non-standard backend ${name})` : "";
      return { hit: true, detail: `no wheel available — ${what}${extra}` };
    }
    if (r.setupPyRuns) return { hit: true, detail: "no wheel available — setup.py runs code at install time" };
    return miss;
  },
};

export const R09: Rule = {
  id: "R09",
  name: "script_network",
  weight: 25,
  evaluate: (ev) => (ev.scripts && ev.scripts.network.length > 0 ? { hit: true, detail: `install script ${first(ev.scripts.network)}${more(ev.scripts.network)}` } : miss),
};

export const R10: Rule = {
  id: "R10",
  name: "script_env",
  weight: 25,
  evaluate: (ev) => (ev.scripts && ev.scripts.env.length > 0 ? { hit: true, detail: `install script ${first(ev.scripts.env)}${more(ev.scripts.env)}` } : miss),
};

export const R11: Rule = {
  id: "R11",
  name: "script_obfuscation",
  weight: 20,
  evaluate: (ev) =>
    ev.scripts && ev.scripts.obfuscation.length > 0 ? { hit: true, detail: `install script ${first(ev.scripts.obfuscation)}${more(ev.scripts.obfuscation)}` } : miss,
};

export const R12: Rule = {
  id: "R12",
  name: "low_downloads",
  weight: 10,
  evaluate: (ev) =>
    ev.weeklyDownloads !== undefined && ev.weeklyDownloads !== null && ev.weeklyDownloads < 100 && !ev.lockfile.present
      ? { hit: true, detail: `only ${ev.weeklyDownloads} download${ev.weeklyDownloads === 1 ? "" : "s"} last week` }
      : miss,
};

export const R13: Rule = {
  id: "R13",
  name: "repo_mismatch",
  weight: 10,
  evaluate: (ev) => {
    if (ev.exists !== true || !ev.registry) return miss;
    if (!ev.registry.repositoryUrl) return { hit: true, detail: "no source repository linked" };
    if (ev.repo?.referencesPackage === false) return { hit: true, detail: `linked repository doesn't match: ${ev.repo.note ?? "name differs"}` };
    return miss;
  },
};

export const R14: Rule = {
  id: "R14",
  name: "no_provenance",
  weight: 25,
  evaluate: (ev) => {
    const r = ev.registry;
    if (!r || (ev.weeklyDownloads ?? 0) <= 100_000) return miss;
    const what = ev.ecosystem === "npm" ? "provenance attestation" : "PEP 740 attestation";
    return r.previousProvenance === true && r.provenance === false
      ? { hit: true, detail: `popular package, but ${ev.version} lacks the ${what} ${r.previousVersion} had` }
      : miss;
  },
};

export const R15: Rule = {
  id: "R15",
  name: "agent_config_write",
  weight: 30,
  evaluate: (ev) =>
    ev.scripts && ev.scripts.agentConfig.length > 0
      ? { hit: true, detail: `install code ${first(ev.scripts.agentConfig)} — AI-tool persistence pattern` }
      : miss,
};

/** Lockfile pins this version with a hash the registry does not publish for it (tampered lockfile or registry). */
export const L01: Rule = {
  id: "L01",
  name: "lockfile_integrity_mismatch",
  weight: 60,
  evaluate: (ev) =>
    ev.lockfile.integrity === "mismatch"
      ? { hit: true, detail: `lockfile hash for ${ev.lockfile.version ?? "this version"} doesn't match ${reg(ev)}${ev.lockfile.integrityDetail ? ` (${ev.lockfile.integrityDetail})` : ""} — lockfile or registry tampered` }
      : miss,
};

export const ALL_RULES: Rule[] = [R01, R02, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13, R14, R15, L01];
