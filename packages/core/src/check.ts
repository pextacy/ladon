import semver from "semver";
import { analyzeNpmTarball, analyzeSdist, installScriptsOf } from "./analyze/scripts.js";
import { ageMs, emptyEvidence, HOUR, type Evidence, type RegistryEvidence } from "./evidence.js";
import { compareIntegrity, type LockfileIndex } from "./lockfile.js";
import { parsePep440Specifier, satisfiesPep440 } from "./parse/pep440.js";
import { scoreEvidence, type Hit, type ScoreOptions } from "./score.js";
import type { InstallTarget, Verdict } from "./schemas.js";
import { defaultTopList, findConflation, findTyposquat, isTop, type TopList } from "./similarity/index.js";
import type { AtlasSource } from "./sources/atlas.js";
import { cached, TTL, type Cache } from "./sources/cache.js";
import { SourceError } from "./sources/http.js";
import { npmRegistryIntegrity, previousNpmVersion, resolveNpmVersion, type NpmSource } from "./sources/npm.js";
import type { OsvSource } from "./sources/osv.js";
import { previousPypiVersion, provenanceFile, resolvePypiVersion, type PypiSource } from "./sources/pypi.js";
import type { RepoSource } from "./sources/repo.js";

export interface CheckDeps {
  npm: NpmSource;
  pypi: PypiSource;
  osv: OsvSource;
  atlas?: AtlasSource;
  repo?: RepoSource;
  /** cache for derived results (tarball analysis) */
  cache?: Cache;
  topLists?: { npm: TopList; pypi: TopList };
  now?: () => Date;
}

export interface CheckOptions extends ScoreOptions {
  lockfile?: LockfileIndex;
  /** download and statically analyse install scripts (default true) */
  analyzeScripts?: boolean;
  /** compare the linked GitHub repo (default true when deps.repo is set) */
  repoCheck?: boolean;
}

export interface Report {
  target: InstallTarget;
  version?: string;
  score: number;
  verdict: Verdict;
  hits: Hit[];
  evidence: Evidence;
  fastPath?: "lockfile";
  durationMs: number;
}

const errMsg = (e: unknown) => (e instanceof SourceError ? e.message : e instanceof Error ? e.message : String(e));

async function soft<T>(ev: Evidence, source: string, critical: boolean, p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    ev.errors.push({ source, message: errMsg(e), critical });
    return undefined;
  }
}

/** Lockfile fast path (PLAN §1 step 2): requested version is already pinned. */
function lockedMatch(target: InstallTarget, lock: LockfileIndex | undefined): string | undefined {
  if (!lock) return undefined;
  const versions = lock.versions(target.ecosystem, target.name);
  if (versions.length === 0 || !target.versionSpec) return undefined;
  const spec = target.versionSpec;
  if (target.ecosystem === "pypi") {
    const pep = parsePep440Specifier(spec);
    return versions.find((v) => v === spec || (pep !== null && pep.clauses.length > 0 && satisfiesPep440(v, pep, true)));
  }
  return versions.find((v) => v === spec || (semver.validRange(spec) !== null && semver.valid(v) !== null && semver.satisfies(v, spec)));
}

/**
 * Compare the lockfile's hash for `version` with what the registry publishes (cached packument /
 * project JSON — the full check reuses it). Fetch problems → "unknown": the fast path then behaves
 * as before, without claiming integrity.
 */
async function lockIntegrity(target: InstallTarget, version: string, locked: string[], deps: CheckDeps): Promise<{ result: "match" | "mismatch" | "unknown"; detail?: string }> {
  try {
    let published: string[];
    if (target.ecosystem === "npm") {
      const info = await deps.npm.packument(target.name);
      published = npmRegistryIntegrity(info?.versions[version]);
    } else {
      const info = await deps.pypi.project(target.name);
      published = (info?.releases[version]?.files ?? []).flatMap((f) => (f.sha256 ? [`sha256:${f.sha256}`] : []));
    }
    const result = compareIntegrity(locked, published);
    if (result !== "mismatch") return { result };
    const short = (t: string) => (t.length > 22 ? `${t.slice(0, 22)}…` : t);
    return { result, detail: `locked ${short(locked[0]!)}, registry ${short(published[0]!)}` };
  } catch {
    return { result: "unknown" };
  }
}

