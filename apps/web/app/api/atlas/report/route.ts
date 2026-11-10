import { atlasName, getDeps } from "@/lib/checker";
import { handle, json, jsonError, rateLimited, readJson } from "@/lib/http";
import { limiter } from "@/lib/ratelimit";
import { getStore } from "@/lib/store";
import { AtlasReportBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Opt-in report of a name an agent tried to install that does not exist. Names + registry + model
 * only. A name is added to the Atlas only if the registry confirms it does not exist right now, so
 * reports cannot be used to smear a real package.
 */
export const POST = handle(async (req: Request) => {
  const limited = rateLimited(limiter("report"), req.headers);
  if (limited) return limited;
  const body = await readJson(req, AtlasReportBody, 2048);
  if (!body.ok) return body.response;
  const { ecosystem, model } = body.data;
  const name = atlasName(ecosystem, body.data.name);
  const store = getStore();
  const now = new Date().toISOString();
  await store.addAtlasReport({ ecosystem, name, model: model ?? null, ts: now });

  const deps = getDeps();
  let exists: boolean;
  try {
    exists = ecosystem === "npm" ? (await deps.npm.packument(name)) !== null : (await deps.pypi.project(name)) !== null;
  } catch {
    return jsonError(503, "the registry could not be reached to confirm the name — the report was logged but not added to the Atlas");
  }
  const known = await store.getAtlasName(ecosystem, name);
  if (known && exists && !known.registered) await store.setAtlasRegistered(ecosystem, name, now, now);
  if (!exists || known) await store.observeAtlasName({ ecosystem, name, model: model ?? null, source: "opt-in report", registered: exists, at: now });
  return json({ ok: true });
});
