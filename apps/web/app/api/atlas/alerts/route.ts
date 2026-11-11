import { listAlerts } from "@/lib/atlas-alerts";
import { handle, json, parseQuery } from "@/lib/http";
import { getStore } from "@/lib/store";
import { AtlasAlertsQuery } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Names registered after we first saw them hallucinated, newest first (docs/API.md). */
export const GET = handle(async (req: Request) => {
  const q = parseQuery(new URL(req.url), AtlasAlertsQuery);
  if (!q.ok) return q.response;
  const alerts = await listAlerts(getStore(), { ...(q.data.since ? { since: q.data.since } : {}), ...(q.data.eco ? { ecosystem: q.data.eco } : {}), limit: q.data.limit });
  return json({ alerts, generatedAt: new Date().toISOString() }, { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" } });
});
