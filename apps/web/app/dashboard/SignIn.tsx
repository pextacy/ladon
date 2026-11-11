"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { passkeyErrorMessage, postJson } from "@/lib/client";

export function SignIn() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const optionsJSON = await postJson<PublicKeyCredentialRequestOptionsJSON>("/api/session/options", {});
      const response = await startAuthentication({ optionsJSON });
      await postJson("/api/session/verify", { response });
      router.refresh();
    } catch (e) {
      setError(passkeyErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8">
      <button type="button" onClick={signIn} disabled={busy} className="min-h-14 rounded-lg bg-fg px-8 text-lg font-semibold text-bg hover:opacity-90 disabled:opacity-50">
        {busy ? "Waiting for passkey…" : "Sign in with passkey"}
      </button>
      <div aria-live="polite" className="mt-4">{error && <p className="rounded-lg border border-warn bg-warn-bg px-4 py-3">{error}</p>}</div>
    </div>
  );
}

export function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <span className="text-sm">
      <button
        type="button"
        className="underline disabled:opacity-50"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          try {
            const res = await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            router.refresh();
          } catch {
            setFailed(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {failed && <span role="alert" className="ml-2 text-warn">Couldn&apos;t sign out — try again.</span>}
    </span>
  );
}
