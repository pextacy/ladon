import { canDecide, challengeFor, nowSeconds } from "@/lib/approvals";
import { handle, json, jsonError, rateLimited, readJson } from "@/lib/http";
import { rpConfig } from "@/lib/origin";
import { limiter } from "@/lib/ratelimit";
import { getStore } from "@/lib/store";
import { ApprovalId, DecideBody } from "@/lib/validate";
import { verifyAssertion } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Both approve and reject require a verified passkey assertion over the decision-bound challenge.
 * The raw assertion is stored so the daemon can verify it against its pinned key.
 */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const limited = rateLimited(limiter("auth"), req.headers);
  if (limited) return limited;
  const id = ApprovalId.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "invalid approval id");
  const body = await readJson(req, DecideBody, 32 * 1024);
  if (!body.ok) return body.response;
  const store = getStore();
  const a = await store.getApproval(id.data);
  if (!a) return jsonError(404, "no such approval request");
  const ok = canDecide(a, nowSeconds());
  if (!ok.ok) return jsonError(ok.status, ok.error);

  const passkey = await store.getPasskey(body.data.response.id);
  if (!passkey || passkey.deviceId !== a.deviceId) return jsonError(403, "this passkey is not paired with the device that asked");
  const counter = await verifyAssertion(rpConfig(req.headers), body.data.response, challengeFor(a, body.data.decision), passkey);
  if (counter === null) return jsonError(403, "the passkey signature did not verify — nothing was changed");

  // re-check expiry after the (slow) biometric step; transition is compare-and-set from pending
  const still = canDecide(a, nowSeconds());
  if (!still.ok) return jsonError(still.status, still.error);
  const status = body.data.decision === "approve" ? "approved" : "rejected";
  const changed = await store.transitionApproval(a.id, {
    status,
    decision: body.data.decision,
    assertion: body.data.response,
    decidedBy: passkey.credentialId,
    decidedAt: new Date().toISOString(),
  });
  if (!changed) {
    const cur = await store.getApproval(a.id);
    return jsonError(409, `this request was already ${cur?.status ?? "closed"}`);
  }
  await store.updatePasskeyCounter(passkey.credentialId, counter);
  return json({ ok: true, status });
});
