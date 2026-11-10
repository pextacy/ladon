import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { VerdictMark } from "@/app/components/Verdict";
import { effectiveStatus, nowSeconds } from "@/lib/approvals";
import { shortDate } from "@/lib/format";
import { Session, SESSION_COOKIE, unsign } from "@/lib/session";
import { getStore, type ApprovalRecord, type DecisionRecord, type Outcome } from "@/lib/store";
import { SignIn, SignOut } from "./SignIn";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard", robots: { index: false, follow: false } };

const BLOCKED: Outcome[] = ["rejected", "timeout", "blocked"];
const OUTCOME_LABEL: Record<Outcome, string> = {
  allowed: "allowed",
  warned: "allowed with warning",
  approved: "approved by you",
  rejected: "rejected by you",
  timeout: "blocked — no answer",
  blocked: "blocked",
};

function DecisionTable({ rows, caption, empty }: { rows: DecisionRecord[]; caption: string; empty: string }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-muted">
            <th scope="col" className="px-4 py-2.5 font-medium">When</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Package</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Verdict</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Outcome</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Top reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-muted">{empty}</td>
            </tr>
          )}
          {rows.map((d) => (
            <tr key={d.id} className="border-b border-line align-top last:border-b-0">
              <td className="px-4 py-2.5 font-mono whitespace-nowrap text-muted">{shortDate(d.ts)}</td>
              <th scope="row" className="px-4 py-2.5 font-mono font-medium break-all">
                {d.ecosystem}:{d.package}
                {d.version ? `@${d.version}` : ""}
                {d.agent && <span className="block font-sans text-xs font-normal text-muted">via {d.agent}</span>}
              </th>
              <td className="px-4 py-2.5 whitespace-nowrap">
                <VerdictMark verdict={d.verdict} size="sm" /> <span className="font-mono text-muted">{d.score}</span>
              </td>
              <td className="px-4 py-2.5">
                {OUTCOME_LABEL[d.outcome]}
                {d.via ? <span className="text-muted"> ({d.via === "key" ? "Ladon Key" : "passkey"})</span> : null}
              </td>
              <td className="px-4 py-2.5">{d.reasons[0] ?? <span className="text-muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApprovalTable({ rows, now }: { rows: ApprovalRecord[]; now: number }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <caption className="sr-only">Passkey approval requests</caption>
        <thead>
          <tr className="border-b border-line text-muted">
            <th scope="col" className="px-4 py-2.5 font-medium">Requested</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Package</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Score</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-muted">No approval requests yet.</td>
            </tr>
          )}
          {rows.map((a) => {
            const s = effectiveStatus(a, now);
            return (
              <tr key={a.id} className="border-b border-line last:border-b-0">
                <td className="px-4 py-2.5 font-mono whitespace-nowrap text-muted">{shortDate(a.createdAt)}</td>
                <th scope="row" className="px-4 py-2.5 font-mono font-medium break-all">
                  {s === "pending" ? <Link className="underline" href={`/approve/${a.id}`}>{a.ecosystem}:{a.package}</Link> : `${a.ecosystem}:${a.package}`}
                  {a.version ? `@${a.version}` : ""}
                </th>
                <td className="px-4 py-2.5 font-mono">{a.score}</td>
                <td className={`px-4 py-2.5 font-mono ${s === "approved" ? "text-allow" : s === "pending" ? "font-bold text-hold" : "text-muted"}`}>
                  {s === "approved" ? "✓ approved" : s === "rejected" ? "■ rejected" : s === "pending" ? "■ waiting for you" : "expired"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function Dashboard() {
  const jar = await cookies();
  const now = nowSeconds();
  const session = unsign(jar.get(SESSION_COOKIE)?.value, "session", Session, now);

  if (!session) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 sm:py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-3 leading-relaxed text-muted">
          Sign in with the passkey you paired with <code className="font-mono text-fg">ladon init</code> to see what your agents tried to
          install and what you decided. No passkey yet? Run <code className="font-mono text-fg">ladon init</code> and open the pair link.
        </p>
        <SignIn />
      </div>
    );
  }

  const store = getStore();
  const [device, decisions, approvals, passkeys] = await Promise.all([
    store.getDevice(session.d),
    store.listDecisions(session.d, 100),
    store.listApprovals(session.d, 30),
    store.listPasskeys(session.d),
  ]);
  const blocked = decisions.filter((d) => BLOCKED.includes(d.outcome));
  const held = decisions.filter((d) => d.verdict === "hold").length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:py-16">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-muted">
            Device <span className="font-mono text-fg">{device?.label ?? "unknown"}</span> · {passkeys.length} passkey{passkeys.length === 1 ? "" : "s"}
          </p>
        </div>
        <SignOut />
      </div>

      <dl className="mt-8 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line">
        {[
          ["Installs checked", decisions.length],
          ["Held", held],
          ["Blocked", blocked.length],
        ].map(([k, v]) => (
          <div key={k} className="bg-surface px-4 py-4">
            <dt className="text-sm text-muted">{k}</dt>
            <dd className="mt-1 font-mono text-3xl font-bold">{v}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="blocked" className="mt-12">
        <h2 id="blocked" className="text-xl font-semibold">Blocked attempts</h2>
        <p className="mt-1 text-sm text-muted">Installs that did not happen: rejected by you, unanswered, or blocked outright.</p>
        <DecisionTable rows={blocked} caption="Blocked install attempts" empty="Nothing blocked yet." />
      </section>

      <section aria-labelledby="approvals" className="mt-12">
        <h2 id="approvals" className="text-xl font-semibold">Approval requests</h2>
        <ApprovalTable rows={approvals} now={now} />
      </section>

      <section aria-labelledby="recent" className="mt-12">
        <h2 id="recent" className="text-xl font-semibold">Recent decisions</h2>
        <DecisionTable rows={decisions} caption="All recent install decisions" empty="Your daemon hasn't reported any installs yet." />
      </section>
    </div>
  );
}
