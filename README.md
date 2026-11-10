# Ladon

**A firewall between AI coding agents and the package registries.**

Coding agents now run `npm install` / `pip install` on their own. Ladon intercepts every install,
scores the package with documented deterministic rules, and holds risky installs until a human
approves on a physical **Ladon Key** or a passkey — an approval the agent cannot fake.

> Built for IceHacks 2026. Work in progress — see [`docs/PHASES.md`](docs/PHASES.md).

## Docs

[`CLAUDE.md`](docs/CLAUDE.md) · [`PRD.md`](docs/PRD.md) · [`PLAN.md`](docs/PLAN.md) · [`DOCS.md`](docs/DOCS.md) · [`PHASES.md`](docs/PHASES.md)

## Layout

```
packages/core   scoring rules, schemas, verdict bands
packages/cli    `ladon` CLI (hook, shims, daemon, key bridge)
apps/web        Next.js: checker, Atlas, approvals, /api/health
demo            local Verdaccio registry + harmless canary packages
firmware        Ladon Key (ESP32-S3)
hardware        KiCad, Gerbers, enclosure, BOM
fixtures        recorded registry responses for offline tests
```

## Quick start

```bash
pnpm install
pnpm --filter @ladon/core build
pnpm test
pnpm dev:web                 # http://localhost:3000, health at /api/health
```

### Demo registry (local only)

Canary packages **never** go to public npm/PyPI. They are published to a loopback Verdaccio, and the
publish script refuses any non-local registry.

```bash
pnpm demo:registry           # terminal 1: Verdaccio on 127.0.0.1:4873
pnpm demo:publish-canaries   # terminal 2
pnpm demo:install-canary     # installs color-fn-utils; its harmless postinstall writes /tmp/ladon-canary-pwned
```

`color-fn-utils` imitates a token-stealer's *shape* (env access + network call) so Ladon has something
real to detect, but it only counts env vars, writes a marker file and pings `127.0.0.1`.

## Credits & AI disclosure

- AI coding assistant: Claude Code (Anthropic) used for scaffolding and implementation, reviewed by the team.
- Libraries: Next.js, React, Tailwind CSS, Zod, Vitest, TypeScript, Verdaccio, pnpm.
- Full list maintained in [`docs/DOCS.md` §10](docs/DOCS.md).
