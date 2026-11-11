import type { Ecosystem } from "./schemas.js";

/** Static findings about what install-time code does. Each entry is a short human-readable reason. */
export interface ScriptFindings {
  analyzed: boolean;
  /** files actually inspected, relative to the package root */
  files: string[];
  network: string[];
  env: string[];
  obfuscation: string[];
  /** references to AI-agent / editor config paths anywhere in the package (R15) */
  agentConfig: string[];
  note?: string;
}

export interface RegistryEvidence {
  /** ISO time of the first-ever publish of this name */
  firstPublished?: string;
  /** ISO time the resolved version was published */
  versionPublished?: string;
  latest?: string;
  description?: string;
  /** first ~400 chars of the README, for the intent judge only */
  readmeExcerpt?: string;
  /** maintainers / publisher of the resolved version */
  maintainers: string[];
  publisher?: string;
  previousVersion?: string;
  previousMaintainers: string[];
  previousPublisher?: string;
  repositoryUrl?: string;
  repositoryDirectory?: string;
  /** install lifecycle scripts of the resolved version: name → command */
  installScripts: Record<string, string>;
  hasBindingGyp: boolean;
  /** npm provenance attestation present */
  provenance?: boolean;
  previousProvenance?: boolean;
  deprecated?: string;
  tarballUrl?: string;
  unpackedSize?: number;
  /** PyPI: sdist exists and no wheel → setup.py would run */
  setupPyRuns?: boolean;
  sdistUrl?: string;
}

export interface AtlasEvidence {
  hallucinated: boolean;
  models: string[];
  seenCount: number;
  registeredAt?: string | null;
  source?: string;
}

export interface Evidence {
  ecosystem: Ecosystem;
  name: string;
  requested?: string;
  /** resolved concrete version, when the package exists */
  version?: string;
  /** true/false when known; null when the registry could not be reached */
  exists: boolean | null;
  registry?: RegistryEvidence;
  weeklyDownloads?: number | null;
  osv?: { malicious: string[]; vulns: string[] };
  atlas?: AtlasEvidence;
  scripts?: ScriptFindings;
  repo?: { referencesPackage: boolean | null; note?: string };
  similarity?: {
    isTop: boolean;
    typosquatOf?: string;
    distance?: number;
    homoglyph?: boolean;
    conflationOf?: [string, string];
  };
  lockfile: {
    present: boolean;
    version?: string;
    /**
     * lockfile hash vs the registry's for the locked version: "verified" (match), "mismatch" (L01),
     * "unchecked" (hashes recorded but the registry could not be compared), absent when the
     * lockfile records no hash.
     */
    integrity?: "verified" | "mismatch" | "unchecked";
    /** human-readable detail for a mismatch */
    integrityDetail?: string;
  };
  /** sources that failed — drive fail-closed behaviour */
  errors: { source: string; message: string; critical: boolean }[];
  /** evaluation time (ISO) so rules stay pure and testable */
  now: string;
}

export function emptyEvidence(ecosystem: Ecosystem, name: string, now: Date = new Date()): Evidence {
  return { ecosystem, name, exists: null, lockfile: { present: false }, errors: [], now: now.toISOString() };
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function ageMs(evidence: Evidence, iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Date.parse(evidence.now) - t;
}

export function humanAge(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} days`;
}