export async function checkPackage(target: InstallTarget, deps: CheckDeps, opts: CheckOptions = {}): Promise<Report> {
  const started = Date.now();
  const now = deps.now?.() ?? new Date();
  const ev = emptyEvidence(target.ecosystem, target.name, now);
  if (target.versionSpec) ev.requested = target.versionSpec;
  const locked = opts.lockfile?.versions(target.ecosystem, target.name) ?? [];
  if (locked.length > 0) ev.lockfile = { present: true, version: locked[0]! };

  const fast = lockedMatch(target, opts.lockfile);
  if (fast) {
    ev.lockfile.version = fast;
    const hashes = opts.lockfile!.integrity(target.ecosystem, target.name, fast);
    const integ = hashes.length > 0 ? await lockIntegrity(target, fast, hashes, deps) : undefined;
    if (integ?.result === "mismatch") {
      // the pinned artifact is not what the registry serves for this version → full check + L01
      ev.lockfile.integrity = "mismatch";
      if (integ.detail) ev.lockfile.integrityDetail = integ.detail;
    } else {
      if (integ) ev.lockfile.integrity = integ.result === "match" ? "verified" : "unchecked";
      ev.version = fast;
      ev.exists = true;
      const r: Report = { target, version: fast, score: 0, verdict: "allow", hits: [], evidence: ev, fastPath: "lockfile", durationMs: Date.now() - started };
      return r;
    }
  }

  const top = deps.topLists?.[target.ecosystem] ?? defaultTopList(target.ecosystem);
  const popular = isTop(target.ecosystem, target.name, top);
  ev.similarity = { isTop: popular };

  if (target.ecosystem === "npm") await gatherNpm(ev, target, deps, opts);
  else await gatherPypi(ev, target, deps, opts);

  if (ev.exists !== false && !popular) {
    const t = findTyposquat(target.ecosystem, target.name, top);
    if (t) Object.assign(ev.similarity, { typosquatOf: t.of, distance: t.distance, homoglyph: t.homoglyph });
    const c = findConflation(target.ecosystem, target.name, top);
    if (c) ev.similarity.conflationOf = c;
  }

  const scored = scoreEvidence(ev, opts);
  const r: Report = { target, score: scored.score, verdict: scored.verdict, hits: scored.hits, evidence: ev, durationMs: Date.now() - started };
  if (ev.version) r.version = ev.version;
  return r;
}

