import type { CheckResult } from "@/lib/checker";
import { agoLabel, fmtInt } from "@/lib/format";
import { TONE, VerdictMark } from "./Verdict";

const label = (r: Pick<CheckResult, "target" | "version">) =>
  `${r.target.name}${r.version ? `@${r.version}` : r.target.versionSpec ? `@${r.target.versionSpec}` : ""}`;

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-1.5 last:border-b-0">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 text-right font-mono [overflow-wrap:anywhere]">{v}</dd>
    </div>
  );
}

/** Verdict first (shape + word + score), then the top reasons, then all evidence on demand. */
export function VerdictCard({ r, compact = false, headingLevel = 2 }: { r: CheckResult; compact?: boolean; headingLevel?: 2 | 3 }) {
  const counted = r.hits.filter((h) => !h.discounted);
  const top = counted.slice(0, 3);
  const ev = r.evidenceSummary;
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className={`rounded-lg border bg-surface ${TONE[r.verdict].border}`} aria-label={`Verdict for ${label(r)}`}>
      <div className={`flex flex-wrap items-end justify-between gap-4 rounded-t-lg px-5 pt-5 pb-4 ${compact ? "" : "sm:px-7 sm:pt-7"} ${TONE[r.verdict].bg}`}>
        <div>
          <VerdictMark verdict={r.verdict} size={compact ? "md" : "xl"} />
          <H className="mt-2 font-mono text-base break-all sm:text-lg">
            <span className="text-muted">{r.target.ecosystem === "pypi" ? "pypi:" : "npm:"}</span>
            {label(r)}
          </H>
        </div>
        <p className="text-right">
          <span className={`font-mono font-bold ${compact ? "text-2xl" : "text-4xl"}`}>{r.score}</span>
          <span className="font-mono text-muted">/100</span>
          <span className="block text-xs text-muted">risk score</span>
        </p>
      </div>

      <div className={`px-5 py-4 ${compact ? "" : "sm:px-7 sm:py-6"}`}>
        {top.length > 0 ? (
          <ul className="space-y-2">
            {top.map((h) => (
              <li key={h.id} className="flex gap-3">
                <span aria-hidden="true" className={`mt-[0.15em] font-mono ${TONE[r.verdict].text}`}>•</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{h.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No risk rules fired.</p>
        )}
        {!compact && <p className="mt-5 max-w-prose leading-relaxed text-muted [overflow-wrap:anywhere]">{r.explanation}</p>}

        <details className="mt-5 border-t border-line pt-4">
          <summary className="text-sm font-medium">
            <span className="chev mr-1" aria-hidden="true">›</span>All evidence ({r.hits.length} rule{r.hits.length === 1 ? "" : "s"} fired)
          </summary>
          {r.hits.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[28rem] border-collapse text-left text-sm">
                <caption className="sr-only">Rules that fired, with weights</caption>
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th scope="col" className="py-1.5 pr-3 font-medium">Rule</th>
                    <th scope="col" className="py-1.5 pr-3 font-medium">Finding</th>
                    <th scope="col" className="py-1.5 text-right font-medium">Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {r.hits.map((h) => (
                    <tr key={h.id} className={`border-b border-line align-top ${h.discounted ? "text-muted" : ""}`}>
                      <td className="py-1.5 pr-3 font-mono whitespace-nowrap">
                        {h.id} <span className="text-muted">{h.name}</span>
                      </td>
                      <td className="py-1.5 pr-3 [overflow-wrap:anywhere]">
                        {h.detail}
                        {h.discounted && <span className="block text-xs">Not counted: established package (shown for transparency).</span>}
                      </td>
                      <td className="py-1.5 text-right font-mono whitespace-nowrap">{h.override ? "override" : h.discounted ? "0" : `+${h.weight}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <dl className="mt-4 grid gap-x-8 text-sm sm:grid-cols-2">
            <Fact k="Exists on registry" v={ev.exists === null ? "unknown" : ev.exists ? "yes" : "no"} />
            <Fact k="Weekly downloads" v={fmtInt(ev.weeklyDownloads)} />
            <Fact k="First published" v={ev.firstPublished ? agoLabel(ev.firstPublished) : "—"} />
            <Fact k="This version published" v={ev.versionPublished ? agoLabel(ev.versionPublished) : "—"} />
            <Fact k="Latest version" v={ev.latest ?? "—"} />
            <Fact k="Maintainers" v={ev.maintainers ?? "—"} />
            <Fact k="Install scripts" v={ev.installScripts.length ? ev.installScripts.join(", ") : ev.exists ? "none" : "—"} />
            <Fact k="OSV advisories" v={ev.osv ? `${ev.osv.malicious.length} malicious · ${ev.osv.vulns.length} other` : "—"} />
            <Fact k="In Hallucination Atlas" v={ev.atlas ? `yes${ev.atlas.models.length ? ` · ${ev.atlas.models.length} model${ev.atlas.models.length === 1 ? "" : "s"}` : ""}` : "no"} />
            <Fact k="Checked in" v={`${r.durationMs} ms${r.cached ? " (cached)" : ""}`} />
          </dl>
          {ev.sourceErrors.length > 0 && (
            <p className="mt-3 text-sm text-warn [overflow-wrap:anywhere]">
              Sources that failed: {ev.sourceErrors.map((e) => `${e.source}${e.critical ? " (critical — failing closed)" : ""}`).join(", ")}
            </p>
          )}
          <p className="mt-3 text-xs text-muted">Explanation written by {r.explanationSource === "ai" ? "an AI model from the evidence above" : "Ladon's rules (AI off)"}.</p>
        </details>
      </div>
    </article>
  );
}
