import { atlasEntryView } from "@/lib/checker";
import { handle, json, parseQuery } from "@/lib/http";
import { getStore } from "@/lib/store";
import { AtlasQuery } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  const q = parseQuery(new URL(req.url), AtlasQuery);
  if (!q.ok) return q.response;
  const { entries, total } = await getStore().searchAtlas({ ...(q.data.eco ? { ecosystem: q.data.eco } : {}), ...(q.data.q ? { q: q.data.q } : {}), limit: q.data.limit });
  return json(
    {
      entries: entries.map((e) => ({ ...atlasEntryView(e), firstSeen: e.firstSeen, registered: e.registered })),
      total,
    },
    { headers: { "access-control-allow-origin": "*" } },
  );
});
