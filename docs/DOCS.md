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
| R07 `new_version_spike` | requested version published < 48 h AND maintainers changed vs previous | +30 | worm pattern. npm: `maintainers` + `_npmUser`. PyPI (no per-file uploader in the JSON API): author/maintainer e-mails (names if no e-mail) from `/pypi/<name>/<ver>/json` of both versions, plus the PEP 740 Trusted Publisher as publisher; fetched only for versions < 48 h old |
| R08 `install_script` | has preinstall/install/postinstall/prepare or `binding.gyp` (npm), `setup.py` with exec (PyPI sdist), or a pyproject-only sdist whose PEP 517 build runs package code: in-tree backend (`backend-path`), build hooks (`[tool.hatch.*.hooks.custom]` → hatch_build.py, poetry `build` script, pdm_build.py) or a non-standard `build-backend` | +15 | base |
| R09 `script_network` | install script touches `http`, `https`, `net`, `fetch`, `curl`, `wget`, DNS | +25 | static |
| R10 `script_env` | install script reads `process.env`, `.npmrc`, `~/.ssh`, cloud cred paths | +25 | |
| R11 `script_obfuscation` | `eval`, `Function(`, long base64/hex blobs, `child_process` with dynamic strings | +20 | |
| R12 `low_downloads` | < 100 weekly downloads AND not in lockfile | +10 | |
| R13 `repo_mismatch` | `repository` missing or points to repo that doesn't reference this package | +10 | GitHub, GitLab (nested groups), Codeberg and Bitbucket via public raw-file URLs (`package.json` name; `pyproject.toml`/`setup.cfg`/`setup.py` for PyPI). Unreadable/private repos (e.g. a sign-in page) are "not verified", never a mismatch |
| R14 `no_provenance` | popular package (> 100k/wk) whose new version lacks provenance that previous had | +25 | npm: `dist.attestations`. PyPI: PEP 740 `GET /integrity/<project>/<ver>/<file>/provenance` (404 = none) on the sdist (else first wheel) of both versions |
| R15 `agent_config_write` | install-time code references `.claude/`, `.cursor/`, `.vscode/tasks.json`, MCP configs, agent instruction files; **or** any other code file in the npm package *writes* a home-directory AI-tool config (`~/.claude/settings*.json`, `.claude/hooks|commands|agents`, `.claude.json`, `claude_desktop_config.json`, `~/.cursor/mcp.json`, `.vscode/{tasks,settings,mcp}.json`, `mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, Windsurf/Continue/Cline configs) | +30 | Aug 2026 worm pattern; never discounted. Package-wide scan: ≤ 200 code files (`.js/.mjs/.cjs/.ts/.py/.sh/.ps1`, not tests/examples/docs/`.d.ts`), ≤ 2 MB total, same tarball fetch. A path only counts as the destination of a write call (`fs.writeFile*`/`appendFile*`/`createWriteStream`/fs-extra first argument, copy/rename/symlink destination, Python `open(…,"w")`/`write_text`/`shutil.copy`, shell `>`/`tee`/`cp`), with identifiers resolved through their assignments, and only when anchored in the home/app-data directory (`os.homedir()`, `$HOME`, `~/`, `APPDATA`, `Path.home()`…). Docs prose, reads and project-relative scaffolding (e.g. `playwright init-agents`) don't count; agent CLIs writing their own config (`@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`, …) are exempt for that tool's family. Verified quiet on ~1,500 installed packages |

Score = min(100, Σ weights). Every hit carries a human-readable `detail` string.
Weights are hackathon defaults; tune on the fixture corpus and document changes here.

**Additional signals (implemented):**

| ID | Signal | Weight | Notes |
|---|---|---|---|
| E01 `source_unavailable` | a critical source (registry, OSV, install-script analysis when scripts exist) failed | +60 | fail closed; `failMode: "open"` in `~/.ladon/config.json` disables |
| G01 `non_registry_source` | git URL / tarball URL / local path spec | +35 | can't be verified (CLI gate) |
| G02 `custom_registry` | `--registry` to a non-default, non-loopback registry | +30 | CLI gate |
| G03 `exec` | `npx` / `uvx` / `dlx` — runs immediately | 0 | shown as a reason only |
| L01 `lockfile_integrity_mismatch` | the lockfile pins the requested version with a hash (`integrity` / `resolution.integrity` / uv·poetry·pdm `hash` / `--hash`) that the registry does not publish for that version (npm `dist.integrity`/`shasum`, PyPI file `sha256`) | +60 | lockfile or registry tampered; the fast path is skipped and the full check runs |
| AI1 `intent_drift_*` | LLM intent judge (§5) | 0 | strong drift escalates allow→warn, warn→hold; never lowers |

**Lockfile fast path (PLAN §1 step 2).** A requested version that is already pinned in a lockfile
(semver range for npm, PEP 440 specifier for PyPI) is allowed without the full check. When the
lockfile records a hash for that version, the fast path first compares it with the registry's
(one cached packument / project-JSON fetch): match → `evidence.lockfile.integrity = "verified"`;
mismatch → L01 + full check; registry unreachable or no common hash algorithm → `"unchecked"` and
the fast path proceeds as before, without claiming integrity. No hash recorded → no network, no claim.

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
those scripts invoke (max 2 MB, max depth 2). PyPI (only when no wheel exists, so pip must build the sdist): inspect `setup.py`; for pyproject-only
sdists read `[build-system]` — `backend-path` means the backend's code ships in the sdist (its module file
is analysed), hatch/poetry/pdm build hooks are analysed, and a backend outside the well-known list
(setuptools, hatchling, flit_core, poetry-core, pdm-backend, maturin, scikit-build-core, meson-python,
sip, uv_build, …) is reported as non-standard.
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
Rules: drift can raise `warn → hold` (strong) but can **never lower** a score. One retry on
schema failure, then ignore. **No temperature parameter:** the plan called for temperature 0, but
`@anthropic-ai/sdk` 1.x sends API version `2026-10-21`, which rejects `temperature`/`top_p`/`top_k` with
a 400 on every model (and the default `claude-opus-5-5` has no sampling parameters at all). Output is
kept stable by the structured-output schema (enum `drift`/`suspectedSource`, length-capped reason),
`effort: "low"`, and local Zod validation. Claude Code hook input provides `transcript_path`; we read the last user turn.

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

## 8. Atlas probe job

Nightly (Supabase cron or GitHub Action): ~200 fixed coding prompts × N models → extract imported/installed
names → check registry existence → upsert `atlas_names`. Daily: re-check unregistered names; if newly
registered → flag `registered_at` → R03 bonus kicks in. Cost-capped; prompts versioned in `/apps/web/atlas/prompts`.

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