async function gatherNpm(ev: Evidence, target: InstallTarget, deps: CheckDeps, opts: CheckOptions) {
  const atlasP = deps.atlas ? soft(ev, "Atlas", false, deps.atlas.lookup("npm", target.name)) : Promise.resolve(undefined);
  let info;
  try {
    info = await deps.npm.packument(target.name);
  } catch (e) {
    ev.errors.push({ source: "npm registry", message: errMsg(e), critical: true });
    const a = await atlasP;
    if (a) ev.atlas = a;
    return;
  }
  if (info === null || Object.keys(info.versions).length === 0) {
    ev.exists = false;
    const a = await atlasP;
    if (a) ev.atlas = a;
    return;
  }
  ev.exists = true;
  const version = resolveNpmVersion(info, target.versionSpec) ?? info.distTags.latest;
  const v = version ? info.versions[version] : undefined;
  if (version) ev.version = version;
  const prev = version ? previousNpmVersion(info, version) : undefined;

  const regEv: RegistryEvidence = {
    maintainers: v?.maintainers ?? [],
    previousMaintainers: prev?.maintainers ?? [],
    installScripts: installScriptsOf(v?.scripts ?? {}),
    hasBindingGyp: v?.gypfile === true,
  };
  if (info.created) regEv.firstPublished = info.created;
  if (v?.time) regEv.versionPublished = v.time;
  if (info.distTags.latest) regEv.latest = info.distTags.latest;
  if (v?.description) regEv.description = v.description;
  if (info.readmeExcerpt) regEv.readmeExcerpt = info.readmeExcerpt;
  if (v?.publisher) regEv.publisher = v.publisher;
  if (prev) {
    regEv.previousVersion = prev.version;
    if (prev.publisher) regEv.previousPublisher = prev.publisher;
    regEv.previousProvenance = prev.provenance;
  }
  if (v) regEv.provenance = v.provenance;
  if (v?.repositoryUrl) regEv.repositoryUrl = v.repositoryUrl;
  if (v?.repositoryDirectory) regEv.repositoryDirectory = v.repositoryDirectory;
  if (v?.deprecated) regEv.deprecated = v.deprecated;
  if (v?.tarball) regEv.tarballUrl = v.tarball;
  if (v?.unpackedSize !== undefined) regEv.unpackedSize = v.unpackedSize;
  ev.registry = regEv;

  const hasScripts = Object.keys(regEv.installScripts).length > 0 || regEv.hasBindingGyp;
  const analyze = (opts.analyzeScripts ?? true) && !!v?.tarball;
  const [dl, osv, atlas, repo, scripts] = await Promise.all([
    soft(ev, "npm downloads", false, deps.npm.weeklyDownloads(target.name)),
    soft(ev, "OSV", true, deps.osv.query("npm", target.name, version)),
    atlasP,
    deps.repo && (opts.repoCheck ?? true) && regEv.repositoryUrl
      ? soft(ev, "repository", false, deps.repo.referencesPackage(regEv.repositoryUrl, regEv.repositoryDirectory, target.name, "npm"))
      : Promise.resolve(undefined),
    analyze
      ? soft(
          ev,
          "install-script analysis",
          hasScripts,
          cached(deps.cache, `analysis:npm:${target.name}@${version}:v1`, TTL.analysis, async () => {
            const tgz = await deps.npm.tarball(v!.tarball!, 8 * 1024 * 1024);
            return tgz ? analyzeNpmTarball(regEv.installScripts, tgz) : null;
          }),
        )
      : Promise.resolve(undefined),
  ]);
  if (dl !== undefined) ev.weeklyDownloads = dl;
  if (osv) ev.osv = osv;
  if (atlas) ev.atlas = atlas;
  if (repo) ev.repo = repo;
  if (scripts) {
    const { hasBindingGyp, ...findings } = scripts;
    ev.scripts = findings;
    if (hasBindingGyp) regEv.hasBindingGyp = true;
  }
}

