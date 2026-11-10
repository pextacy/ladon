import { canDecide, challengeFor, nowSeconds } from "@/lib/approvals";
import { handle, json, jsonError, rateLimited, readJson } from "@/lib/http";
import { rpConfig } from "@/lib/origin";
import { limiter } from "@/lib/ratelimit";
import { getStore } from "@/lib/store";
import { ApprovalId, OptionsBody } from "@/lib/validate";
import { assertionOptions } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** WebAuthn request options whose challenge binds id|commandHash|nonce|exp|decision. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const limited = rateLimited(limiter("auth"), req.headers);
  if (limited) return limited;
  const id = ApprovalId.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "invalid approval id");
  const body = await readJson(req, OptionsBody, 1024);
  if (!body.ok) return body.response;
  const store = getStore();
  const a = await store.getApproval(id.data);
  if (!a) return jsonError(404, "no such approval request");
  const ok = canDecide(a, nowSeconds());
  if (!ok.ok) return jsonError(ok.status, ok.error);
  const passkeys = await store.listPasskeys(a.deviceId);
  if (passkeys.length === 0) return jsonError(409, "no passkey is paired with the device that asked");
  return json(await assertionOptions(rpConfig(req.headers), challengeFor(a, body.data.decision), passkeys));
});
