import { handle, json, jsonError, rateLimited, readJson } from "@/lib/http";
import { rpConfig } from "@/lib/origin";
import { limiter } from "@/lib/ratelimit";
import { getStore } from "@/lib/store";
import { RegisterOptionsBody } from "@/lib/validate";
import { registrationOptions } from "@/lib/webauthn";
import { usablePairCode } from "@/lib/pairing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const limited = rateLimited(limiter("auth"), req.headers);
  if (limited) return limited;
  const body = await readJson(req, RegisterOptionsBody, 4096);
  if (!body.ok) return body.response;
  const store = getStore();
  const pc = await usablePairCode(store, body.data.code, Date.now());
  if (!pc.ok) return jsonError(pc.status, pc.error);
  const device = await store.getDevice(pc.pair.deviceId);
  if (!device) return jsonError(404, "the device for this code no longer exists — run `ladon init` again");
  const options = await registrationOptions(rpConfig(req.headers), device, await store.listPasskeys(device.id));
  await store.setPairChallenge(pc.pair.code, options.challenge);
  return json(options);
});
