import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { DeviceRecord, PasskeyRecord } from "./store/types";

export interface Rp {
  origin: string;
  rpID: string;
  rpName: string;
}

const TRANSPORTS = new Set<AuthenticatorTransportFuture>(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const transportsOf = (t: string[]) => t.filter((x): x is AuthenticatorTransportFuture => TRANSPORTS.has(x as AuthenticatorTransportFuture));

/** base64url challenge → the exact bytes, so the options carry it unchanged (no double encoding). */
export const challengeBytes = (b64url: string) => new Uint8Array(Buffer.from(b64url, "base64url"));

export function registrationOptions(rp: Rp, device: DeviceRecord, existing: PasskeyRecord[]): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: `ladon · ${device.label}`,
    userDisplayName: `Ladon approvals for ${device.label}`,
    userID: new Uint8Array(Buffer.from(device.id.replace(/-/g, ""), "hex")),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: transportsOf(p.transports) })),
    // discoverable so /dashboard can sign in without a username; UV so a biometric/PIN is required
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    timeout: 120_000,
  });
}

export async function verifyRegistration(rp: Rp, response: RegistrationResponseJSON, expectedChallenge: string) {
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: true,
  });
  if (!v.verified) return null;
  const c = v.registrationInfo.credential;
  return { credentialId: c.id, publicKey: Buffer.from(c.publicKey).toString("base64url"), counter: c.counter, transports: c.transports ?? [] };
}

export function assertionOptions(rp: Rp, challenge: string, passkeys: PasskeyRecord[]): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    challenge: challengeBytes(challenge),
    allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: transportsOf(p.transports) })),
    userVerification: "required",
    timeout: 120_000,
  });
}

/** Verify an assertion from a known passkey; returns the new counter or null. */
export async function verifyAssertion(rp: Rp, response: AuthenticationResponseJSON, expectedChallenge: string, passkey: PasskeyRecord): Promise<number | null> {
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: { id: passkey.credentialId, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")), counter: passkey.counter, transports: transportsOf(passkey.transports) },
      requireUserVerification: true,
    });
    return v.verified ? v.authenticationInfo.newCounter : null;
  } catch {
    return null;
  }
}
