import { nowSeconds, waitForApproval, waitView } from "@/lib/approvals";
import { authDevice, handle, json, jsonError, parseQuery } from "@/lib/http";
import { getStore } from "@/lib/store";
import { ApprovalId, WaitQuery } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Long-poll (≤ 25 s) for the owning device. */
export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await authDevice(req);
  if (!auth.ok) return auth.response;
  const id = ApprovalId.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "invalid approval id");
  const q = parseQuery(new URL(req.url), WaitQuery);
  if (!q.ok) return q.response;
  const store = getStore();
  const first = await store.getApproval(id.data);
  // same answer for "missing" and "not yours", so ids can't be probed with another device's token
  if (!first || first.deviceId !== auth.device.id) return jsonError(404, "no such approval request for this device");
  const a = await waitForApproval(store, id.data, q.data.timeout * 1000, { signal: req.signal });
  if (!a) return jsonError(404, "no such approval request for this device");
  return json(waitView(a, nowSeconds()));
});
