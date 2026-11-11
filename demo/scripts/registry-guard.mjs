// Safety rule (CLAUDE.md #1): canaries may only ever go to a loopback registry.
// WHATWG URL parsing lowercases hosts, strips userinfo (http://127.0.0.1@evil.com → evil.com) and
// normalises IPv4/IPv6 spellings (127.1, [0:0::1]); anything not in this exact set is refused,
// including "localhost." and "localhost.evil.com".
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function demoRegistry(env = process.env) {
  const raw = env.LADON_DEMO_REGISTRY || "http://localhost:4873/";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`LADON_DEMO_REGISTRY is not a URL: ${raw}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK.has(url.hostname)) {
    throw new Error(`Refusing non-local registry ${url.href} — canaries are local-only.`);
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

/**
 * Throws unless a canary package can only resolve to `registry`. Checks what `npm publish --registry`
 * does NOT override: scoped registries (`@scope:registry` from any .npmrc, env or publishConfig apply to
 * scoped names regardless of --registry), and on npm < 9 `publishConfig.registry` beats the CLI flag.
 */
export function assertLocalOnlyPackage(pkg, dir, { existsSync }) {
  if (typeof pkg.name !== "string" || pkg.name.startsWith("@")) {
    throw new Error(`Refusing ${pkg.name}: scoped canaries could be routed by an @scope:registry setting.`);
  }
  for (const [key, value] of Object.entries(pkg.publishConfig ?? {})) {
    if (/registry/i.test(key)) demoRegistry({ LADON_DEMO_REGISTRY: String(value) });
  }
  if (existsSync(`${dir}/.npmrc`)) {
    throw new Error(`Refusing ${pkg.name}: ${dir}/.npmrc could override the publish registry.`);
  }
}
