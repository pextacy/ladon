import type { Verdict } from "@ladon/core";

export const SHAPE: Record<Verdict, string> = { allow: "✓", warn: "▲", hold: "■" };
export const WORD: Record<Verdict, string> = { allow: "ALLOW", warn: "WARN", hold: "HOLD" };
export const TONE: Record<Verdict, { text: string; bg: string; border: string }> = {
  allow: { text: "text-allow", bg: "bg-allow-bg", border: "border-allow" },
  warn: { text: "text-warn", bg: "bg-warn-bg", border: "border-warn" },
  hold: { text: "text-hold", bg: "bg-hold-bg", border: "border-hold" },
};

/** Shape + word + colour: the verdict never relies on colour alone. */
export function VerdictMark({ verdict, size = "md" }: { verdict: Verdict; size?: "sm" | "md" | "xl" }) {
  const cls = size === "xl" ? "text-5xl sm:text-6xl tracking-tight" : size === "md" ? "text-lg" : "text-sm";
  return (
    <span className={`inline-flex items-baseline gap-[0.35em] font-mono font-bold ${TONE[verdict].text} ${cls}`}>
      <span aria-hidden="true">{SHAPE[verdict]}</span>
      <span>{WORD[verdict]}</span>
    </span>
  );
}

export function verdictForScore(score: number): Verdict {
  return score >= 60 ? "hold" : score >= 30 ? "warn" : "allow";
}
