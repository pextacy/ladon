import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { agoLabel, daysAgo } from "@/lib/format";
import { getStore, type AtlasNameRecord } from "@/lib/store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Hallucination Atlas",
  description: "Package names AI models invent, and whether someone has registered them.",
  alternates: { types: { "application/atom+xml": [{ url: "/atlas/feed.xml", title: "Ladon Atlas — newly registered names" }] } },
};

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const RECENT_DAYS = 30;

function Status({ e }: { e: AtlasNameRecord }) {
  if (!e.registered) {
    return (
      <span className="font-mono text-sm text-muted">
        <span aria-hidden="true">○</span> not registered
      </span>
    );
  }
  const d = daysAgo(e.registeredAt);
  const recent = d !== null && d < RECENT_DAYS;
  return recent ? (
    <span className="inline-flex flex-col font-mono text-sm font-bold text-hold">
      <span>
        <span aria-hidden="true">■</span> registered {agoLabel(e.registeredAt)}
      </span>
      <span className="font-sans text-xs font-normal">Recently registered — likely a slopsquat</span>
    </span>
  ) : (
    <span className="font-mono text-sm text-warn">
      <span aria-hidden="true">▲</span> registered {e.registeredAt ? agoLabel(e.registeredAt) : "(date unknown)"}
    </span>
  );
}

