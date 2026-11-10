import { authDevice, handle, json } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The daemon pins these passkeys (TOFU) and verifies approval assertions itself. */
export const GET = handle(async (req: Request) => {
  const auth = await authDevice(req);
  if (!auth.ok) return auth.response;
  const passkeys = await getStore().listPasskeys(auth.device.id);
  return json({
    deviceId: auth.device.id,
    label: auth.device.label,
    passkeys: passkeys.map((p) => ({ credentialId: p.credentialId, publicKey: p.publicKey, counter: p.counter, label: p.label, createdAt: p.createdAt })),
  });
});
