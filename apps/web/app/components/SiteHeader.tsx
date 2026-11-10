import Link from "next/link";

const NAV = [
  { href: "/check", label: "Check" },
  { href: "/atlas", label: "Atlas" },
  { href: "/dashboard", label: "Dashboard" },
];

export function SiteHeader() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="flex items-baseline gap-2 no-underline">
          <span className="text-base font-semibold tracking-tight">Ladon</span>
          <span className="hidden text-sm text-muted sm:inline" lang="el">Λάδων</span>
        </Link>
        <nav aria-label="Main">
          <ul className="flex items-center gap-1 text-sm sm:gap-2">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="rounded px-2 py-1.5 hover:bg-code hover:underline">
                  {n.label}
                </Link>
              </li>
            ))}
            <li>
              <a href="https://github.com/pextacy/ladon" className="rounded px-2 py-1.5 hover:bg-code hover:underline">
                GitHub
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-muted">
        <p>Ladon — a firewall between AI coding agents and the package registries. Built for IceHacks 2026.</p>
        <p className="flex gap-4">
          <a className="underline" href="/api/health">Status</a>
          <a className="underline" href="https://github.com/pextacy/ladon/blob/main/docs/API.md">API</a>
          <a className="underline" href="https://github.com/pextacy/ladon">Source</a>
        </p>
      </div>
    </footer>
  );
}
