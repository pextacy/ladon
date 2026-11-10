# CLAUDE.md — Ladon

> Instructions for any AI coding assistant working in this repo.
> Read in order: `CLAUDE.md` → `PRD.md` → `PLAN.md` → `DOCS.md` → `PHASES.md`.

## What we are building

**Ladon** (Λάδων) — the sleepless hundred-headed dragon that guarded the golden apples of the
Hesperides — is a **firewall between AI coding agents and the package registries**.

Coding agents (Claude Code, Codex, Cursor, Cline…) now run `npm install` / `pip install` on their own.
In 2025–2026 attackers learned to exploit exactly that:

- **Slopsquatting** — registering package names that LLMs predictably hallucinate.
- **Instruction-file injection** — a poisoned `AGENTS.md` / `CLAUDE.md` / issue title tells the agent to
  install a malicious package (Clinejection, Feb 2026; AGENTS.md-in-Downloads, Oct 2026).
- **Self-propagating npm/PyPI worms** (Shai-Hulud → Mini Shai-Hulud → Aug 2026 wave) that steal tokens
  and even **plant hooks in AI coding tools' config**.

Ladon has four heads:

1. **Gate** — intercepts every install an agent (or human) attempts, via agent hooks + package-manager shims.
2. **Judge** — scores the package (exists? hallucination-shaped name? brand-new? maintainer change?
   install scripts doing network/env access? known-malicious in OSV?) **and checks intent drift**: does
   this install match what the human actually asked the agent to do?
3. **Key** — high-risk installs require **out-of-band human approval** that the agent physically cannot
   fake: a press on the **Ladon Key** (ESP32-S3 + screen + button, signs with its own key) or a WebAuthn
   passkey approval on the web app.
4. **Atlas** — a public, deployed map of package names that AIs hallucinate and whether someone has
   registered them recently (early warning for slopsquats).

## Hackathon context

- IceHacks 2026 (Devpost, online, high-school students). Hacking **Nov 8 7PM PT → Nov 15 6PM PT**.
- All code written during the hacking period. Credit every library/API. **Disclose AI tool usage.**
- Required: public GitHub repo, working demo / live link, ≤ 3 min video, write-up, built-with list.
- We enter **all tracks** (Overall, Best AI Hack, Best Hardware Hack, Best Design & UX, Best Deployed App).
  A project wins at most one, so each track must be credible on its own.
- Judging (equal weight): Technical Execution, Creativity & Originality, Impact & Usefulness, Design & UX,
  Presentation.

## Non-negotiables

1. **Never touch real malware outside an isolated VM, and never publish anything to public npm/PyPI.**
   Demo attacks use a local **Verdaccio** registry and harmless "canary" packages whose payload only writes
   `/tmp/ladon-canary-pwned` and pings `localhost`. This is a safety rule and a judging-credibility rule.
2. **Fail closed, explain always.** If Ladon cannot reach a data source, the install is held (configurable),
   and the user sees exactly why. Every verdict lists its evidence.
3. **Deterministic first, LLM second.** Risk score comes from documented rules (`DOCS.md`). The LLM only
   (a) judges intent drift and (b) writes the one-paragraph explanation — both from structured evidence,
   output validated with Zod. Ladon must work with `LADON_AI=off`.
4. **The agent can never approve its own install.** Approvals need a signature from the Ladon Key or a
   WebAuthn assertion. No "approve" CLI flag an agent could type. Approval tokens bind to the exact
   command hash + nonce + expiry.
5. **Privacy:** Atlas receives only package names + registry + model name (opt-in). Never source code,
   prompts, paths, or env vars.
6. **No slop UI.** No sparkles, no gradients, no chat box. Security prompts must be readable in 3 seconds.

## Stack

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces, TypeScript strict |
| `packages/core` | Analysis engine (pure TS, no I/O in scoring functions) |
| `packages/cli` | `ladon` CLI: hooks, PATH shims, local daemon, USB-serial bridge to Key |
| `apps/web` | Next.js 15 + Tailwind; approvals inbox, public checker, Atlas |
| DB | Supabase Postgres (+ Realtime for approvals) |
| Auth | WebAuthn passkeys (`@simplewebauthn/*`) |
| LLM | Provider-agnostic wrapper in `packages/core/ai` (default Claude via Anthropic API) |
| Data sources | npm registry + downloads API, PyPI JSON API, OSV.dev (incl. `MAL-` advisories) |
| Firmware | PlatformIO, ESP32-S3, Ed25519 (libsodium/monocypher), TFT/e-paper display |
| Hardware | KiCad 2-layer PCB (PCBWay Gerbers) + cut enclosure (SendCutSend DXF) |
| Hosting | DeployXA (sponsor) primary; Vercel fallback |
| Tests | Vitest; a fixture corpus of benign + canary-malicious packages |

## Repo layout

```
/packages/core        scoring rules, name-similarity, script analyzer, intent judge, schemas
/packages/cli         ladon init|check|hook|shim|daemon|key
/apps/web             Next.js: /check, /atlas, /approve, /dashboard, /api/*
/firmware             Ladon Key firmware
/hardware             KiCad, Gerbers, DXF, BOM.csv, photos
/demo                 Verdaccio config, canary packages, poisoned AGENTS.md scenarios
/fixtures             recorded registry responses for offline tests
```

## Conventions

- No `any`. All external data parsed with Zod before use.
- Every rule in `core/rules/*` exports `{ id, weight, evaluate(evidence) → {hit, detail} }` and has tests.
- Network calls only in `core/sources/*`, cached (24 h metadata, 1 h OSV).
- CLI hot path budget: verdict for a cached package < 300 ms, uncached < 2.5 s.
- Commit often with clear messages — history proves work was done during the hackathon.

## When unsure

Prefer the simpler thing that keeps the end-to-end demo working (agent → gate → judge → key → verdict).
Don't add scope beyond `PRD.md`. Check `PHASES.md` for the current phase.
