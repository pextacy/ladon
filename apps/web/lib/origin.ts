/**
 * Public origin of the web app. LADON_WEB_ORIGIN wins (production: https://ladon-one.vercel.app);
 * otherwise derived from the request (localhost works for dev). The WebAuthn RP ID is its hostname.
 */
export function appOrigin(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  const fixed = env.LADON_WEB_ORIGIN?.trim();
  if (fixed) return new URL(fixed).origin;
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost:3000";
  const proto = headers.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https");
  return `${proto.split(",")[0]!.trim()}://${host.split(",")[0]!.trim()}`;
}

export function rpConfig(headers: Headers, env: Record<string, string | undefined> = process.env): { origin: string; rpID: string; rpName: string } {
  const origin = appOrigin(headers, env);
  return { origin, rpID: new URL(origin).hostname, rpName: "Ladon" };
}
