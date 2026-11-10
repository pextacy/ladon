import { randomUUID } from "node:crypto";
import { handle, json, jsonError, rateLimited, readJson } from "@/lib/http";
import { appOrigin } from "@/lib/origin";
import { limiter } from "@/lib/ratelimit";
import { getStore } from "@/lib/store";
import { newDeviceToken, newPairCode, PAIR_TTL_MS, sha256Hex } from "@/lib/tokens";
import { CreateDeviceBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Daemon registers itself; the human then opens pairUrl on their phone to add a passkey. */
export const POST = handle(async (req: Request) => {
  const limited = rateLimited(limiter("devices"), req.headers);
  if (limited) return limited;
  const body = await readJson(req, CreateDeviceBody, 4096);
  if (!body.ok) return body.response;
  const store = getStore();
  const now = new Date();
  const deviceId = randomUUID();
  const deviceToken = newDeviceToken();
  await store.createDevice({ id: deviceId, label: body.data.label, tokenHash: sha256Hex(deviceToken), createdAt: now.toISOString() });
  let pairCode = "";
  for (let i = 0; i < 5 && !pairCode; i++) {
    const c = newPairCode();
    if (await store.getPairCode(c)) continue;
    await store.createPairCode({ code: c, deviceId, expiresAt: new Date(now.getTime() + PAIR_TTL_MS).toISOString(), usedAt: null, challenge: null, createdAt: now.toISOString() });
    pairCode = c;
  }
  if (!pairCode) return jsonError(503, "could not allocate a pair code — try again");
  const pairUrl = `${appOrigin(req.headers)}/pair?code=${pairCode}`;
  return json({ deviceId, deviceToken, pairCode, pairUrl });
});
