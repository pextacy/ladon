# DOCS — Ladon

Technical reference: scoring rules, similarity, script analysis, intent judge, approval protocol, setup.

## 1. Verdict bands

| Score | Verdict | Behaviour |
|---|---|---|
| 0–29 | **allow** ✓ | Install proceeds silently (logged). |
| 30–59 | **warn** ▲ | Proceeds, reasons printed to agent + user. Can be set to hold. |
| 60–100 | **hold** ■ | Blocked until signed approval (Key or passkey) or timeout → exit 1. |

Hard overrides (always hold, score = 100): OSV `MAL-` advisory match; package does not exist
(install would fail anyway — but we log it to Atlas and tell the agent it hallucinated).

## 2. Rules (`packages/core/rules`)

| ID | Signal | Weight | Notes |
|---|---|---|---|
| R01 `not_found` | name absent from registry | override | report to Atlas |
| R02 `osv_malicious` | OSV `MAL-*` for name/version | override | |
| R03 `atlas_hallucinated` | name in Atlas as hallucinated | +35 | +20 more if `registered_at` < 30 days |
| R04 `typosquat` | Damerau-Levenshtein ≤ 2 to a top-5k package, not itself top-5k | +25 | |
| R05 `conflation` | name = tokens of two popular packages merged (e.g. `react-codeshift`) | +20 | token-set match, §3 |
| R06 `very_new` | first publish < 7 days | +20 | < 72 h → +30 |
| R07 `new_version_spike` | requested version published < 48 h AND maintainers changed vs previous | +30 | worm pattern |
| R08 `install_script` | has preinstall/install/postinstall/prepare or `binding.gyp` (npm), `setup.py` with exec (PyPI sdist) | +15 | base |
| R09 `script_network` | install script touches `http`, `https`, `net`, `fetch`, `curl`, `wget`, DNS | +25 | static |
| R10 `script_env` | install script reads `process.env`, `.npmrc`, `~/.ssh`, cloud cred paths | +25 | |
| R11 `script_obfuscation` | `eval`, `Function(`, long base64/hex blobs, `child_process` with dynamic strings | +20 | |
| R12 `low_downloads` | < 100 weekly downloads AND not in lockfile | +10 | |
| R13 `repo_mismatch` | `repository` missing or points to repo that doesn't reference this package | +10 | |
| R14 `no_provenance` | popular package (> 100k/wk) whose new version lacks provenance that previous had | +25 | |
| R15 `agent_config_write` | package files reference `.claude/`, `.cursor/`, `.vscode/tasks.json`, MCP configs | +30 | Aug 2026 worm pattern |

Score = min(100, Σ weights). Every hit carries a human-readable `detail` string.
Weights are hackathon defaults; tune on the fixture corpus and document changes here.

**Additional signals (implemented):**

| ID | Signal | Weight | Notes |
|---|---|---|---|
| E01 `source_unavailable` | a critical source (registry, OSV, install-script analysis when scripts exist) failed | +60 | fail closed; `failMode: "open"` in `~/.ladon/config.json` disables |
| G01 `non_registry_source` | git URL / tarball URL / local path spec | +35 | can't be verified (CLI gate) |
| G02 `custom_registry` | `--registry` to a non-default, non-loopback registry | +30 | CLI gate |
| G03 `exec` | `npx` / `uvx` / `dlx` — runs immediately | 0 | shown as a reason only |
| AI1 `intent_drift_*` | LLM intent judge (§5) | 0 | strong drift escalates allow→warn, warn→hold; never lowers |

**Established-package discount (tuned on the corpus):** when a package has ≥ 100k weekly downloads, was
first published ≥ 180 days ago and the requested version is ≥ 7 days old, R08–R11 and R13 are shown but
not counted. Popular packages such as esbuild, sharp and prisma legitimately download binaries at install;
for them the real risk is a hijacked *new* version, which R07, R14, R15 and OSV still catch. Without this
discount esbuild scored 95 (hold). Results: `docs/EVAL.md`.

## 3. Name similarity

- **Top list:** top 5,000 npm + top 5,000 PyPI by downloads (snapshot in `/fixtures/top-*.json`).
- **Normalize:** lowercase, PyPI PEP 503 normalization (`[-_.]+` → `-`), strip scope for comparison.
- **Typosquat:** Damerau-Levenshtein ≤ 2 (≤ 1 if length < 6), plus homoglyph map (`l/1/i`, `o/0`, `rn/m`).
- **Conflation:** split on `-`/`_`/camelCase into tokens; flag if the token set ⊆ union of tokens of two top
  packages and the name itself isn't top-5k. (Research: ~38 % of hallucinations are conflations.)

## 4. Install-script static analysis

npm: download tarball metadata only (`dist.tarball`) into memory, read `package.json` scripts and the files
those scripts invoke (max 2 MB, max depth 2). PyPI: inspect `setup.py` in sdist / skip wheels with no hooks.
Use regex + a JS tokenizer (`acorn`) for JS; plain regex for Python. **Never execute anything.**

## 5. Intent judge (LLM)

