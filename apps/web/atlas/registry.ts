export type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export interface Existence {
  /** true = on the registry, false = 404, null = could not tell (network / 5xx) */
  exists: boolean | null;
  /** first publish time when known */
  createdAt?: string;
}

const npmUrl = (name: string) => `https://registry.npmjs.org/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
const pypiUrl = (name: string) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;

function firstReleaseTime(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const o = json as Record<string, unknown>;
  const time = o.time as Record<string, unknown> | undefined;
  if (time && typeof time.created === "string") return time.created;
  const releases = o.releases as Record<string, { upload_time_iso_8601?: unknown }[]> | undefined;
  if (releases) {
    const times = Object.values(releases)
      .flat()
      .map((f) => f.upload_time_iso_8601)
      .filter((t): t is string => typeof t === "string")
      .sort();
    return times[0];
  }
  return undefined;
}

/** Does this name exist on its registry right now? Never guesses: errors are `null`. */
export async function checkExists(ecosystem: "npm" | "pypi", name: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<Existence> {
  const url = ecosystem === "npm" ? npmUrl(name) : pypiUrl(name);
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "ladon-atlas-probe" }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return { exists: false };
    if (!res.ok) return { exists: null };
    const json = await res.json().catch(() => null);
    // npm returns 200 for unpublished names with no versions — treat as absent
    if (ecosystem === "npm" && json && typeof json === "object" && !("versions" in json && Object.keys((json as { versions: object }).versions).length > 0)) {
      return { exists: false };
    }
    const createdAt = firstReleaseTime(json);
    return createdAt ? { exists: true, createdAt } : { exists: true };
  } catch {
    return { exists: null };
  }
}
