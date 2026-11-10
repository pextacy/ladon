// A software WebAuthn authenticator (P-256, attestation "none") for end-to-end tests of the passkey
// approval path. Test-only: it lives outside the CLI and is never wired into an approval.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const sha256 = (b) => createHash("sha256").update(b).digest();
const b64u = (b) => Buffer.from(b).toString("base64url");

// --- minimal CBOR encoder (maps, ints, byte/text strings) ---
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
export function cbor(v) {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (typeof v === "object") return cbor(new Map(Object.entries(v)));
  throw new Error("cbor: unsupported");
}

export function createSoftAuthenticator({ origin, rpId }) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = randomBytes(16);
  let counter = 0;
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  const rpHash = sha256(rpId);

  return {
    credentialId: b64u(credId),
    register(options) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
      const ctr = Buffer.alloc(4);
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), ctr, Buffer.alloc(16), len, credId, cose]);
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] } };
    },
    assert(options) {
      counter++;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
      const ctr = Buffer.alloc(4); ctr.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), ctr]);
      const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) } };
    },
  };
}
