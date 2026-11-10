// Safety rule (CLAUDE.md #1): canaries may only ever go to a loopback registry.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function demoRegistry(env = process.env) {
  const raw = env.LADON_DEMO_REGISTRY || "http://localhost:4873/";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`LADON_DEMO_REGISTRY is not a URL: ${raw}`);
  }
  if (!LOOPBACK.has(url.hostname)) {
    throw new Error(`Refusing non-local registry ${url.href} — canaries are local-only.`);
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}
