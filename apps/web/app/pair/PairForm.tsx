"use client";

import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { useState } from "react";
import { passkeyErrorMessage, postJson } from "@/lib/client";

export function PairForm({ initialCode, problem = null }: { initialCode: string; problem?: string | null }) {
  const [code, setCode] = useState(initialCode);
  const [label, setLabel] = useState("My phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(problem);
  const [done, setDone] = useState(false);
  const valid = /^[A-Z2-9]{8}$/.test(code);

  async function pair(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const optionsJSON = await postJson<PublicKeyCredentialCreationOptionsJSON>("/api/passkeys/register/options", { code });
      const response = await startRegistration({ optionsJSON });
      await postJson("/api/passkeys/register/verify", { code, response, label: label.trim() || "Passkey" });
      setDone(true);
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div aria-live="polite" className="mt-8 rounded-lg border-2 border-allow bg-allow-bg px-5 py-4">
        <p className="font-mono text-2xl font-bold text-allow">✓ PAIRED</p>
        <p className="mt-1">Go back to your terminal — Ladon picks up this passkey within a few seconds and asks you to confirm it there.</p>
      </div>
    );
  }

  return (
    <form onSubmit={pair} className="mt-8 space-y-4">
      <div>
        <label htmlFor="code" className="text-sm font-medium">Pair code</label>
        <input
          id="code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8));
            setError(null);
          }}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          spellCheck={false}
          aria-describedby="code-help"
          className="mt-1 w-full rounded-md border border-line-strong bg-surface px-3 py-3 text-center font-mono text-2xl tracking-[0.3em]"
        />
        <p id="code-help" className="mt-1 text-xs text-muted">8 characters, printed by <code className="font-mono">ladon init</code>. Valid for 15 minutes.</p>
      </div>
      <div>
        <label htmlFor="label" className="text-sm font-medium">Name this passkey</label>
        <input id="label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} className="mt-1 w-full rounded-md border border-line-strong bg-surface px-3 py-2.5" />
      </div>
      <button type="submit" disabled={!valid || busy} className="min-h-14 w-full rounded-lg bg-fg px-6 text-lg font-semibold text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? "Waiting for passkey…" : "Create passkey"}
      </button>
      <div aria-live="polite">{error && <p className="rounded-lg border border-warn bg-warn-bg px-4 py-3">{error}</p>}</div>
    </form>
  );
}
