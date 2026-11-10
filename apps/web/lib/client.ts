/** Browser-side JSON fetch that surfaces the server's `{ error }` sentence. */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  return readResponse<T>(res);
}

export async function getJson<T>(url: string): Promise<T> {
  return readResponse<T>(await fetch(url, { cache: "no-store", credentials: "same-origin" }));
}

async function readResponse<T>(res: Response): Promise<T> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = typeof data === "object" && data !== null && "error" in data && typeof (data as { error: unknown }).error === "string" ? (data as { error: string }).error : `request failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

/** WebAuthn errors → plain sentences. */
export function passkeyErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out. Nothing was changed.";
    if (e.name === "InvalidStateError") return "This passkey is already registered for this device.";
    if (e.name === "SecurityError") return "Passkeys only work on the Ladon site itself (HTTPS or localhost).";
    return e.message;
  }
  return "Something went wrong. Nothing was changed.";
}
