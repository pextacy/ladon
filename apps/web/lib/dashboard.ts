import type { Session } from "./session";
import type { Store } from "./store/types";

/**
 * Everything the dashboard shows, scoped to the device the signed-in passkey belongs to. The passkey
 * must still exist and still belong to that device; otherwise the session is treated as signed out.
 */
export async function loadDashboard(store: Store, session: Session) {
  const passkey = await store.getPasskey(session.c);
  if (!passkey || passkey.deviceId !== session.d) return null;
  const [device, decisions, approvals, passkeys, keys] = await Promise.all([
    store.getDevice(session.d),
    store.listDecisions(session.d, 100),
    store.listApprovals(session.d, 30),
    store.listPasskeys(session.d),
    store.listDeviceKeys(session.d),
  ]);
  return { device, decisions, approvals, passkeys, keys };
}
