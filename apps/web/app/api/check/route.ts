import { runCheck } from "@/lib/checker";
import { handle, json, parseQuery, rateLimited } from "@/lib/http";
import { limiter } from "@/lib/ratelimit";
import { CheckQuery } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "access-control-allow-origin": "*" };

export const GET = handle(async (req: Request) => {
  const limited = rateLimited(limiter("check"), req.headers);
  if (limited) return limited;
  const q = parseQuery(new URL(req.url), CheckQuery);
  if (!q.ok) return q.response;
  const result = await runCheck({ ecosystem: q.data.eco, name: q.data.name, ...(q.data.v ? { versionSpec: q.data.v } : {}) });
  return json(result, { headers: CORS });
});
