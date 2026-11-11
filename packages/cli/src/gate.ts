import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  isDynamicWord,
  STDIN_ARGS,
  agentMessage,
  applyIntent,
  buildIntentInput,
  checkMany,
  combineVerdicts,
  commandHash,
  countedHits,
  createDeps,
  formatReport,
  LockfileIndex,
  newNonce,
  newRequestId,
  nextStep,
  parseClaudeTranscript,
  parseInstallCommand,
  parseLockfile,
  parsePackageJsonDeps,
  parseRequirementsTxt,
  pkgLabel,
  type CheckDeps,
  type InstallTarget,
  type ParsedInstall,
  type Report,
  type Verdict,
} from "@ladon/core";
import { requestApproval, type ApprovalOutcome, type Approver, type PendingApproval } from "./approve/index.js";
import { loadConfig, loadState, PATHS, type Config } from "./config.js";
import { isDefaultNpm, npmRegistryFor, pypiIndexFor } from "./registry.js";
import { atlasReport, postDecision, type DecisionLog } from "./web.js";

export interface GateInput {
  command: string;
  cwd: string;
  transcriptPath?: string;
  /** who ran it: claude-code, cursor, human, ... */
  agent?: string;
  /** called with progress lines for the human (stderr / Key / notifications) */
  onStatus?: (msg: string) => void;
}

export interface GateResult {
  decision: "allow" | "deny";
  verdict: Verdict;
  outcome: DecisionLog["outcome"] | "none";
  reports: Report[];
  /** human-facing terminal text */
  display: string;
  /** text for the coding agent (hook deny reason / shim stderr) */
  agentText: string;
  approval?: ApprovalOutcome;
  durationMs: number;
}

export interface GateEnv {
  approvers: Approver[];
  /** override data sources (tests) */
  deps?: (registry: { npm?: string; pypi?: string }) => CheckDeps;
  config?: Config;
  intent?: (input: ReturnType<typeof buildIntentInput>) => Promise<import("@ladon/core").IntentResult | null>;
  now?: () => Date;
  /** serialize approvals (the Key shows one request at a time) */
  approvalLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

// Targets a human approved recently: the hook and the PATH shim may both see the same install.
const recentlyApproved = new Map<string, number>();
const APPROVAL_MEMORY_MS = 10 * 60_000;
const memKey = (r: Report) => `${r.target.ecosystem}:${r.target.name}@${r.version ?? r.target.versionSpec ?? ""}`;

function findUp(start: string, names: readonly string[]): string[] {
  const found: string[] = [];
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    for (const n of names) if (existsSync(join(dir, n))) found.push(join(dir, n));
    if (found.length > 0 || existsSync(join(dir, ".git"))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return found;
}

const LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "pdm.lock"] as const;

export function loadLockfiles(cwd: string): LockfileIndex {
  const idx = new LockfileIndex();
  for (const f of findUp(cwd, LOCKS)) {
    try {
      if (statSync(f).size < 30 * 1024 * 1024) parseLockfile(f, readFileSync(f, "utf8"), idx);
    } catch {
      /* unreadable lockfile → just no fast path */
    }
  }
  return idx;
}

/** Turn one parsed install into concrete registry targets (manifest installs read the manifest). */
export function targetsFor(p: ParsedInstall, cwd: string, lock: LockfileIndex): { targets: InstallTarget[]; unverifiable: string[] } {
  const unverifiable = [...p.nonRegistry];
  if (p.kind !== "manifest") return { targets: p.targets, unverifiable };
  const targets = [...p.targets];
  if (p.ecosystem === "pypi") {
    const seen = new Set<string>();
    const queue = p.requirementFiles.map((f) => resolve(cwd, f));
    while (queue.length > 0) {
      const f = queue.shift()!;
      if (seen.has(f) || seen.size > 10) continue;
      seen.add(f);
      try {
        const r = parseRequirementsTxt(readFileSync(f, "utf8"));
        targets.push(...r.targets);
        unverifiable.push(...r.nonRegistry);
        queue.push(...r.includes.map((i) => resolve(dirname(f), i)));
      } catch {
        unverifiable.push(`requirements file ${f.split("/").pop()} could not be read`);
      }
    }
    return { targets, unverifiable };
  }
  // npm-family manifest install: the lockfile was reviewed when it was committed; check only
  // dependencies that are not pinned in it.
  const pj = findUp(cwd, ["package.json"])[0];
  if (!pj) return { targets, unverifiable };
  try {
    const deps = parsePackageJsonDeps(JSON.parse(readFileSync(pj, "utf8")));
    unverifiable.push(...deps.nonRegistry);
    for (const t of deps.targets) if (!lock.has("npm", t.name)) targets.push(t);
  } catch {
    /* invalid package.json → npm itself will fail */
  }
  return { targets, unverifiable };
}

/**
 * A URL / git / path spec is a known thing the human can look at → warn. A package name that only exists at
 * run time (`$PKG`, `$(…)`, xargs/stdin, an npmrc passed with --userconfig) can't be checked at all → hold
 * (fail closed).
 */
export function unverifiableReport(spec: string, ecosystem: "npm" | "pypi", now: Date): Report {
  const dynamic = spec === STDIN_ARGS || isDynamicWord(spec) || /^--(user|global)config /.test(spec);
  const weight = dynamic ? 60 : 35;
  const detail = dynamic
    ? `the package is only known at run time (${spec.slice(0, 60)}) — Ladon cannot check it`
    : "installs from a URL, git repo or local path — Ladon cannot verify it";
  return {
    target: { ecosystem, name: spec.slice(0, 120) },
    score: weight,
    verdict: dynamic ? "hold" : "warn",
    hits: [{ id: "G01", name: "non_registry_source", weight, override: false, detail }],
    evidence: { ecosystem, name: spec, exists: null, lockfile: { present: false }, errors: [], now: now.toISOString() },
    durationMs: 0,
  };
}

function registryReport(registry: string, ecosystem: "npm" | "pypi", now: Date): Report {
  return {
    target: { ecosystem, name: `registry ${new URL(registry, "http://x").host}` },
    score: 30,
    verdict: "warn",
    hits: [{ id: "G02", name: "custom_registry", weight: 30, override: false, detail: `uses a non-default registry (${registry}) — make sure you trust it` }],
    evidence: { ecosystem, name: registry, exists: null, lockfile: { present: false }, errors: [], now: now.toISOString() },
    durationMs: 0,
  };
}

const isLoopback = (u: string) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};

