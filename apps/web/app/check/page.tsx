import type { Metadata } from "next";
import Form from "next/form";
import { headers } from "next/headers";
import { Suspense } from "react";
import { VerdictCard } from "@/app/components/VerdictCard";
import { runCheck } from "@/lib/checker";
import { exactVersionMissing } from "@/lib/format";
import { clientIp } from "@/lib/http";
import { limiter } from "@/lib/ratelimit";
import { CheckQuery, zodMessage } from "@/lib/validate";
import { ManifestChecker } from "./ManifestChecker";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Check a package", description: "Instant Ladon verdict for an npm or PyPI package." };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Result({ eco, name, v }: { eco: "npm" | "pypi"; name: string; v?: string }) {
  const h = await headers();
  const rl = limiter("check").take(clientIp(h));
  if (!rl.ok) return <Notice tone="warn">Too many checks from your network — try again in {rl.retryAfter} seconds.</Notice>;
  try {
    const r = await runCheck({ ecosystem: eco, name, ...(v ? { versionSpec: v } : {}) });
    const fellBack = r.evidenceSummary.exists === true && exactVersionMissing(eco, v, r.version);
    return (
      <>
        {fellBack && (
          <div className="mb-4">
            <Notice tone="warn">
              Version <code className="font-mono break-all">{v}</code> is not on {eco === "pypi" ? "PyPI" : "npm"}. The verdict below is for{" "}
              <code className="font-mono">{r.version}</code> instead.
            </Notice>
          </div>
        )}
        <VerdictCard r={r} />
      </>
    );
  } catch {
    return <Notice tone="hold">Ladon could not finish this check. When it can&apos;t verify a package, it holds it — treat this one as unverified.</Notice>;
  }
}

function Notice({ tone, children }: { tone: "warn" | "hold"; children: React.ReactNode }) {
  return <p className={`rounded-lg border px-5 py-4 [overflow-wrap:anywhere] ${tone === "hold" ? "border-hold bg-hold-bg" : "border-warn bg-warn-bg"}`}>{children}</p>;
}

export default async function CheckPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const raw = { eco: one(sp.eco) || "npm", name: one(sp.name)?.trim() ?? "", v: one(sp.v)?.trim() || undefined };
  const parsed = raw.name ? CheckQuery.safeParse(raw) : null;
  const eco = raw.eco === "pypi" ? "pypi" : "npm";

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Check a package</h1>
      <p className="mt-2 text-muted">Same rules the Ladon CLI uses before an agent&apos;s install runs. Nothing is installed or executed.</p>

      <Form action="/check" className="mt-8 rounded-lg border border-line bg-surface p-5" aria-describedby="check-help">
        <fieldset>
          <legend className="text-sm font-medium">Registry</legend>
          <div className="mt-2 inline-flex rounded-md border border-line-strong p-0.5" role="presentation">
            {(["npm", "pypi"] as const).map((e) => (
              <label key={e} className="cursor-pointer rounded px-4 py-1.5 font-mono text-sm has-[:checked]:bg-fg has-[:checked]:text-bg has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
                <input type="radio" name="eco" value={e} defaultChecked={eco === e} className="sr-only" />
                {e === "npm" ? "npm" : "PyPI"}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
          <div>
            <label htmlFor="name" className="text-sm font-medium">Package name</label>
            <input
              id="name"
              name="name"
              required
              maxLength={214}
              defaultValue={raw.name}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="e.g. left-pad"
              className="mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2.5 font-mono"
            />
          </div>
          <div>
            <label htmlFor="v" className="text-sm font-medium">Version <span className="font-normal text-muted">(optional)</span></label>
            <input id="v" name="v" maxLength={100} defaultValue={raw.v} autoComplete="off" spellCheck={false} placeholder="latest" className="mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2.5 font-mono" />
          </div>
          <button type="submit" className="rounded-md bg-fg px-6 py-2.5 font-medium text-bg hover:opacity-90">Check</button>
        </div>
        <p id="check-help" className="mt-3 text-xs text-muted">The result has its own link — share it with the URL in your address bar.</p>
      </Form>

      <section aria-live="polite" aria-busy="false" className="mt-8">
        {parsed && !parsed.success && <Notice tone="warn">{zodMessage(parsed.error)}</Notice>}
        {parsed?.success && (
          <Suspense key={`${parsed.data.eco}:${parsed.data.name}@${parsed.data.v ?? ""}`} fallback={<p className="rounded-lg border border-line px-5 py-4 text-muted [overflow-wrap:anywhere]">Checking {parsed.data.name} against the registry, OSV and the Atlas…</p>}>
            <Result eco={parsed.data.eco} name={parsed.data.name} {...(parsed.data.v ? { v: parsed.data.v } : {})} />
          </Suspense>
        )}
      </section>

      <section aria-labelledby="manifest" className="mt-16 border-t border-line pt-10">
        <h2 id="manifest" className="text-xl font-semibold">Check a whole manifest</h2>
        <p className="mt-1 text-muted">Upload or paste a <code className="font-mono text-fg">package.json</code>, <code className="font-mono text-fg">requirements.txt</code>, <code className="font-mono text-fg">pyproject.toml</code> or <code className="font-mono text-fg">Pipfile</code> — up to 60 dependencies, 200 KB. Only names and versions are read.</p>
        <ManifestChecker />
      </section>
    </div>
  );
}
