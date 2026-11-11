import { keyFingerprint } from "@ladon/core";
import { authDevice, handle, json, jsonError, rateLimited, readJson } from "@/lib/http";
import { limiter } from "@/lib/ratelimit";
import { getStore } from "@/lib/store";
import { DeviceKeyBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_KEYS_PER_DEVICE = 10;

/**
 * Record the Ladon Key paired with this device so the dashboard can list it. Informational only:
 * the daemon verifies Key signatures against the public key it pinned locally during `ladon key
 * pair`, never against this record — so a stolen device token cannot add an approver.
 */
export const POST = handle(async (req: Request) => {
  const limited = rateLimited(limiter("devices"), req.headers);
  if (limited) return limited;
  const auth = await authDevice(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, DeviceKeyBody, 4096);
  if (!body.ok) return body.response;
  const store = getStore();
  const existing = await store.listDeviceKeys(auth.device.id);
  if (!existing.some((k) => k.publicKey === body.data.publicKey) && existing.length >= MAX_KEYS_PER_DEVICE) {
    return jsonError(409, `this device already has ${MAX_KEYS_PER_DEVICE} Keys registered`);
  }
  const fingerprint = keyFingerprint(body.data.publicKey);
  await store.addDeviceKey({ deviceId: auth.device.id, publicKey: body.data.publicKey, fingerprint, label: body.data.label ?? "Ladon Key", createdAt: new Date().toISOString() });
  return json({ ok: true, fingerprint });
});