function modelFromTranscript(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n").slice(-50).reverse();
    for (const l of lines) {
      const m = /"model"\s*:\s*"([\w.:-]{3,60})"/.exec(l);
      if (m) return m[1];
    }
  } catch {
    /* no transcript */
  }
  return undefined;
}

export async function gate(input: GateInput, env: GateEnv): Promise<GateResult> {
  const started = Date.now();
  const cfg = env.config ?? loadConfig();
  const now = env.now?.() ?? new Date();
  const installs = parseInstallCommand(input.command);
  const empty: GateResult = { decision: "allow", verdict: "allow", outcome: "none", reports: [], display: "", agentText: "", durationMs: 0 };
  if (installs.length === 0) return { ...empty, durationMs: Date.now() - started };

  const lock = loadLockfiles(input.cwd);
  const state = loadState();
  const allowlisted = new Set(state.allowlist.map((a) => a.target));
  const reports: Report[] = [];

  for (const p of installs) {
    const { targets, unverifiable } = targetsFor(p, input.cwd, lock);
    for (const u of unverifiable) reports.push(unverifiableReport(u, p.ecosystem, now));
    const npmReg = p.ecosystem === "npm" ? npmRegistryFor(p, input.cwd) : undefined;
    const pypiIdx = p.ecosystem === "pypi" ? pypiIndexFor(p) : undefined;
    if (p.ecosystem === "npm" && npmReg && !isDefaultNpm(npmReg) && !isLoopback(npmReg) && p.registry) reports.push(registryReport(npmReg, "npm", now));
    const deps =
      env.deps?.({ ...(npmReg ? { npm: npmReg } : {}), ...(pypiIdx ? { pypi: pypiIdx } : {}) }) ??
      createDeps({ cacheDir: PATHS.cache, atlasUrl: cfg.webUrl, ...(npmReg ? { npmRegistry: npmReg } : {}), ...(pypiIdx ? { pypiIndex: pypiIdx } : {}) });
    const todo = targets.filter((t) => !allowlisted.has(`${t.ecosystem}:${t.name}`));
    const checked = await checkMany(todo.slice(0, 80), deps, { lockfile: lock, failMode: cfg.failMode });
    for (const r of checked) {
      if (p.kind === "exec" && r.verdict !== "allow") r.hits.push({ id: "G03", name: "exec", weight: 0, override: false, detail: "downloads and runs the package immediately (npx/uvx)" });
      reports.push(r);
    }
    if (targets.length > 80) reports.push(unverifiableReport(`${targets.length - 80} more dependencies not checked`, p.ecosystem, now));
  }

  // Intent drift (LLM, optional): escalate-only, only for packages that already raised something.
  const aiJudge = env.intent;
  if (aiJudge && input.transcriptPath) {
    let ctx: ReturnType<typeof parseClaudeTranscript> | null = null;
    try {
      ctx = parseClaudeTranscript(readFileSync(input.transcriptPath, "utf8"));
    } catch {
      ctx = null;
    }
    if (ctx?.userRequest) {
      const candidates = reports.filter((r) => r.evidence.exists === true && (r.verdict === "warn" || r.hits.length > 0)).slice(0, 3);
      await Promise.all(
        candidates.map(async (r) => {
          const intent = await aiJudge(buildIntentInput(r, ctx!.userRequest, ctx!.recentAgentSteps)).catch(() => null);
          const applied = applyIntent(r, intent);
          r.verdict = applied.verdict;
          r.score = applied.score;
          r.hits = applied.hits;
          if (intent) (r as Report & { intent?: typeof intent }).intent = intent;
        }),
      );
    }
  }

  let verdict = combineVerdicts(reports.map((r) => r.verdict));
  // A human already approved exactly these packages a moment ago (hook → shim double check).
  const nowMs = Date.now();
  for (const [k, t] of recentlyApproved) if (nowMs - t > APPROVAL_MEMORY_MS) recentlyApproved.delete(k);
  if (verdict === "hold" && reports.filter((r) => r.verdict === "hold").every((r) => recentlyApproved.has(memKey(r)))) verdict = "allow";

  const holdOnWarn = verdict === "warn" && cfg.onWarn === "hold";
  const needsApproval = verdict === "hold" || holdOnWarn;
  const approverKind = cfg.key ? "key" : cfg.passkeys.length > 0 ? "passkey" : "none";
  const shown = reports.filter((r) => r.verdict !== "allow" || reports.length <= 3);
  const display = [...shown.map((r) => formatReport(r, { color: !!process.stderr.isTTY })), nextStep(needsApproval ? "hold" : verdict, approverKind)].filter(Boolean).join("\n");

  let decision: GateResult["decision"] = "allow";
  let outcome: GateResult["outcome"] = verdict === "warn" ? "warned" : "allowed";
  let approval: ApprovalOutcome | undefined;

  if (needsApproval) {
    const worst = [...reports].sort((a, b) => b.score - a.score)[0]!;
    const holds = reports.filter((r) => r.verdict !== "allow");
    const label = holds.length > 1 ? `${pkgLabel(worst)} +${holds.length - 1}` : pkgLabel(worst);
    const intent = (worst as Report & { intent?: { drift: string; reason: string } }).intent;
    const req: PendingApproval = {
      id: newRequestId(),
      h: commandHash(input.command, input.cwd),
      n: newNonce(),
      exp: Math.floor(Date.now() / 1000) + cfg.approvalTimeoutSeconds,
      pkg: label,
      ecosystem: worst.target.ecosystem,
      name: worst.target.name,
      score: worst.score,
      why: holds.flatMap((r) => countedHits(r.hits).map((h) => h.detail)).slice(0, 3),
    };
    if (worst.version) req.version = worst.version;
    if (intent && intent.drift !== "none") req.intent = { drift: intent.drift, reason: intent.reason };
    input.onStatus?.(display);
    // The expiry starts when this request actually reaches the approver (after queueing behind another
    // approval), otherwise a queued request could expire before the human ever sees it.
    const ask = () => requestApproval(env.approvers, { ...req, exp: Math.floor(Date.now() / 1000) + cfg.approvalTimeoutSeconds }, input.onStatus);
    approval = await (env.approvalLock ? env.approvalLock(ask) : ask());
    if (approval.kind === "approved") {
      decision = "allow";
      outcome = "approved";
      for (const r of holds) recentlyApproved.set(memKey(r), Date.now());
    } else {
      decision = "deny";
      outcome = approval.kind === "rejected" ? "rejected" : approval.kind === "timeout" ? "timeout" : "blocked";
    }
  }

  const agentText =
    decision === "deny"
      ? `${agentMessage(reports, outcome === "rejected" ? "rejected" : outcome === "timeout" ? "timeout" : "blocked")}${approval ? `\n(${approval.detail})` : ""}`
      : verdict === "warn"
        ? `Ladon WARNING for this install (proceeding):\n${reports.filter((r) => r.verdict === "warn").map((r) => `${pkgLabel(r)}: ${countedHits(r.hits).slice(0, 3).map((h) => h.detail).join("; ")}`).join("\n")}`
        : "";

  const result: GateResult = { decision, verdict, outcome, reports, display, agentText, durationMs: Date.now() - started };
  if (approval) result.approval = approval;
  record(cfg, input, result);
  return result;
}