async function gatherPypi(ev: Evidence, target: InstallTarget, deps: CheckDeps, opts: CheckOptions) {
  const atlasP = deps.atlas ? soft(ev, "Atlas", false, deps.atlas.lookup("pypi", target.name)) : Promise.resolve(undefined);
  let info;
  try {
    info = await deps.pypi.project(target.name);
  } catch (e) {
    ev.errors.push({ source: "PyPI", message: errMsg(e), critical: true });
    const a = await atlasP;
    if (a) ev.atlas = a;
    return;
  }
  if (info === null || Object.keys(info.releases).length === 0) {
    ev.exists = false;
    const a = await atlasP;
    if (a) ev.atlas = a;
    return;
  }
  ev.exists = true;
  const version = resolvePypiVersion(info, target.versionSpec) ?? info.latest;
  if (version) ev.version = version;
  const rel = version ? info.releases[version] : undefined;
  const prev = version ? previousPypiVersion(info, version) : undefined;
  const regEv: RegistryEvidence = {
    maintainers: version === info.latest ? (info.people ?? (info.author ? [info.author] : [])) : info.author ? [info.author] : [],
    previousMaintainers: [],
    installScripts: {},
    hasBindingGyp: false,
  };
  if (info.created) regEv.firstPublished = info.created;
  if (rel?.time) regEv.versionPublished = rel.time;
  regEv.latest = info.latest;
  if (info.summary) regEv.description = info.summary;
  if (info.readmeExcerpt) regEv.readmeExcerpt = info.readmeExcerpt;
  if (info.repositoryUrl) regEv.repositoryUrl = info.repositoryUrl;
  if (rel?.sdistUrl) regEv.sdistUrl = rel.sdistUrl;
  if (prev) regEv.previousVersion = prev.version;
  ev.registry = regEv;

  // R07 only looks at versions < 48 h old: fetch per-version metadata just for those.
  const age = ageMs(ev, rel?.time);
  const recent = age !== undefined && age < 48 * HOUR;
  const pypi = deps.pypi;
  const people = async (v: string) => (v === info.latest && info.people ? info.people : ((await pypi.release!(target.name, v))?.people ?? null));
  const peopleP =
    recent && prev && version && pypi.release
      ? soft(ev, "PyPI release metadata", false, Promise.all([people(version), people(prev.version)]))
      : Promise.resolve(undefined);

  const dlP = soft(ev, "pypistats", false, deps.pypi.weeklyDownloads(target.name));
  // PEP 740 provenance (R14 for popular packages, publisher identity for R07 on recent versions)
  const provP = dlP.then(async (dl) => {
    if (!prev || !version || !pypi.provenance || !(recent || (dl ?? 0) > 100_000)) return undefined;
    const curFile = provenanceFile(rel);
    const prevFile = provenanceFile(prev, curFile?.packagetype);
    if (!curFile || !prevFile) return undefined;
    return soft(ev, "PyPI provenance", false, Promise.all([pypi.provenance(target.name, version, curFile.filename), pypi.provenance(target.name, prev.version, prevFile.filename)]));
  });

  const sdistOnly = !!rel && !rel.hasWheel && !!rel.sdistUrl;
  const [dl, osv, atlas, repo, setup, ppl, prov] = await Promise.all([
    dlP,
    soft(ev, "OSV", true, deps.osv.query("pypi", target.name, version)),
    atlasP,
    deps.repo && (opts.repoCheck ?? true) && regEv.repositoryUrl
      ? soft(ev, "repository", false, deps.repo.referencesPackage(regEv.repositoryUrl, undefined, info.name, "pypi"))
      : Promise.resolve(undefined),
    sdistOnly && (opts.analyzeScripts ?? true)
      ? soft(
          ev,
          "setup.py analysis",
          false,
          cached(deps.cache, `analysis:pypi:${target.name}@${version}:v1`, TTL.analysis, async () => {
            const tgz = await deps.pypi.sdist(rel.sdistUrl!, 8 * 1024 * 1024);
            return tgz ? analyzeSdist(tgz) : null;
          }),
        )
      : Promise.resolve(undefined),
    peopleP,
    provP,
  ]);
  if (ppl) {
    const [cur, before] = ppl;
    if (cur) regEv.maintainers = cur;
    if (before) regEv.previousMaintainers = before;
  }
  if (prov) {
    const [cur, before] = prov;
    regEv.provenance = cur !== null;
    regEv.previousProvenance = before !== null;
    if (cur?.publisher) regEv.publisher = cur.publisher;
    if (before?.publisher) regEv.previousPublisher = before.publisher;
  }
  if (dl !== undefined) ev.weeklyDownloads = dl;
  if (osv) ev.osv = osv;
  if (atlas) ev.atlas = atlas;
  if (repo) ev.repo = repo;
  if (setup) {
    const { runsCode, ...findings } = setup;
    ev.scripts = findings;
    regEv.setupPyRuns = runsCode || findings.network.length > 0 || findings.env.length > 0;
  }
}

/** Check several targets with bounded concurrency. */
export async function checkMany(targets: InstallTarget[], deps: CheckDeps, opts: CheckOptions = {}, concurrency = 6): Promise<Report[]> {
  const out: Report[] = new Array(targets.length);
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const idx = i++;
      out[idx] = await checkPackage(targets[idx]!, deps, opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return out;
}

/** Worst verdict wins. */
export function combineVerdicts(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("hold")) return "hold";
  if (verdicts.includes("warn")) return "warn";
  return "allow";
}
