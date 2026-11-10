import { seedAtlas } from "@ladon/core";
import { atlasEntryView, atlasName } from "@/lib/checker";
import { handle, json, parseQuery } from "@/lib/http";
import { getStore } from "@/lib/store";
import { AtlasLookupQuery } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Used by core's atlasSource (the CLI) — response shape is core's AtlasEntry. */
export const GET = handle(async (req: Request) => {
  const q = parseQuery(new URL(req.url), AtlasLookupQuery);
  if (!q.ok) return q.response;
  const name = atlasName(q.data.eco, q.data.name);
  const e = await getStore().getAtlasName(q.data.eco, name);
  if (e) return json({ found: true, entry: atlasEntryView(e) });
  const seed = seedAtlas().get(`${q.data.eco}:${name}`);
  if (seed) return json({ found: true, entry: seed });
  return json({ found: false });
});
