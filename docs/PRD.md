# PRD — Ladon

**One-liner:** Ladon stops AI coding agents from installing hallucinated, hijacked, or injected packages —
and makes sure only a human, with a physical key, can say yes to a risky install.

## 1. Problem (Nov 2026)

AI agents now write code *and run commands*. The package install step became the soft spot:

- **Hallucinated packages are predictable.** USENIX Security 2025 (Spracklen et al., 576k samples, 16 models):
  ~19.7 % of recommended packages didn't exist; commercial models ~5.2 %, open models ~21.7 %; many
  hallucinated names repeat across runs → attackers pre-register them ("slopsquatting"). A July 2026
  re-evaluation found 127 hallucinated names shared across current frontier models.
- **Agents follow poisoned instructions.** Clinejection (Feb 2026): a prompt injection in a GitHub issue
  title made an AI triage bot run `npm install` on an attacker commit → ~4,000 machines got a rogue package.
  Oct 2026: a malicious `AGENTS.md` in a Downloads folder made coding agents install a known-malicious npm
  package; the researchers report Codex executed it in >90 % of attempts.
- **Worms keep coming.** Shai-Hulud (Sep 2025), Mini Shai-Hulud (Apr–May 2026, TanStack, Mistral AI, 170+
  packages), June 2026 binding.gyp wave, Aug 2026 Keyv-linked wave (400+ packages) that **planted Claude Code
  and VS Code hooks** to persist inside AI tooling.
- Guidance from security agencies and CSA: AI agents should not install packages without **human review or
  an allowlist gate**. In practice nobody has a gate that is (a) fast enough for agent workflows and
  (b) impossible for a hijacked agent to click through.

*(Verify each figure against the source before the write-up; cite links in README.)*

## 2. Users

| Persona | Need |
|---|---|
| **Vibe-coder / student** (primary) | Uses Claude Code/Cursor daily, can't read every `postinstall`. Wants safety without friction. |
| **Indie dev / small team** | Agents in CI; needs a policy + audit log. |
| **Security-curious public** | Checks "is this package name a slopsquat?" on the web; contributes to Atlas. |

## 3. Solution

### Head 1 — Gate (interception)
- **Agent hooks:** Claude Code `PreToolUse` hook for `Bash` (reads command + transcript path), plus
  equivalents for Codex/Cursor where available.
- **Universal shims:** `ladon shim` puts `npm/pnpm/yarn/bun/pip/uv/poetry` wrappers first in `PATH`, so *any*
  agent or human install passes through Ladon.
- **Instruction-file scanner:** on session start, scan `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/
  copilot-instructions.md` etc. in cwd + parents for install directives, hidden Unicode, encoded blobs, and
  files not tracked by git or recently created.
- **Guard-the-guards:** watch agent config files (`.claude/settings*.json`, `.vscode/tasks.json`, MCP configs)
  and alert when new hooks/servers appear (the Aug 2026 worm's persistence trick).

### Head 2 — Judge (scoring)
Deterministic signals → risk score 0–100 → verdict **allow / warn / hold**:
existence, typosquat + conflation similarity to popular packages, package age, download history, maintainer
or repo change, install-script static analysis (network, `env`, `child_process`, base64/eval, binding.gyp),
OSV malicious advisory, provenance presence, Atlas hit (known hallucinated name).

**Intent drift (LLM):** compare the human's last request in the session with the install. "Fix the navbar
CSS" → `npm i function-color --save` = drift. LLM returns `{drift: none|weak|strong, reason}` using only
supplied evidence.

### Head 3 — Key (out-of-band approval)
- **Ladon Key:** ESP32-S3, 2" display, one button, USB-C. Shows package, version, top 3 reasons, risk.
  Press-and-hold 1.5 s → device signs `{requestId, commandHash, nonce, expiry}` with its Ed25519 key.
- **Passkey fallback:** approve on phone via the web app with WebAuthn (biometric).
- Agents cannot produce either signature → a hijacked agent cannot self-approve.

### Head 4 — Atlas (deployed public service)
- Public checker: paste a package name or `package.json`/`requirements.txt` → instant verdict.
- Hallucination Atlas: names AIs hallucinate (from opt-in telemetry + our own nightly probe runs across
  models) × registry status. **Alert when a previously non-existent hallucinated name gets registered.**

## 4. Success metrics (hackathon)

- Canary corpus (≥ 30 benign + ≥ 15 canary-malicious + ≥ 15 hallucinated names): ≥ 90 % of bad caught,
  ≤ 5 % benign held. Show the confusion matrix in the README.
- Cached verdict < 300 ms; full gate→key→approve loop < 10 s.
- End-to-end demo: real Claude Code session + poisoned AGENTS.md + local registry → Ladon holds → Key shows
  reason → human rejects.
- Live URL: checker + Atlas usable without signup.

## 5. Scope

**Must:** Gate (Claude Code hook + npm/pip shims), Judge (deterministic rules + OSV + similarity), Key
(firmware + USB serial approval), web checker, approvals log, canary demo environment.

**Should:** intent drift LLM, instruction-file scanner, passkey approvals, Atlas with registration alerts,
guard-the-guards watcher, custom PCB + enclosure.

**Won't (this week):** sandboxed dynamic execution of packages, IDE extensions, enterprise SSO, Maven/Cargo.

## 6. Track fit

| Track | Case |
|---|---|
| Overall | The most current dev-security problem of 2026, with a working end-to-end system. |
| Best AI Hack | AI defending against AI's own failure modes: intent-drift judge grounded in evidence, nightly multi-model hallucination probing feeding Atlas. Structured outputs, guard tests, works with AI off. |
| Best Hardware Hack | A purpose-built approval key: custom PCB, Ed25519 signing on-device, display, enclosure, documented threat model. Physical presence as the security boundary. |
| Best Design & UX | Security prompts people actually read: one reason line, risk shape + word, 3-second comprehension tested with real users; web checker accessible and clear. |
| Best Deployed App | Public checker + Atlas + API with uptime, caching, docs, health endpoint. |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Too much scope for a week | Strict phases + cut list; Gate + Judge + web checker form a winning core even if Key slips. |
| Hardware delays | Order day 1 (ESP32-S3 dev boards are common locally). Fallback: Key firmware on any ESP32 + serial display; PCB design still submitted. |
| False positives annoy users | `warn` vs `hold` tiers, allowlist, lockfile-pinned packages fast-pathed. |
| Handling malware | Only canary packages on local Verdaccio; OSV/metadata lookups only for real bad packages. |
| LLM mistakes | LLM never sets the base score; drift can only escalate warn→hold, never allow a hold. |

## 8. Name

**Ladon** guarded the golden apples and never slept. Your dependency tree is the garden.
