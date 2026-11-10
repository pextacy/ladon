import { newApprovalRecord, nowSeconds, validateExpiry } from "@/lib/approvals";
import { authDevice, handle, json, jsonError, readJson } from "@/lib/http";
import { appOrigin } from "@/lib/origin";
import { getStore } from "@/lib/store";
import { CreateApprovalBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Daemon opens an approval for a held install. Only a passkey assertion can close it as approved. */
export const POST = handle(async (req: Request) => {
  const auth = await authDevice(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, CreateApprovalBody, 16 * 1024);
  if (!body.ok) return body.response;
  const expErr = validateExpiry(body.data.exp, nowSeconds());
  if (expErr) return jsonError(400, expErr);
  const store = getStore();
  const created = await store.createApproval(newApprovalRecord(body.data, auth.device.id, new Date().toISOString()));
  if (created === "exists") return jsonError(409, "an approval with this id already exists");
  return json({ id: body.data.id, approveUrl: `${appOrigin(req.headers)}/approve/${body.data.id}` });
});
