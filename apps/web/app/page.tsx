import Link from "next/link";
import { SHAPE, TONE, WORD } from "./components/Verdict";

const heads = [
  {
    n: "1",
    name: "Gate",
    text: "Intercepts every install an agent or a human attempts — through Claude Code hooks and npm / pip shims placed first on your PATH.",
  },
  {
    n: "2",
    name: "Judge",
    text: "Scores the package with documented rules: does it exist, is the name hallucination-shaped, is it days old, did the maintainer change, does its install script read your environment or call the network. Then asks whether the install matches what you actually asked for.",
  },
  {
    n: "3",
    name: "Key",
    text: "Risky installs wait for a human. Approve on the Ladon Key — a small device with a screen and one button that signs with its own key — or with a passkey on your phone. The agent cannot produce either signature.",
  },
  {
    n: "4",
    name: "Atlas",
    text: "A public map of package names that AI models invent, and an alert when someone registers one of them.",
  },
] as const;

const bands = [
  { v: "allow", range: "0–29", text: "Install proceeds. Logged." },
  { v: "warn", range: "30–59", text: "Install proceeds. The reasons are shown to the agent and to you." },
  { v: "hold", range: "60–100", text: "Blocked until a human approves on the Ladon Key or a passkey. No approval, no install." },
] as const;

export default function Home() {
  return (
    <div className="mx-auto max-w-5xl px-4">
      <section className="grid gap-10 py-16 sm:py-24 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <div>
          <p className="font-mono text-sm text-muted">npm · PyPI · Claude Code · Codex · Cursor</p>
          <h1 className="mt-4 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            A firewall between AI coding agents and the package registries.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
            Agents now run <code className="font-mono text-fg">npm install</code> on their own. Attackers register the names models
            hallucinate and hide install instructions in README files. Ladon checks every install, explains what it found, and makes
            risky ones wait for you.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/check" className="rounded-md bg-fg px-5 py-3 font-medium text-bg hover:opacity-90">
              Check a package
            </Link>
            <Link href="/atlas" className="rounded-md border border-line-strong px-5 py-3 font-medium hover:bg-surface">
              Browse the Atlas
            </Link>
            <a href="https://github.com/pextacy/ladon" className="rounded-md px-5 py-3 font-medium underline">
              Source on GitHub
            </a>
          </div>
        </div>

        <figure className="rounded-lg border border-line bg-surface">
          <figcaption className="border-b border-line px-4 py-2 font-mono text-xs text-muted">terminal — agent tried to install a package</figcaption>
          <pre className="overflow-x-auto px-4 py-4 font-mono text-[13px] leading-6" aria-label="Example Ladon output">
            <span className="font-bold text-hold">■ HOLD</span>
            {"  npm:color-fn-utils@1.0.2  "}
            <span className="text-muted">risk 85/100</span>
            {"\n  • first published 2 days ago"}
            {"\n  • postinstall reads process.env and opens a network connection"}
            {'\n  • not what you asked for: "make the navbar sticky"'}
            {"\n"}
            <span className="text-muted">{"→ Held. Approve or reject on your Ladon Key.\n  The agent cannot approve this."}</span>
          </pre>
        </figure>
      </section>

      <section aria-labelledby="heads" className="border-t border-line py-14">
        <h2 id="heads" className="text-sm font-semibold uppercase tracking-[0.12em] text-muted">
          Four heads
        </h2>
        <p className="mt-2 max-w-2xl text-muted">
          In Greek myth Ladon was the sleepless dragon that guarded the golden apples of the Hesperides. Your dependency tree is the garden.
        </p>
        <ol className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
          {heads.map((h) => (
            <li key={h.name} className="bg-bg p-6">
              <p className="font-mono text-sm text-muted">{h.n}</p>
              <h3 className="mt-1 text-xl font-semibold">{h.name}</h3>
              <p className="mt-2 leading-relaxed text-muted">{h.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="bands" className="border-t border-line py-14">
        <h2 id="bands" className="text-sm font-semibold uppercase tracking-[0.12em] text-muted">
          Three verdicts
        </h2>
        <p className="mt-2 max-w-2xl text-muted">
          Every verdict has a shape, a word and a colour, so it reads the same in a terminal, on the Key&apos;s screen, on your phone and
          for people who don&apos;t see colour. The score comes from fixed rules; an AI model only writes the explanation and judges
          whether the install fits your task — it can raise a verdict, never lower one.
        </p>
        <table className="mt-8 w-full border-collapse text-left">
          <caption className="sr-only">Verdict bands by risk score</caption>
          <thead>
            <tr className="border-b border-line text-sm text-muted">
              <th scope="col" className="py-2 pr-4 font-medium">Verdict</th>
              <th scope="col" className="py-2 pr-4 font-medium">Score</th>
              <th scope="col" className="py-2 font-medium">What happens</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={b.v} className="border-b border-line align-baseline">
                <th scope="row" className={`py-4 pr-4 font-mono text-lg font-bold ${TONE[b.v].text}`}>
                  <span aria-hidden="true">{SHAPE[b.v]}</span> {WORD[b.v]}
                </th>
                <td className="py-4 pr-4 font-mono text-muted">{b.range}</td>
                <td className="py-4">{b.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 text-sm text-muted">
          Always held at 100: a package that does not exist (the agent hallucinated it) and anything with a known-malicious OSV advisory.
        </p>
      </section>

      <section aria-labelledby="try" className="border-t border-line py-14">
        <h2 id="try" className="text-sm font-semibold uppercase tracking-[0.12em] text-muted">
          Use it
        </h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-3">
          <div>
            <h3 className="font-semibold">
              <Link href="/check" className="underline">Package checker</Link>
            </h3>
            <p className="mt-1 text-muted">Paste a name or a package.json / requirements.txt. No sign-up.</p>
          </div>
          <div>
            <h3 className="font-semibold">
              <Link href="/atlas" className="underline">Hallucination Atlas</Link>
            </h3>
            <p className="mt-1 text-muted">Names models invent, and which ones were registered recently.</p>
          </div>
          <div>
            <h3 className="font-semibold">
              <a href="https://github.com/pextacy/ladon" className="underline">Run the CLI</a>
            </h3>
            <p className="mt-1 text-muted">
              Build it from the repo, then <code className="font-mono text-fg">ladon init</code> adds the hook and shims and pairs a Key
              or passkey.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
