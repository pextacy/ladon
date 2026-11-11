import { authDevice, handle, json } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The daemon pins these passkeys (TOFU) and verifies approval assertions itself. */
export const GET = handle(async (req: Request) => {
  const auth = await authDevice(req);
  if (!auth.ok) return auth.response;
  const store = getStore();
  const [passkeys, keys] = await Promise.all([store.listPasskeys(auth.device.id), store.listDeviceKeys(auth.device.id)]);
  return json({
    deviceId: auth.device.id,
    label: auth.device.label,
    passkeys: passkeys.map((p) => ({ credentialId: p.credentialId, publicKey: p.publicKey, counter: p.counter, label: p.label, createdAt: p.createdAt })),
    // informational (dashboard); the daemon trusts only the Key it pinned itself
    keys: keys.map((k) => ({ publicKey: k.publicKey, fingerprint: k.fingerprint, label: k.label, createdAt: k.createdAt })),
  });
});