/** Local append-only log + opt-in dashboard + opt-in Atlas reports. Fire-and-forget. */
function record(cfg: Config, input: GateInput, r: GateResult) {
  const via = r.approval && (r.approval.kind === "approved" || r.approval.kind === "rejected") ? r.approval.via : null;
  for (const rep of r.reports) {
    if (rep.target.name.startsWith("registry ")) continue;
    const d: DecisionLog = {
      ts: new Date().toISOString(),
      ecosystem: rep.target.ecosystem,
      package: rep.target.name,
      verdict: rep.verdict,
      score: rep.score,
      reasons: countedHits(rep.hits).map((h) => h.detail).slice(0, 5),
      outcome: r.outcome === "none" ? "allowed" : rep.verdict === "allow" && r.outcome !== "rejected" && r.outcome !== "blocked" && r.outcome !== "timeout" ? "allowed" : r.outcome,
      via,
      agent: input.agent ?? "unknown",
    };
    if (rep.version) d.version = rep.version;
    try {
      appendFileSync(PATHS.log, JSON.stringify(d) + "\n", { mode: 0o600 });
    } catch {
      /* log dir missing */
    }
    if (cfg.dashboard && cfg.device) postDecision(cfg, d).catch(() => {});
    if (cfg.atlasReports && rep.evidence.exists === false) {
      const model = modelFromTranscript(input.transcriptPath);
      atlasReport(cfg, { ecosystem: rep.target.ecosystem, name: rep.target.name, ...(model ? { model } : {}) }).catch(() => {});
    }
  }
}
