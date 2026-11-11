import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { handle, json, jsonError, rateLimited } from "@/lib/http";
import { rpConfig } from "@/lib/origin";
import { limiter } from "@/lib/ratelimit";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_S, cookieOptions, sessionConfigured, sign } from "@/lib/session";
import { nowSeconds } from "@/lib/approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNIN_DISABLED = "dashboard sign-in is disabled: the server has no LADON_SESSION_SECRET configured";

/** Dashboard sign-in: discoverable passkey (empty allowCredentials); challenge kept in a signed cookie. */
export const POST = handle(async (req: Request) => {
  const limited = rateLimited(limiter("auth"), req.headers);
  if (limited) return limited;
  if (!sessionConfigured()) return jsonError(503, SIGNIN_DISABLED);
  const rp = rpConfig(req.headers);
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, allowCredentials: [], userVerification: "required", timeout: 120_000 });
  (await cookies()).set(CHALLENGE_COOKIE, sign({ ch: options.challenge, exp: nowSeconds() + CHALLENGE_TTL_S }, "signin"), cookieOptions(CHALLENGE_TTL_S, rp.origin.startsWith("https:")));
  return json(options);
});
