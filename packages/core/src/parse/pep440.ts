/**
 * PEP 440 versions and specifiers (the subset pip uses to pick a release): ==, !=, <=, >=, <, >,
 * ~=, ===, `==1.2.*` / `!=1.2.*` wildcards, comma-joined clauses. Pure, no I/O.
 */

export interface Pep440Version {
  epoch: number;
  release: number[];
  pre?: [string, number];
  post?: number;
  dev?: number;
  local?: (string | number)[];
}

const VERSION_RE =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

const PRE_NORM: Record<string, string> = { a: "a", alpha: "a", b: "b", beta: "b", c: "rc", rc: "rc", pre: "rc", preview: "rc" };

export function parsePep440(v: string): Pep440Version | null {
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  const out: Pep440Version = { epoch: m[1] ? Number(m[1]) : 0, release: m[2]!.split(".").map(Number) };
  if (m[3]) out.pre = [PRE_NORM[m[3].toLowerCase()]!, m[4] ? Number(m[4]) : 0];
  if (m[5] !== undefined) out.post = Number(m[5]);
  else if (m[6]) out.post = m[7] ? Number(m[7]) : 0;
  if (m[8]) out.dev = m[9] ? Number(m[9]) : 0;
  if (m[10]) out.local = m[10].toLowerCase().split(/[-_.]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  return out;
}

export const isPrerelease = (v: Pep440Version) => v.pre !== undefined || v.dev !== undefined;

function cmpRelease(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const PRE_ORDER: Record<string, number> = { a: 0, b: 1, rc: 2 };

function cmpLocal(a: (string | number)[] | undefined, b: (string | number)[] | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return Math.sign(x - y);
    } else if (typeof x === "number") return 1;
    else if (typeof y === "number") return -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Total order from PEP 440 ("Summary of permitted suffixes and relative ordering"). */
export function comparePep440(a: Pep440Version, b: Pep440Version, ignoreLocal = false): number {
  if (a.epoch !== b.epoch) return Math.sign(a.epoch - b.epoch);
  const r = cmpRelease(a.release, b.release);
  if (r !== 0) return r;
  // pre: a dev-only release sorts before any pre-release; no pre sorts after
  const preKey = (v: Pep440Version): [number, number] =>
    v.pre ? [PRE_ORDER[v.pre[0]]!, v.pre[1]] : v.post === undefined && v.dev !== undefined ? [-1, 0] : [3, 0];
  const [pa, pb] = [preKey(a), preKey(b)];
  if (pa[0] !== pb[0]) return Math.sign(pa[0] - pb[0]);
  if (pa[1] !== pb[1]) return Math.sign(pa[1] - pb[1]);
  const postKey = (v: Pep440Version) => (v.post === undefined ? -1 : v.post);
  if (postKey(a) !== postKey(b)) return Math.sign(postKey(a) - postKey(b));
  const devKey = (v: Pep440Version) => (v.dev === undefined ? Infinity : v.dev);
  if (devKey(a) !== devKey(b)) return devKey(a) < devKey(b) ? -1 : 1;
  return ignoreLocal ? 0 : cmpLocal(a.local, b.local);
}

const publicOf = (v: Pep440Version): Pep440Version => {
  const { local: _local, ...rest } = v;
  return rest;
};

interface Clause {
  op: "==" | "!=" | "<=" | ">=" | "<" | ">" | "~=" | "===";
  raw: string;
  version?: Pep440Version;
  wildcard: boolean;
}

function parseClause(s: string): Clause | null {
  const m = /^\s*(===|==|!=|<=|>=|~=|<|>)\s*(\S+)\s*$/.exec(s);
  if (!m) return null;
  const op = m[1] as Clause["op"];
  const raw = m[2]!;
  if (op === "===") return { op, raw, wildcard: false };
  const wildcard = raw.endsWith(".*");
  if (wildcard && op !== "==" && op !== "!=") return null;
  const version = parsePep440(wildcard ? raw.slice(0, -2) : raw);
  if (!version) return null;
  if (op === "~=" && version.release.length < 2) return null;
  if (version.local && op !== "==" && op !== "!=") return null;
  return { op, raw, version, wildcard };
}

export interface Pep440Specifier {
  clauses: Clause[];
  /** a clause names a pre-release, so pre-releases are allowed */
  allowsPre: boolean;
}

/**
 * Parse a specifier set such as ">=1.2,<2,!=1.5.*". A bare version ("2.0", "1.2.*") means `==`.
 * Returns null when any clause is not valid PEP 440.
 */
export function parsePep440Specifier(spec: string): Pep440Specifier | null {
  const s = spec.trim();
  if (!s) return { clauses: [], allowsPre: false };
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const clauses: Clause[] = [];
  for (const p of parts) {
    const c = parseClause(/^[0-9vV]/.test(p) ? `==${p}` : p);
    if (!c) return null;
    clauses.push(c);
  }
  return { clauses, allowsPre: clauses.some((c) => c.op === "===" || (c.version !== undefined && isPrerelease(c.version))) };
}

function prefixMatch(cand: Pep440Version, prefix: Pep440Version): boolean {
  if (cand.epoch !== prefix.epoch) return false;
  const n = prefix.release.length;
  const padded = [...cand.release, ...Array<number>(Math.max(0, n - cand.release.length)).fill(0)];
  if (cmpRelease(padded.slice(0, n), prefix.release) !== 0) return false;
  // `==1.0rc1.*` style prefixes with suffixes: the suffixes must match exactly
  if (prefix.pre && (cand.pre?.[0] !== prefix.pre[0] || cand.pre[1] !== prefix.pre[1] || cand.release.length !== n)) return false;
  if (prefix.post !== undefined && cand.post !== prefix.post) return false;
  return true;
}

function clauseMatches(c: Clause, raw: string, cand: Pep440Version): boolean {
  if (c.op === "===") return raw.trim().toLowerCase() === c.raw.toLowerCase();
  const v = c.version!;
  const pub = publicOf(cand);
  switch (c.op) {
    case "==":
      return c.wildcard ? prefixMatch(pub, v) : comparePep440(v.local ? cand : pub, v) === 0;
    case "!=":
      return c.wildcard ? !prefixMatch(pub, v) : comparePep440(v.local ? cand : pub, v) !== 0;
    case "<=":
      return comparePep440(pub, v) <= 0;
    case ">=":
      return comparePep440(pub, v) >= 0;
    case "<":
      if (comparePep440(pub, v) >= 0) return false;
      // <3.0 must not match 3.0.0a1 unless the spec itself is a pre-release
      return isPrerelease(v) || !isPrerelease(pub) || cmpRelease(pub.release, v.release) !== 0 || pub.epoch !== v.epoch;
    case ">":
      if (comparePep440(pub, v) <= 0) return false;
      // >1.7 must not match 1.7.post1 unless the spec itself is a post-release
      if (v.post === undefined && pub.post !== undefined && cmpRelease(pub.release, v.release) === 0 && pub.epoch === v.epoch) return false;
      return comparePep440(cand, v, true) !== 0;
    case "~=": {
      if (comparePep440(pub, v) < 0) return false;
      const prefix: Pep440Version = { epoch: v.epoch, release: v.release.slice(0, -1) };
      return prefixMatch(pub, prefix);
    }
  }
}

export function satisfiesPep440(version: string, spec: Pep440Specifier, includePre = spec.allowsPre): boolean {
  const v = parsePep440(version);
  if (!v) return spec.clauses.length > 0 && spec.clauses.every((c) => c.op === "===" && clauseMatches(c, version, { epoch: 0, release: [] }));
  if (!includePre && isPrerelease(v)) return false;
  return spec.clauses.every((c) => clauseMatches(c, version, v));
}

/**
 * Highest version matching `spec`. Pre-releases are excluded unless the spec names one — or, as pip
 * does, when nothing but pre-releases match.
 */
export function maxSatisfyingPep440(versions: string[], spec: string): string | undefined {
  const s = parsePep440Specifier(spec);
  if (!s) return undefined;
  const pick = (includePre: boolean) => {
    let best: { raw: string; v: Pep440Version } | undefined;
    for (const raw of versions) {
      const v = parsePep440(raw);
      if (!v || !satisfiesPep440(raw, s, includePre)) continue;
      if (!best || comparePep440(v, best.v) > 0) best = { raw, v };
    }
    return best?.raw;
  };
  return pick(s.allowsPre) ?? (s.allowsPre ? undefined : pick(true));
}
