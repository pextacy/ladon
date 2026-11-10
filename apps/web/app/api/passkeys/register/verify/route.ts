import { handle, json, jsonError, rateLimited, readJson } from "@/lib/http";
import { rpConfig } from "@/lib/origin";
import { usablePairCode } from "@/lib/pairing";
import { limiter } from "@/lib/ratelimit";
import { getStore } from "@/lib/store";
import { RegisterVerifyBody } from "@/lib/validate";
import { verifyRegistration } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const limited = rateLimited(limiter("auth"), req.headers);
  if (limited) return limited;
  const body = await readJson(req, RegisterVerifyBody, 64 * 1024);
  if (!body.ok) return body.response;
  const store = getStore();
  const pc = await usablePairCode(store, body.data.code, Date.now());
  if (!pc.ok) return jsonError(pc.status, pc.error);
  if (!pc.pair.challenge) return jsonError(400, "request registration options first");
  const v = await verifyRegistration(rpConfig(req.headers), body.data.response, pc.pair.challenge).catch((e: unknown) => {
    console.warn("[ladon] passkey registration failed:", e instanceof Error ? e.message : e);
    return null;
  });
  if (!v) return jsonError(400, "the passkey could not be verified — make sure you are on the Ladon site itself and try again");
  if (await store.getPasskey(v.credentialId)) return jsonError(409, "this passkey is already paired");
  if (!(await store.consumePairCode(pc.pair.code, new Date().toISOString()))) return jsonError(409, "this pair code was already used");
  await store.addPasskey({
    credentialId: v.credentialId,
    deviceId: pc.pair.deviceId,
    publicKey: v.publicKey,
    counter: v.counter,
    label: body.data.label ?? "Passkey",
    transports: v.transports,
    createdAt: new Date().toISOString(),
  });
  return json({ ok: true, credentialId: v.credentialId });
});
