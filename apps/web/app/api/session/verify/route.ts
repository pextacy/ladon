import { cookies } from "next/headers";
import { nowSeconds } from "@/lib/approvals";
import { handle, json, jsonError, rateLimited, readJson } from "@/lib/http";
import { rpConfig } from "@/lib/origin";
import { limiter } from "@/lib/ratelimit";
import { CHALLENGE_COOKIE, cookieOptions, SESSION_COOKIE, SESSION_TTL_S, sessionConfigured, sign, SignInChallenge, unsign } from "@/lib/session";
import { getStore } from "@/lib/store";
import { SessionVerifyBody } from "@/lib/validate";
import { verifyAssertion } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNIN_DISABLED = "dashboard sign-in is disabled: the server has no LADON_SESSION_SECRET configured";

export const POST = handle(async (req: Request) => {
  const limited = rateLimited(limiter("auth"), req.headers);
  if (limited) return limited;
  if (!sessionConfigured()) return jsonError(503, SIGNIN_DISABLED);
  const body = await readJson(req, SessionVerifyBody, 32 * 1024);
  if (!body.ok) return body.response;
  const jar = await cookies();
  const now = nowSeconds();
  const chal = unsign(jar.get(CHALLENGE_COOKIE)?.value, "signin", SignInChallenge, now);
  jar.delete(CHALLENGE_COOKIE);
  if (!chal) return jsonError(400, "sign-in timed out — press the button again");
  const store = getStore();
  const passkey = await store.getPasskey(body.data.response.id);
  if (!passkey) return jsonError(403, "this passkey is not paired with any Ladon device");
  const rp = rpConfig(req.headers);
  const counter = await verifyAssertion(rp, body.data.response, chal.ch, passkey);
  if (counter === null) return jsonError(403, "the passkey signature did not verify");
  await store.updatePasskeyCounter(passkey.credentialId, counter);
  jar.set(SESSION_COOKIE, sign({ d: passkey.deviceId, c: passkey.credentialId, exp: now + SESSION_TTL_S }, "session"), cookieOptions(SESSION_TTL_S, rp.origin.startsWith("https:")));
  return json({ ok: true });
});
