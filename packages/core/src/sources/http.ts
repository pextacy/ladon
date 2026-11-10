import type { z } from "zod";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface HttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
}

export const DEFAULT_UA = "ladon/0.1 (+https://github.com/pextacy/ladon)";

/** GET/POST JSON, validate with Zod. 404 → null. Network / schema problems → SourceError. */
export async function fetchJson<T>(
  source: string,
  url: string,
  schema: z.ZodType<T>,
  opts: HttpOptions & { init?: RequestInit } = {},
): Promise<T | null> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      ...opts.init,
      headers: { accept: "application/json", "user-agent": opts.userAgent ?? DEFAULT_UA, ...(opts.init?.headers ?? {}) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
  } catch (e) {
    throw new SourceError(source, `cannot reach ${new URL(url).host} (${e instanceof Error ? e.name : "error"})`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new SourceError(source, `${new URL(url).host} answered HTTP ${res.status}`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SourceError(source, `${new URL(url).host} returned invalid JSON`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SourceError(source, `${new URL(url).host} returned unexpected data`);
  return parsed.data;
}

/** Download bytes with a hard size cap. */
export async function fetchBytes(source: string, url: string, maxBytes: number, opts: HttpOptions = {}): Promise<Uint8Array | null> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, { headers: { "user-agent": opts.userAgent ?? DEFAULT_UA }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10000) });
  } catch (e) {
    throw new SourceError(source, `cannot download from ${new URL(url).host} (${e instanceof Error ? e.name : "error"})`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new SourceError(source, `download HTTP ${res.status}`, res.status);
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new SourceError(source, `archive too large (${len} bytes)`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new SourceError(source, `archive too large (${buf.byteLength} bytes)`);
  return buf;
}
