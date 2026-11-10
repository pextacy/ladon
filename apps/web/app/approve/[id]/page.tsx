import type { Metadata } from "next";
import { nowSeconds, publicView, refreshStatus } from "@/lib/approvals";
import { getStore } from "@/lib/store";
import { ApprovalId } from "@/lib/validate";
import { ApprovePanel } from "./ApprovePanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Approve install", robots: { index: false, follow: false } };

export default async function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const id = ApprovalId.safeParse((await params).id);
  let view = null;
  let failed = false;
  if (id.success) {
    try {
      const store = getStore();
      const a = await store.getApproval(id.data);
      if (a) view = publicView(await refreshStatus(store, a, nowSeconds()), nowSeconds());
    } catch {
      failed = true;
    }
  }
  if (!view) {
    return (
      <div className="mx-auto max-w-md px-4 py-12">
        <h1 className="text-2xl font-semibold">{failed ? "Can't load this request" : "Request not found"}</h1>
        <p className="mt-3 text-muted">
          {failed
            ? "The approvals database is unreachable. The install stays blocked until it can be approved."
            : "This link doesn't match an approval request. Use the link your terminal printed, or check the code with the agent's output."}
        </p>
      </div>
    );
  }
  return <ApprovePanel initial={view} serverNow={nowSeconds()} />;
}
