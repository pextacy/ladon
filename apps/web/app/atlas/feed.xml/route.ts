import { atomFeed, listAlerts } from "@/lib/atlas-alerts";
import { handle } from "@/lib/http";
import { appOrigin } from "@/lib/origin";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Atom feed of Atlas alerts — the same data as GET /api/atlas/alerts. */
export const GET = handle(async (req: Request) => {
  const alerts = await listAlerts(getStore(), { limit: 100 });
  const xml = atomFeed(alerts, appOrigin(req.headers), new Date().toISOString());
  return new Response(xml, { headers: { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "public, max-age=300" } });
});
