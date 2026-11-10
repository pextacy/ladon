import { randomUUID } from "node:crypto";
import { authDevice, handle, json, readJson } from "@/lib/http";
import { getStore } from "@/lib/store";
import { DecisionBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Audit log from the daemon. Names and verdicts only — never code, prompts, paths or env. */
export const POST = handle(async (req: Request) => {
  const auth = await authDevice(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, DecisionBody, 16 * 1024);
  if (!body.ok) return body.response;
  const d = body.data;
  await getStore().addDecision({
    id: randomUUID(),
    deviceId: auth.device.id,
    ts: new Date(d.ts).toISOString(),
    ecosystem: d.ecosystem,
    package: d.package,
    version: d.version ?? null,
    verdict: d.verdict,
    score: d.score,
    reasons: d.reasons,
    outcome: d.outcome,
    via: d.via ?? null,
    agent: d.agent ?? null,
    createdAt: new Date().toISOString(),
  });
  return json({ ok: true });
});
