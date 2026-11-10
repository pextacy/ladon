import { authDevice, handle, json, jsonError, rateLimited } from "@/lib/http";
import { appOrigin } from "@/lib/origin";
import { limiter } from "@/lib/ratelimit";
import { getStore } from "@/lib/store";
import { newPairCode, PAIR_TTL_MS } from "@/lib/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A fresh pair code for an already-registered device (add another passkey). Holding the device token
 * is not enough to add an *approver*: the CLI pins a new passkey only after the human confirms it on
 * /dev/tty (first passkey) or with an existing Key/passkey approval (every later one).
 */
export const POST = handle(async (req: Request) => {
  const limited = rateLimited(limiter("devices"), req.headers);
  if (limited) return limited;
  const auth = await authDevice(req);
  if (!auth.ok) return auth.response;
  const store = getStore();
  const now = new Date();
  for (let i = 0; i < 5; i++) {
    const code = newPairCode();
    if (await store.getPairCode(code)) continue;
    await store.createPairCode({ code, deviceId: auth.device.id, expiresAt: new Date(now.getTime() + PAIR_TTL_MS).toISOString(), usedAt: null, challenge: null, createdAt: now.toISOString() });
    return json({ pairCode: code, pairUrl: `${appOrigin(req.headers)}/pair?code=${code}` });
  }
  return jsonError(503, "could not allocate a pair code — try again");
});