Input (JSON, no secrets, no source code):
```json
{ "userRequest": "make the navbar sticky",
  "recentAgentSteps": ["read src/Navbar.tsx", "read AGENTS.md"],
  "install": { "eco": "npm", "name": "color-fn-utils", "version": "1.0.2" },
  "packageSummary": "README first 400 chars",
  "ruleHits": ["very_new", "script_env"] }
```
Output (Zod):
```json
{ "drift": "none|weak|strong", "reason": "≤ 160 chars", "suspectedSource": "user|instruction_file|tool_output|unknown" }
```
Rules: drift can raise `warn → hold` (strong) but can **never lower** a score. Temperature 0. One retry on
schema failure, then ignore. Claude Code hook input provides `transcript_path`; we read the last user turn.
Codex hook input also provides `transcript_path` (rollout JSONL; `parseCodexTranscript`, skipping injected
`AGENTS.md` / `<environment_context>` turns). Cursor has no transcript: its `beforeSubmitPrompt` hook stores the
last 5 prompts + shell steps per `conversation_id` in `~/.ladon/sessions/<id>.json` (0600, pruned after 24 h,
never uploaded) and `beforeShellExecution` passes them to the gate as `userRequest` / `recentAgentSteps`.

## 6. Approval protocol

Request (daemon → Key over USB CDC, newline-delimited JSON):
```json
{"t":"req","id":"a1b2","pkg":"npm:color-fn-utils@1.0.2","score":85,
 "why":["2 days old","postinstall reads env + network","task mismatch"],
 "h":"sha256(command)","n":"<nonce>","exp":1763139600}
```
Key → daemon:
```json
{"t":"res","id":"a1b2","ok":true,"ctr":42,"sig":"<ed25519 over id|h|n|exp|ok|ctr>"}
```
Daemon verifies with the paired public key, checks `exp`, nonce unused, `ctr` > last. Web/passkey path is
equivalent: WebAuthn assertion over the same challenge (`id|h|n|exp`).
**Threat model note:** protects against a hijacked *agent*. A fully compromised OS user account can tamper
with the daemon itself — document this honestly; out of scope for the week.

## 7. Session scanner

Scans instruction files in cwd → repo root → home: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`,
`.cursor/rules/*`, `.github/copilot-instructions.md`, `.clinerules`. Flags:
install/curl/pipe-to-shell imperatives, zero-width / bidi Unicode, base64 > 80 chars, HTML comments with
instructions, files untracked by git or modified < 24 h with no commit. Output shown at session start.
Agents without a session-start hook (Cursor, Codex, anything via the PATH shims): the first gated install in a
directory per 24 h runs the same scan and prepends medium/high findings to the human display and the agent text
(state: `~/.ladon/scanned.json`).

## 8. Atlas probe job

Nightly (Supabase cron or GitHub Action): ~200 fixed coding prompts × N models → extract imported/installed
names → check registry existence → upsert `atlas_names`. Daily: re-check unregistered names; if newly
registered → flag `registered_at` → R03 bonus kicks in. Cost-capped; prompts versioned in `/apps/web/atlas/prompts`.

**Models and providers.** `LADON_PROBE_MODELS` is a comma list routed by prefix: a bare id
(`claude-opus-5-5`) goes to Anthropic (`ANTHROPIC_API_KEY`, SDK structured output);
`openai:<model>` goes to `OPENAI_API_KEY` at `OPENAI_BASE_URL` (default `https://api.openai.com/v1`, any
OpenAI-compatible server works); `openrouter:<vendor>/<model>` goes to `OPENROUTER_API_KEY`. OpenAI-compatible
calls request `response_format: json_schema` (falling back to `json_object` when a server rejects it) and the
answer is validated with the same Zod schema. Models whose provider key is missing are skipped. The Atlas records
the model id without the provider prefix. `LADON_PROBE_MAX_PROMPTS` caps the **total** calls of a run across all
models (split evenly), so adding providers never raises the cost ceiling.

**Alerts.** A name is an *alert* when it was registered after we first saw it hallucinated
(`registered_at > first_seen`; view `atlas_alerts`, migration 0002). Read them at `GET /api/atlas/alerts`
or subscribe to the Atom feed `/atlas/feed.xml`. When `ATLAS_ALERT_WEBHOOK_URL` is set, the re-check POSTs
each newly registered name as JSON `{ text, content, ecosystem, name, registeredAt, models }` (`text` for Slack,
`content` for Discord) with a 5 s timeout; a failing webhook is logged and never fails the run.

## 9. Setup

```bash
pnpm install
cp .env.example .env    # SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY, LADON_AI=on
pnpm build && pnpm test
pnpm eval               # confusion matrix → docs/EVAL.md (needs the demo registry below)
pnpm --filter web dev                       # http://localhost:3000
pnpm --filter @ladon/cli build && node packages/cli/dist/index.js init --shell --passkey
# daemon/intent judge read optional ~/.ladon/env (ANTHROPIC_API_KEY=…, LADON_AI=on)
# Demo registry (local only; no Docker needed)
pnpm demo:registry            # Verdaccio on 127.0.0.1:4873, config in demo/verdaccio/config.yaml
pnpm demo:publish-canaries && pnpm demo:install-canary
# Firmware
cd firmware && pio run -t upload && npx ladon key pair
```

## 10. Credits & AI disclosure

List every library, dataset (top-package lists, OSV), research paper, and AI tool (coding assistants,
LLM APIs) with what it was used for. Required by IceHacks rules.
