import type { Ecosystem } from "@ladon/core";
import type { AtlasNameRecord, Store } from "./store/types";

/** One Atlas alert: a name models hallucinated that someone registered afterwards. */
export interface AtlasAlert {
  ecosystem: Ecosystem;
  name: string;
  registeredAt: string;
  firstSeen: string;
  models: string[];
  seenCount: number;
}

export const alertView = (e: AtlasNameRecord): AtlasAlert => ({
  ecosystem: e.ecosystem,
  name: e.name,
  registeredAt: e.registeredAt!,
  firstSeen: e.firstSeen,
  models: e.models,
  seenCount: e.seenCount,
});

export async function listAlerts(store: Store, q: { since?: string; ecosystem?: Ecosystem; limit: number }): Promise<AtlasAlert[]> {
  return (await store.listAtlasAlerts(q)).map(alertView);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const days = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
const eco = (e: Ecosystem) => (e === "pypi" ? "PyPI" : "npm");

export function alertSentence(a: AtlasAlert): string {
  const who = a.models.length ? `hallucinated by ${a.models.join(", ")}` : "a known hallucinated name";
  const gap = days(a.firstSeen, a.registeredAt);
  return `${eco(a.ecosystem)} package "${a.name}" was registered on ${a.registeredAt.slice(0, 10)} — ${who}, first seen ${gap} day${gap === 1 ? "" : "s"} earlier (${a.seenCount}× total). Treat it as a likely slopsquat.`;
}

/** Atom 1.0 feed of Atlas alerts (newest first). */
export function atomFeed(alerts: AtlasAlert[], origin: string, generatedAt: string): string {
  const updated = alerts[0]?.registeredAt ?? generatedAt;
  const entries = alerts.map((a) => {
    const link = `${origin}/check?eco=${a.ecosystem}&name=${encodeURIComponent(a.name)}`;
    const id = `${origin}/atlas#${a.ecosystem}:${encodeURIComponent(a.name)}`;
    return `  <entry>
    <id>${esc(id)}</id>
    <title>${esc(`${eco(a.ecosystem)}: ${a.name} was registered`)}</title>
    <link rel="alternate" href="${esc(link)}"/>
    <updated>${esc(a.registeredAt)}</updated>
    <published>${esc(a.registeredAt)}</published>
    <category term="${a.ecosystem}"/>
    <summary>${esc(alertSentence(a))}</summary>
  </entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${esc(`${origin}/atlas/feed.xml`)}</id>
  <title>Ladon Hallucination Atlas — newly registered names</title>
  <subtitle>Package names AI models invented that someone has since registered.</subtitle>
  <link rel="self" type="application/atom+xml" href="${esc(`${origin}/atlas/feed.xml`)}"/>
  <link rel="alternate" type="text/html" href="${esc(`${origin}/atlas`)}"/>
  <updated>${esc(updated)}</updated>
  <author><name>Ladon</name></author>
${entries.join("\n")}
</feed>
`;
}
