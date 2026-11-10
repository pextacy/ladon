import { cookies } from "next/headers";
import { handle, json } from "@/lib/http";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = handle(async () => {
  (await cookies()).delete(SESSION_COOKIE);
  return json({ ok: true });
});
