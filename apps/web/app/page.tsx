const bands = [
  { word: "ALLOW", shape: "✓", range: "0–29", color: "var(--allow)", text: "Install proceeds. Logged." },
  { word: "WARN", shape: "▲", range: "30–59", color: "var(--warn)", text: "Proceeds. Reasons shown to agent and human." },
  { word: "HOLD", shape: "■", range: "60–100", color: "var(--hold)", text: "Blocked until a human approves on the Ladon Key or a passkey." },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Ladon</h1>
      <p className="mt-3 text-lg" style={{ color: "var(--muted)" }}>
        A firewall between AI coding agents and the package registries. Every install an agent attempts is
        checked. Risky ones wait for a human.
      </p>
      <ul className="mt-10 divide-y border-y" style={{ borderColor: "var(--line)" }}>
        {bands.map((b) => (
          <li key={b.word} className="flex items-baseline gap-4 py-4" style={{ borderColor: "var(--line)" }}>
            <span className="w-24 font-mono font-semibold" style={{ color: b.color }}>
              {b.shape} {b.word}
            </span>
            <span className="w-16 font-mono text-sm" style={{ color: "var(--muted)" }}>{b.range}</span>
            <span>{b.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-10 text-sm" style={{ color: "var(--muted)" }}>
        Package checker and Hallucination Atlas coming this week. Status:{" "}
        <a className="underline" href="/api/health">/api/health</a>
      </p>
    </main>
  );
}
