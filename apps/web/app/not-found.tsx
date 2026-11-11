import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found" };


export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:py-16">
      <p className="font-mono text-sm text-muted">404</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-3 leading-relaxed text-muted">There is nothing at this address. Check a package or browse the Atlas instead.</p>
      <p className="mt-6 flex flex-wrap gap-4">
        <Link href="/check" className="underline">Check a package</Link>
        <Link href="/atlas" className="underline">Hallucination Atlas</Link>
        <Link href="/" className="underline">Home</Link>
      </p>
    </div>
  );
}
