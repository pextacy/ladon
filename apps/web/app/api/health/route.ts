import { LADON_VERSION } from "@ladon/core";
import { overall, probe, probeStore } from "@/lib/health";
import { getStore, supabaseConfigured } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [npm, pypi, osv, db] = await Promise.all([
    probe("https://registry.npmjs.org/-/ping"),
    probe("https://pypi.org/simple/", { method: "HEAD" }),
    probe("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: { name: "left-pad", ecosystem: "npm" } }),
    }),
    supabaseConfigured() ? probeStore(getStore()) : Promise.resolve({ status: "not_configured" as const, store: "memory" }),
  ]);
  const checks = { npm, pypi, osv, db };
  const status = overall(checks);
  return Response.json(
    { status, version: LADON_VERSION, time: new Date().toISOString(), checks },
    { status: status === "ok" ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
