import type { ApprovalOutcome, Approver, PendingApproval } from "./types.js";

export * from "./types.js";

/**
 * Ask every ready approver at once (Key + passkey); the first verified decision wins and the
 * others are cancelled. Nothing ready ⇒ "unavailable" (the install stays blocked).
 */
export async function requestApproval(approvers: Approver[], req: PendingApproval, onStatus?: (m: string) => void): Promise<ApprovalOutcome> {
  const ready: Approver[] = [];
  const notes: string[] = [];
  for (const a of approvers) {
    const r = await a.ready();
    if (r.ok) ready.push(a);
    else notes.push(`${a.via}: ${r.detail}`);
  }
  if (ready.length === 0) return { kind: "unavailable", detail: notes.join("; ") || "no approver paired" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(0, req.exp * 1000 - Date.now()));
  try {
    return await new Promise<ApprovalOutcome>((resolve) => {
      let pending = ready.length;
      let last: ApprovalOutcome = { kind: "timeout", detail: "no decision in time" };
      for (const a of ready) {
        a.request(req, ctrl.signal, onStatus)
          .catch((e: unknown): ApprovalOutcome => ({ kind: "unavailable", detail: e instanceof Error ? e.message : String(e) }))
          .then((o) => {
            if (o.kind === "approved" || o.kind === "rejected") return resolve(o);
            last = o;
            if (--pending === 0) resolve(last);
          });
      }
    });
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}
