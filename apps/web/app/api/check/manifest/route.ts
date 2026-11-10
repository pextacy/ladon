import { runManifest } from "@/lib/checker";
import { handle, json, jsonError, rateLimited, readJson } from "@/lib/http";
import { parseManifest } from "@/lib/manifest";
import { limiter } from "@/lib/ratelimit";
import { ManifestBody, MANIFEST_MAX_BYTES } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = handle(async (req: Request) => {
  const limited = rateLimited(limiter("manifest"), req.headers);
  if (limited) return limited;
  const body = await readJson(req, ManifestBody, MANIFEST_MAX_BYTES + 4096);
  if (!body.ok) return body.response;
  const m = parseManifest(body.data.filename, body.data.content);
  if (!m.ok) return jsonError(400, m.error);
  const out = await runManifest(m.targets);
  return json({ ...out, kind: m.kind, skipped: m.skipped });
});
