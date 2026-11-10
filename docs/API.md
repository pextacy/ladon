# API contract — daemon ⇄ web

Shared by `packages/cli` (daemon) and `apps/web`. JSON everywhere, validated with Zod on both sides.
Base URL: `LADON_WEB_URL` (default `https://ladon-one.vercel.app`). WebAuthn RP ID = host of that URL.

Auth for daemon calls: `Authorization: Bearer <deviceToken>` (random 32 bytes, base64url; the server
stores only its SHA-256).

## Devices & passkey pairing

| Method | Route | Body / Query | Response |
|---|---|---|---|
| POST | `/api/devices` | `{ label: string }` | `{ deviceId, deviceToken, pairCode, pairUrl }` — pairCode is 8 chars `[A-Z2-9]`, valid 15 min |
| GET | `/pair?code=XXXX` | page | Human registers a passkey for this device |
| POST | `/api/passkeys/register/options` | `{ code }` | WebAuthn `PublicKeyCredentialCreationOptionsJSON` |
| POST | `/api/passkeys/register/verify` | `{ code, response: RegistrationResponseJSON, label? }` | `{ ok: true, credentialId }` |
| POST | `/api/devices/me/pair-code` | Bearer | `{ pairCode, pairUrl }` — add another passkey (CLI still requires human confirmation before pinning) |
| GET | `/api/devices/me` | Bearer | `{ deviceId, label, passkeys: [{ credentialId, publicKey /* base64url COSE */, counter, label, createdAt }] }` |

The daemon **pins** passkeys only during `ladon passkey pair`, and only after the human confirms: the
first passkey by typing `yes` on `/dev/tty`, every later one (and any Key replacement) with an approval from
an already-paired Key or passkey. It verifies every approval assertion itself, so neither a compromised
server nor an agent holding the device token can add an approver or forge an approval.

## Approvals (passkey path)

Challenge for a decision = `passkeyChallenge(req, decision)` from `@ladon/core` (base64url of
`ladon:v1|id|h|n|exp|approve|reject`). The decision is bound into the signed challenge.

| Method | Route | Body / Query | Response |
|---|---|---|---|
| POST | `/api/approvals` | Bearer. `{ id, commandHash, nonce, exp, ecosystem, package, version?, score, reasons: string[≤5], intent?: { drift, reason } }` | `{ id, approveUrl }` |
| GET | `/api/approvals/:id` | — | public view: `{ id, package, version, ecosystem, score, reasons, intent, status, exp, createdAt }` |
| POST | `/api/approvals/:id/options` | `{ decision: "approve" \| "reject" }` | WebAuthn `PublicKeyCredentialRequestOptionsJSON` (challenge as above, allowCredentials = the device's passkeys, userVerification "required") |
| POST | `/api/approvals/:id/decide` | `{ decision, response: AuthenticationResponseJSON }` | `{ ok, status }` — server verifies, stores the raw assertion |
| GET | `/api/approvals/:id/wait?timeout=25` | Bearer (owning device) | long-poll ≤ 25 s: `{ status: "pending" \| "approved" \| "rejected" \| "expired", decision?, assertion?: AuthenticationResponseJSON }` |

Statuses: `pending` → `approved` / `rejected` (by assertion) or `expired` (now > exp).

## Decisions log (dashboard)

| Method | Route | Body | Response |
|---|---|---|---|
| POST | `/api/decisions` | Bearer. `{ ts, ecosystem, package, version?, verdict, score, reasons: string[≤5], outcome: "allowed" \| "warned" \| "approved" \| "rejected" \| "timeout" \| "blocked", via?: "key" \| "passkey" \| null, agent?: string }` | `{ ok }` |
| GET | `/dashboard` | page, passkey sign-in | recent decisions + blocked attempts for devices the passkey belongs to |

Privacy (CLAUDE.md #5): never send source code, prompts, paths, env vars. `agent` is just e.g. `"claude-code"`.

## Public checker & Atlas

| Method | Route | Body / Query | Response |
|---|---|---|---|
| GET | `/api/check?eco=npm&name=x&v=1.2.3` | rate-limited (30/min/IP) | `{ target, version, verdict, score, hits: [{id,name,weight,override,detail,discounted?}], explanation, evidenceSummary, durationMs }` |
| POST | `/api/check/manifest` | `{ filename: "package.json" \| "requirements.txt" \| ..., content }` (≤ 200 KB, ≤ 60 deps) | `{ results: [...same as above], overall }` |
| GET | `/api/atlas?eco=&q=&limit=` | — | `{ entries: [{ ecosystem, name, models, seenCount, firstSeen, registered, registeredAt }], total }` |
| GET | `/api/atlas/lookup?eco=&name=` | — | `{ found: boolean, entry?: { ecosystem, name, models, seenCount, registeredAt, source? } }` (shape = `AtlasEntry` in core) |
| POST | `/api/atlas/report` | opt-in `{ ecosystem, name, model? }` — names only | `{ ok }` |
| GET | `/api/health` | — | `{ status, version, time, checks: { npm, pypi, osv, db } }` |
