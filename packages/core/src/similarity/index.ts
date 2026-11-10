import { createRequire } from "node:module";
import { normalizePypiName } from "../parse/command.js";
import type { Ecosystem } from "../schemas.js";

/** Optimal-string-alignment Damerau-Levenshtein distance with an early-exit bound. */
export function damerauLevenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  let prev2 = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[m]!;
}

/** Collapse look-alike characters (l/1/i, o/0, rn/m, vv/w) so "rnongoose" ≈ "mongoose". */
export function homoglyphFold(s: string): string {
  return s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[1i|]/g, "l").replace(/0/g, "o").replace(/5/g, "s");
}

/** Comparison key: lowercase, PEP 503 for PyPI, scope stripped for npm. */
export function compareKey(eco: Ecosystem, name: string): string {
  const n = eco === "pypi" ? normalizePypiName(name) : name.toLowerCase();
  return n.replace(/^@[^/]+\//, "");
}

export function tokens(name: string): string[] {
  return name
    .replace(/^@[^/]+\//, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[-_.\s/]+/)
    .filter((t) => t.length > 0);
}

export interface TopList {
  names: string[];
  /** exact names (original case/scope) */
  set: Set<string>;
  keys: Map<string, string>;
  folded: Map<string, string>;
  tokenIndex: Map<string, string[]>;
  tokenSets: Map<string, string[]>;
}

export function buildTopList(eco: Ecosystem, names: string[]): TopList {
  const keys = new Map<string, string>();
  const folded = new Map<string, string>();
  const tokenIndex = new Map<string, string[]>();
  const tokenSets = new Map<string, string[]>();
  for (const n of names) {
    const k = compareKey(eco, n);
    if (!keys.has(k)) keys.set(k, n);
    const f = homoglyphFold(k);
    if (!folded.has(f)) folded.set(f, n);
    const ts = [...new Set(tokens(n))];
    tokenSets.set(n, ts);
    for (const t of ts) {
      const list = tokenIndex.get(t);
      if (list) list.push(n);
      else tokenIndex.set(t, [n]);
    }
  }
  return { names, set: new Set(names.map((n) => (eco === "pypi" ? normalizePypiName(n) : n))), keys, folded, tokenIndex, tokenSets };
}

const cache = new Map<Ecosystem, TopList>();
export function defaultTopList(eco: Ecosystem): TopList {
  let t = cache.get(eco);
  if (!t) {
    const require = createRequire(import.meta.url);
    const data = require(`../../data/top-${eco}.json`) as { names: string[] };
    t = buildTopList(eco, data.names);
    cache.set(eco, t);
  }
  return t;
}

export function isTop(eco: Ecosystem, name: string, top: TopList): boolean {
  return top.set.has(eco === "pypi" ? normalizePypiName(name) : name);
}

export interface TyposquatHit {
  of: string;
  distance: number;
  homoglyph: boolean;
}

/** DOCS §3: distance ≤ 2 (≤ 1 when shorter than 6) to a top package, or a homoglyph-equal name. */
export function findTyposquat(eco: Ecosystem, name: string, top: TopList): TyposquatHit | null {
  if (isTop(eco, name, top)) return null;
  const k = compareKey(eco, name);
  if (k.length < 4) return null;
  // Same unscoped name as a popular package under a different scope: @evil/react
  if (name.startsWith("@") && top.keys.has(k) && top.keys.get(k) !== name && !top.keys.get(k)!.startsWith("@")) {
    return { of: top.keys.get(k)!, distance: 0, homoglyph: false };
  }
  const f = homoglyphFold(k);
  const g = top.folded.get(f);
  if (g && compareKey(eco, g) !== k) return { of: g, distance: damerauLevenshtein(k, compareKey(eco, g)), homoglyph: true };

  const max = k.length < 6 ? 1 : 2;
  let best: TyposquatHit | null = null;
  for (const [tk, orig] of top.keys) {
    if (Math.abs(tk.length - k.length) > max || tk.length < 4) continue;
    if (tk === k) continue;
    const d = damerauLevenshtein(k, tk, max);
    if (d <= max && (!best || d < best.distance)) {
      best = { of: orig, distance: d, homoglyph: false };
      if (d === 1) break;
    }
  }
  if (best && isBenignVariant(k, compareKey(eco, best.of))) return null;
  return best;
}

/** Legitimate near-neighbours that aren't squats: version-numbered siblings ("vue2" vs "vue3"). */
function isBenignVariant(a: string, b: string): boolean {
  return /\d$/.test(a) && /\d$/.test(b) && a.replace(/\d+$/, "") === b.replace(/\d+$/, "");
}

const tokenMatches = (t: string, u: string) => t === u || (t.length >= 4 && u.length > t.length && (u.endsWith(t) || u.startsWith(t)));

/**
 * DOCS §3 conflation: the name's tokens are covered by the union of two popular packages' tokens,
 * neither covers it alone, and the name itself isn't popular (e.g. react-codeshift = react-* + jscodeshift).
 */
export function findConflation(eco: Ecosystem, name: string, top: TopList): [string, string] | null {
  if (isTop(eco, name, top)) return null;
  const ts = [...new Set(tokens(name))];
  if (ts.length < 2) return null;

  const coverers = new Map<string, Set<string>>(); // top name → which of our tokens it covers
  for (const t of ts) {
    for (const [tok, list] of top.tokenIndex) {
      if (!tokenMatches(t, tok)) continue;
      for (const n of list) {
        const s = coverers.get(n) ?? new Set<string>();
        s.add(t);
        coverers.set(n, s);
      }
    }
  }
  const cands = [...coverers.entries()].filter(([n, s]) => s.size < ts.length && (top.tokenSets.get(n)?.length ?? 0) <= 3);
  // prefer the most popular pair: top list order is popularity order
  const rank = new Map(top.names.map((n, i) => [n, i]));
  cands.sort((a, b) => (rank.get(a[0]) ?? 1e9) - (rank.get(b[0]) ?? 1e9));
  for (let i = 0; i < cands.length && i < 400; i++) {
    const [a, sa] = cands[i]!;
    for (let j = i + 1; j < cands.length && j < 400; j++) {
      const [b, sb] = cands[j]!;
      if (ts.every((t) => sa.has(t) || sb.has(t)) && [...sb].some((t) => !sa.has(t)) && [...sa].some((t) => !sb.has(t))) {
        return [a, b];
      }
    }
  }
  return null;
}
