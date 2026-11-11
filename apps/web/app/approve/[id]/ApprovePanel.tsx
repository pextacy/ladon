"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useEffect, useRef, useState } from "react";
import type { PublicApproval } from "@/lib/approvals";
import { getJson, passkeyErrorMessage, postJson } from "@/lib/client";
import { mmss } from "@/lib/format";

type Decision = "approve" | "reject";
const DRIFT_WORD = { none: "matches the task", weak: "may not match the task", strong: "does not match the task" } as const;

export function ApprovePanel({ initial, serverNow }: { initial: PublicApproval; serverNow: number }) {
  const [a, setA] = useState(initial);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const skew = useRef(serverNow - Math.floor(Date.now() / 1000));
  const [now, setNow] = useState(serverNow);

  // countdown, using the server clock; stops once the request is decided
  useEffect(() => {
    if (a.status !== "pending") return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000) + skew.current), 1000);
    return () => clearInterval(t);
  }, [a.status]);

  // pick up decisions made elsewhere (Ladon Key, another phone)
  useEffect(() => {
    if (a.status !== "pending") return;
    const t = setInterval(async () => {
      try {
        setA(await getJson<PublicApproval>(`/api/approvals/${encodeURIComponent(a.id)}`));
      } catch {
        /* keep the last known state */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [a.id, a.status]);

  const remaining = a.exp - now;
  const status = a.status === "pending" && remaining < 0 ? "expired" : a.status;
  const pkg = `${a.package}${a.version ? `@${a.version}` : ""}`;

  async function decide(decision: Decision) {
    setBusy(decision);
    setError(null);
    try {
      const optionsJSON = await postJson<PublicKeyCredentialRequestOptionsJSON>(`/api/approvals/${encodeURIComponent(a.id)}/options`, { decision });
      const response = await startAuthentication({ optionsJSON });
      const r = await postJson<{ ok: boolean; status: PublicApproval["status"] }>(`/api/approvals/${encodeURIComponent(a.id)}/decide`, { decision, response });
      setA((prev) => ({ ...prev, status: r.status }));
    } catch (e) {
      setError(passkeyErrorMessage(e));
      try {
        setA(await getJson<PublicApproval>(`/api/approvals/${encodeURIComponent(a.id)}`));
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 pt-6 pb-12">
      <section aria-labelledby="req" className="overflow-hidden rounded-xl border-2 border-hold bg-surface">
        <div className="bg-hold-bg px-5 pt-5 pb-4">
          <p className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-4xl font-bold tracking-tight text-hold min-[380px]:text-5xl">
              <span aria-hidden="true">■</span> HOLD
            </span>
            <span className="shrink-0 text-right font-mono">
              <span className="text-3xl font-bold">{a.score}</span>
              <span className="text-muted">/100</span>
            </span>
          </p>
          <h1 id="req" className="mt-3 font-mono text-xl font-semibold break-all">
            <span className="text-muted">{a.ecosystem}:</span>
            {pkg}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {status === "pending" ? "Your coding agent wants to install this. It is blocked until you decide." : "Your coding agent asked to install this. The outcome is below."}
          </p>
        </div>

        <div className="px-5 py-4">
          <ol className="space-y-2.5 text-[17px] leading-snug">
            {a.reasons.slice(0, 3).map((r, i) => (
              <li key={i} className="flex gap-3">
                <span aria-hidden="true" className="font-mono text-hold">{i + 1}</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{r}</span>
              </li>
            ))}
          </ol>
          {a.intent && (
            <p className={`mt-4 border-t border-line pt-3 text-[15px] [overflow-wrap:anywhere] ${a.intent.drift === "strong" ? "font-semibold text-hold" : a.intent.drift === "weak" ? "text-warn" : "text-muted"}`}>
              <span className="font-mono">{a.intent.drift === "none" ? "✓" : a.intent.drift === "weak" ? "▲" : "■"}</span> Install {DRIFT_WORD[a.intent.drift]}
              {a.intent.reason ? `: ${a.intent.reason}` : "."}
            </p>
          )}
        </div>
      </section>

      <div aria-live="polite" className="mt-5">
        {status === "pending" && (
          <>
            <p className="text-center font-mono text-sm text-muted">
              Expires in <span className={`font-bold ${remaining < 30 ? "text-hold" : "text-fg"}`}>{mmss(remaining)}</span> — then it stays blocked
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3">
              <button
                type="button"
                onClick={() => decide("reject")}
                disabled={busy !== null}
                className="min-h-16 rounded-lg bg-fg px-6 text-lg font-semibold text-bg hover:opacity-90 disabled:opacity-50"
              >
                {busy === "reject" ? "Waiting for passkey…" : "Reject"}
              </button>
              <button
                type="button"
                onClick={() => decide("approve")}
                disabled={busy !== null}
                className="min-h-16 rounded-lg border-2 border-hold bg-surface px-6 text-lg font-semibold text-hold hover:bg-hold-bg disabled:opacity-50"
              >
                {busy === "approve" ? "Waiting for passkey…" : "Approve install"}
              </button>
            </div>
            <p className="mt-3 text-center text-sm text-muted">Both choices ask for your passkey (Face ID, fingerprint or PIN). The agent can&apos;t do this for you.</p>
          </>
        )}
        {status === "approved" && <Final tone="allow" mark="✓ APPROVED" text="You approved it. The install continues in your terminal." />}
        {status === "rejected" && <Final tone="hold" mark="■ REJECTED" text="You rejected it. The agent was told why and will not install this package." />}
        {status === "expired" && <Final tone="muted" mark="EXPIRED" text="Nobody answered in time, so the install stayed blocked. If you still want it, ask the agent to try again." />}
        {error && <p className="mt-4 rounded-lg border border-warn bg-warn-bg px-4 py-3">{error}</p>}
      </div>
      <p className="mt-8 text-center font-mono text-xs break-all text-muted">request {a.id}</p>
    </div>
  );
}

function Final({ tone, mark, text }: { tone: "allow" | "hold" | "muted"; mark: string; text: string }) {
  const cls = tone === "allow" ? "border-allow bg-allow-bg text-allow" : tone === "hold" ? "border-hold bg-hold-bg text-hold" : "border-line-strong bg-surface text-muted";
  return (
    <div className={`rounded-lg border-2 px-5 py-4 ${cls}`}>
      <p className="font-mono text-2xl font-bold">{mark}</p>
      <p className="mt-1 text-fg">{text}</p>
    </div>
  );
}
