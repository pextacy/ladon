import type { Metadata } from "next";
import { usablePairCode } from "@/lib/pairing";
import { getStore } from "@/lib/store";
import { PairForm } from "./PairForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Pair a passkey", robots: { index: false, follow: false } };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function PairPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const raw = (Array.isArray(sp.code) ? sp.code[0] : sp.code)?.trim().toUpperCase() ?? "";
  const code = raw.replace(/[^A-Z2-9]/g, "").slice(0, 8);
  // Say up front when the link's code can't work, instead of after a passkey prompt.
  let problem: string | null = null;
  if (raw && !/^[A-Z2-9]{8}$/.test(raw)) {
    problem = "The code in this link isn't a valid pair code (8 characters, A–Z and 2–9). Type the code from your terminal.";
  } else if (raw) {
    try {
      const pc = await usablePairCode(getStore(), raw, Date.now());
      if (!pc.ok) problem = `This pair link doesn't work: ${pc.error}.`;
    } catch {
      /* database down: the form reports it when submitted */
    }
  }
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Pair a passkey</h1>
      <p className="mt-3 leading-relaxed text-muted">
        This passkey becomes the only way to approve a held install from this computer. Use the phone or laptop you will have with you
        when your agent is working.
      </p>
      <PairForm initialCode={problem ? "" : code} problem={problem} />
      <section aria-labelledby="how" className="mt-10 border-t border-line pt-6 text-sm leading-relaxed text-muted">
        <h2 id="how" className="font-semibold text-fg">What happens</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Your device creates a passkey for this site. Its private key never leaves the device.</li>
          <li>Ladon stores only the public key and gives it to your daemon, which pins it.</li>
          <li>When an install is held, you approve or reject it with this passkey. Your daemon checks the signature itself.</li>
        </ol>
      </section>
    </div>
  );
}
