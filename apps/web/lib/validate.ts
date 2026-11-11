import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { OUTCOMES } from "./store/types";

/** Request bodies for every route in docs/API.md. Everything external is parsed before use. */

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/, "must be base64url").max(4096);
const label = z.string().trim().min(1).max(80);
const pkgName = z
  .string()
  .trim()
  .min(1, "package name is required")
  .max(214)
  .regex(/^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/, "not a valid npm or PyPI package name");
export const EcosystemParam = z.enum(["npm", "pypi"]);
const reasons = z.array(z.string().max(200)).max(5);

export const CreateDeviceBody = z.object({ label });
/** A Ladon Key's raw Ed25519 public key (from its hello message), registered for the dashboard. */
export const DeviceKeyBody = z.object({
  publicKey: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/, "publicKey must be 64 hex chars (raw Ed25519)"),
  label: label.optional(),
});

export const PairCode = z.string().trim().toUpperCase().regex(/^[A-Z2-9]{8}$/, "pair code is 8 characters A–Z, 2–9");
export const RegisterOptionsBody = z.object({ code: PairCode });

const AuthenticationResponse = z.looseObject({
  id: b64url,
  rawId: b64url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: b64url.max(8192),
    authenticatorData: b64url.max(8192),
    signature: b64url,
    userHandle: b64url.optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});

const RegistrationResponse = z.looseObject({
  id: b64url,
  rawId: b64url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: b64url.max(8192),
    attestationObject: b64url.max(32768),
    transports: z.array(z.string().max(32)).max(10).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});

export const RegisterVerifyBody = z.object({
  code: PairCode,
  response: RegistrationResponse.transform((r) => r as unknown as RegistrationResponseJSON),
  label: label.optional(),
});

export const ApprovalId = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/, "approval id must be 4–64 chars [A-Za-z0-9_-]");

export const CreateApprovalBody = z.object({
  id: ApprovalId,
  commandHash: z.string().regex(/^[0-9a-f]{64}$/, "commandHash must be sha256 hex"),
  nonce: z.string().regex(/^[0-9a-f]{32,64}$/, "nonce must be 32–64 hex chars"),
  exp: z.number().int().positive(),
  ecosystem: EcosystemParam,
  package: pkgName,
  version: z.string().max(100).optional(),
  score: z.number().int().min(0).max(100),
  reasons,
  intent: z.object({ drift: z.enum(["none", "weak", "strong"]), reason: z.string().max(240) }).optional(),
});
export type CreateApprovalBody = z.infer<typeof CreateApprovalBody>;

export const DecisionParam = z.enum(["approve", "reject"]);
export const OptionsBody = z.object({ decision: DecisionParam });
export const DecideBody = z.object({
  decision: DecisionParam,
  response: AuthenticationResponse.transform((r) => r as unknown as AuthenticationResponseJSON),
});
export const SessionVerifyBody = z.object({
  response: AuthenticationResponse.transform((r) => r as unknown as AuthenticationResponseJSON),
});

export const WaitQuery = z.object({ timeout: z.coerce.number().min(0).max(25).default(25) });

export const DecisionBody = z.object({
  ts: z.iso.datetime({ offset: true }),
  ecosystem: EcosystemParam,
  package: pkgName,
  version: z.string().max(100).optional(),
  verdict: z.enum(["allow", "warn", "hold"]),
  score: z.number().int().min(0).max(100),
  reasons,
  outcome: z.enum(OUTCOMES),
  via: z.enum(["key", "passkey"]).nullable().optional(),
  agent: z.string().max(40).regex(/^[A-Za-z0-9._-]+$/, "agent is a short tool name like claude-code").optional(),
});

export const CheckQuery = z.object({
  eco: EcosystemParam.default("npm"),
  name: pkgName,
  v: z.string().trim().max(100).optional(),
});

export const MANIFEST_MAX_BYTES = 200 * 1024;
export const MANIFEST_MAX_DEPS = 60;
/** Same names lib/manifest.ts manifestKind accepts. */
export const MANIFEST_FILENAME = /(^|[\\/])(package\.json|[^\\/]*\.txt|pyproject\.toml|pipfile)$/i;
export const ManifestBody = z.object({
  filename: z.string().trim().min(1).max(200).regex(MANIFEST_FILENAME, "filename must be package.json, requirements.txt (or any .txt), pyproject.toml or Pipfile"),
  content: z.string().max(MANIFEST_MAX_BYTES, "manifest is larger than 200 KB"),
});

export const AtlasQuery = z.object({
  eco: z.union([EcosystemParam, z.literal("")]).optional(),
  q: z.string().max(214).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const AtlasAlertsQuery = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
  eco: z.union([EcosystemParam, z.literal("")]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const AtlasLookupQuery = z.object({ eco: EcosystemParam, name: pkgName });
export const AtlasReportBody = z.object({
  ecosystem: EcosystemParam,
  name: pkgName,
  model: z.string().trim().max(80).regex(/^[A-Za-z0-9._:/@-]+$/, "model is a model id like claude-opus-5-5").optional(),
});

/** First zod issue, as one readable sentence. */
export function zodMessage(e: z.ZodError): string {
  const i = e.issues[0];
  if (!i) return "invalid request";
  const path = i.path.length ? `${i.path.join(".")}: ` : "";
  return `${path}${i.message}`;
}
