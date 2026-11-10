const DAY_MS = 86_400_000;

export function daysAgo(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

export function agoLabel(iso: string | null | undefined, now = Date.now()): string {
  const d = daysAgo(iso, now);
  if (d === null) return "unknown";
  if (d === 0) return "today";
  if (d === 1) return "1 day ago";
  if (d < 60) return `${d} days ago`;
  if (d < 730) return `${Math.round(d / 30)} months ago`;
  return `${Math.round(d / 365)} years ago`;
}

export function shortDate(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));

export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