export default async function AtlasPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = (one(sp.q) ?? "").trim().slice(0, 214);
  const ecoRaw = one(sp.eco);
  const eco = ecoRaw === "npm" || ecoRaw === "pypi" ? ecoRaw : undefined;

  let data: { entries: AtlasNameRecord[]; total: number } | null = null;
  try {
    data = await getStore().searchAtlas({ ...(eco ? { ecosystem: eco } : {}), ...(q ? { q } : {}), limit: 200 });
  } catch {
    data = null;
  }
  const recent = data?.entries.filter((e) => e.registered && (daysAgo(e.registeredAt) ?? Infinity) < RECENT_DAYS).length ?? 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:py-16">
      <div className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight">Hallucination Atlas</h1>
        <p className="mt-3 text-lg leading-relaxed text-muted">
          AI models recommend packages that don&apos;t exist, and they invent the same names again and again. Attackers register those
          names and wait for an agent to install them — &ldquo;slopsquatting&rdquo;. The Atlas lists names models have invented and
          whether anyone has registered them since.
        </p>
        <p className="mt-3 text-sm text-muted">
          Get told when a hallucinated name gets registered: <a href="/atlas/feed.xml" className="font-medium text-fg underline">Atom feed of new registrations</a>{" "}
          or <code className="font-mono text-fg">GET /api/atlas/alerts</code>.
        </p>
      </div>

      <Form action="/atlas" className="mt-8 flex flex-wrap items-end gap-3" role="search">
        <div className="min-w-0 flex-1">
          <label htmlFor="q" className="text-sm font-medium">Search names</label>
          <input id="q" name="q" type="search" defaultValue={q} autoComplete="off" spellCheck={false} placeholder="e.g. react-codeshift" className="mt-1 w-full rounded-md border border-line-strong bg-surface px-3 py-2.5 font-mono" />
        </div>
        <div>
          <label htmlFor="eco" className="text-sm font-medium">Registry</label>
          <select id="eco" name="eco" defaultValue={eco ?? ""} className="mt-1 block rounded-md border border-line-strong bg-surface px-3 py-2.5 font-mono">
            <option value="">all</option>
            <option value="npm">npm</option>
            <option value="pypi">PyPI</option>
          </select>
        </div>
        <button type="submit" className="rounded-md bg-fg px-6 py-2.5 font-medium text-bg hover:opacity-90">Search</button>
      </Form>

      <section aria-live="polite" className="mt-8">
        {!data ? (
          <p className="rounded-lg border border-warn bg-warn-bg px-5 py-4">The Atlas database could not be reached. Try again in a minute.</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              {data.total} name{data.total === 1 ? "" : "s"}
              {q ? ` matching “${q}”` : ""}
              {recent > 0 && (
                <>
                  {" "}· <strong className="font-semibold text-hold">{recent} registered in the last {RECENT_DAYS} days</strong>
                </>
              )}
            </p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full min-w-[40rem] border-collapse text-left">
                <caption className="sr-only">Hallucinated package names and their registry status</caption>
                <thead>
                  <tr className="border-b border-line text-sm text-muted">
                    <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Registry</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Invented by</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Seen</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Registered?</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-muted">
                        No names {q ? "match that search" : "yet"}.
                      </td>
                    </tr>
                  )}
                  {data.entries.map((e) => {
                    const hot = e.registered && (daysAgo(e.registeredAt) ?? Infinity) < RECENT_DAYS;
                    return (
                      <tr key={`${e.ecosystem}:${e.name}`} className={`border-b border-line align-top last:border-b-0 ${hot ? "bg-hold-bg" : ""}`}>
                        <th scope="row" className="px-4 py-3 font-mono font-medium break-all">
                          <Link href={`/check?eco=${e.ecosystem}&name=${encodeURIComponent(e.name)}`} className="underline">{e.name}</Link>
                          {e.source && <span className="mt-1 block font-sans text-xs font-normal text-muted">{e.source}</span>}
                        </th>
                        <td className="px-4 py-3 font-mono text-sm">{e.ecosystem === "pypi" ? "PyPI" : "npm"}</td>
                        <td className="px-4 py-3 text-sm">{e.models.length ? e.models.join(", ") : <span className="text-muted">published research</span>}</td>
                        <td className="px-4 py-3 text-right font-mono text-sm">{e.seenCount}×</td>
                        <td className="px-4 py-3"><Status e={e} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted">
              Legend: <span aria-hidden="true">○</span> not registered · <span aria-hidden="true">▲</span> registered · <span aria-hidden="true">■</span> registered in the last {RECENT_DAYS} days. Ladon adds +35 risk to any Atlas name and +20 more when it was registered recently.
            </p>
          </>
        )}
      </section>

      <div className="mt-16 grid gap-10 border-t border-line pt-10 md:grid-cols-2">
        <section aria-labelledby="sources">
          <h2 id="sources" className="text-xl font-semibold">Where the names come from</h2>
          <ul className="mt-3 space-y-3 leading-relaxed text-muted">
            <li>
              <strong className="font-semibold text-fg">Nightly probe.</strong> About 200 fixed coding prompts go to several models every
              night. Every package they name is checked against npm and PyPI; names that don&apos;t exist are added here. Prompts are
              versioned in the repository.
            </li>
            <li>
              <strong className="font-semibold text-fg">Daily re-check.</strong> Unregistered names are checked again each day. When one
              appears on a registry, it is flagged with the date — that is the early warning.
            </li>
            <li>
              <strong className="font-semibold text-fg">Opt-in reports.</strong> Ladon CLI users can report names their agent tried to
              install that didn&apos;t exist. A report is only added after the registry confirms the name is absent.
            </li>
            <li>
              <strong className="font-semibold text-fg">Published research.</strong> A small curated seed of names documented by security
              researchers, each with its source.
            </li>
          </ul>
        </section>
        <section aria-labelledby="report">
          <h2 id="report" className="text-xl font-semibold">Report a name</h2>
          <p className="mt-3 leading-relaxed text-muted">
            Reports carry the package name, the registry and optionally the model name. Never source code, prompts, file paths or
            environment variables.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-md bg-code px-4 py-3 font-mono text-[13px] leading-6">{`curl -X POST ${"https://ladon-one.vercel.app"}/api/atlas/report \\
  -H 'content-type: application/json' \\
  -d '{"ecosystem":"npm","name":"some-made-up-pkg","model":"claude-opus-5-5"}'`}</pre>
          <p className="mt-3 text-sm text-muted">
            Read the data: <code className="font-mono text-fg">GET /api/atlas?eco=npm&amp;q=react</code> or{" "}
            <code className="font-mono text-fg">GET /api/atlas/lookup?eco=npm&amp;name=…</code>.
          </p>
        </section>
      </div>
    </div>
  );
}
