# PHASES — Ladon

Hacking window: **Sun Nov 8, 7:00 PM PT → Sun Nov 15, 6:00 PM PT**
(Istanbul: **Mon Nov 9, 06:00 → Mon Nov 16, 05:00**).
Rule: after Phase 2 there is always a working end-to-end demo. Each phase ends deployed/committed.

---

## Phase 0 — Kickoff (Nov 8 evening PT, ~3 h)
- [ ] Public repo, pnpm monorepo skeleton, commit these 5 docs.
- [ ] **Buy hardware today:** ESP32-S3 dev board ×2, ST7789 2" display, buttons, LED, USB-C cable.
- [ ] Deploy empty Next.js to DeployXA (Vercel fallback); Supabase project; `/api/health`.
- [ ] Devpost draft created, all tracks ticked.
- [ ] Verdaccio running locally; publish first harmless canary package.

**Exit:** live URL 200; canary installs from local registry.

## Phase 1 — Judge core (Nov 9)
- [ ] Command parser (npm/pnpm/yarn/bun/pip/uv) with tests.
- [ ] Sources: npm registry + downloads, PyPI JSON, OSV; caching layer; recorded fixtures.
- [ ] Rules R01–R08, R12 + scoring + verdict bands.
- [ ] Fixture corpus v1 (benign, canary-malicious, hallucinated names).

**Exit:** `ladon check <pkg>` prints verdict + reasons for real and canary packages.

## Phase 2 — Gate end-to-end (Nov 10)
- [ ] Claude Code `PreToolUse` hook → daemon → verdict → allow / block with reasons in tool output.
- [ ] PATH shims for npm + pip.
- [ ] Hold → **terminal-only temporary approval** (to be replaced by Key/passkey in Phase 4).
- [ ] Record first rough demo clip (insurance).

**Exit:** real agent session blocked from installing a canary. **This is the minimum winning core.**

## Phase 3 — Deep signals + web checker (Nov 11)
- [ ] Script analyzer R09–R11, R15; similarity R04–R05 with top-5k lists; R07, R13, R14.
- [ ] Web `/check` page + `/api/check` + manifest upload.
- [ ] Session scanner (instruction files) + config watcher.
- [ ] Evaluate on corpus → confusion matrix → tune weights.

**Exit:** public checker live; corpus ≥ 90 % bad caught.

## Phase 4 — Ladon Key + passkeys (Nov 9–12, role C parallel)
- [ ] Firmware: keygen, USB CDC protocol, display render, hold-to-approve, counter.
- [ ] `ladon key pair`, daemon signature verification, nonce/expiry checks.
- [ ] WebAuthn approve page + `/api/approvals/*` long-poll.
- [ ] KiCad PCB + Gerbers, enclosure DXF, BOM, photos.

**Exit:** hold → Key shows reasons → press → install proceeds; cancel → agent gets reasons.

## Phase 5 — AI heads (Nov 12)
- [ ] Intent judge with Zod schema, escalate-only, `LADON_AI=off` path tested.
- [ ] Atlas: tables, `/atlas` page, opt-in report endpoint, probe job (small prompt set × 2–3 models).
- [ ] R03 Atlas rule wired in.

**Exit:** poisoned-AGENTS.md scenario flagged as strong drift; Atlas shows real hallucinated names.

## Phase 6 — Design & UX (Nov 13)
- [ ] Terminal output: one-line verdict, reasons, what to do next — readable in 3 s.
- [ ] Key screen layout tested on 3 people; web checker + Atlas polished, accessible (contrast, keyboard,
      shape+word not colour only).
- [ ] Dashboard: recent decisions, blocked attempts.
- [ ] README with diagrams, GIFs, confusion matrix.

**Exit:** a non-developer understands the hold screen in 3 seconds.

## Phase 7 — Story & submit (Nov 14 → submit Saturday night PT)
- [ ] Video ≤ 3 min:
      0:00 hook — "your AI agent just installed malware because a README told it to" (2026 headlines) →
      0:25 problem: slopsquatting + injected instructions + worms →
      0:50 live demo (DOCS/PLAN §7 scenario) →
      1:50 Ladon Key close-up + PCB →
      2:15 how the Judge works + where AI is used (and where it's deliberately not) →
      2:40 Atlas + impact + what's next.
- [ ] Devpost write-up, built-with, **AI disclosure**, credits; all tracks.
- [ ] **Submit Saturday Nov 14 night PT.**

## Phase 8 — Buffer (Nov 15 until 6 PM PT)
- [ ] Re-test live URL + video link in incognito. Freeze deploys 2 h before deadline.

---

### Cut list (drop in this order if behind)
1. Atlas probe job → keep Atlas fed by curated list from published research + opt-in reports
2. Config watcher (guard-the-guards)
3. PyPI deep script analysis → keep PyPI metadata rules only
4. Custom PCB fabrication → keep KiCad design + dev-board prototype
5. Passkey approvals → Key only (or Key only → passkey only if hardware fails)

**Never cut:** Claude Code hook + npm shim, deterministic Judge, canary demo, public checker, video.
