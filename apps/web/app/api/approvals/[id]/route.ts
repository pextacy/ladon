import { nowSeconds, publicView, refreshStatus } from "@/lib/approvals";
import { handle, json, jsonError } from "@/lib/http";
import { getStore } from "@/lib/store";
import { ApprovalId } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const id = ApprovalId.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "invalid approval id");
  const store = getStore();
  const a = await store.getApproval(id.data);
  if (!a) return jsonError(404, "no such approval request");
  const now = nowSeconds();
  return json(publicView(await refreshStatus(store, a, now), now));
});
