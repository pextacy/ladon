# Ladon Key — host-side test vectors

These vectors were produced by the exact Ed25519 code that runs on the Key
(rweather `Crypto` library, `Ed25519::sign`, compiled natively), and then
verified with Node's `crypto.verify`. The signatures are standard RFC 8032
Ed25519 (SHA-512), so the Node built-in verifier accepts them as-is. Ed25519 is
deterministic: the same key + message always gives the same signature.

The firmware also runs RFC 8032 §7.1 TEST 1 at boot and refuses to start if it fails.

## Test key (NOT a real device key)

| | hex |
|---|---|
| private seed | `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` |
| public key (raw, 32 B) | `03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8` |

A real Key reports its raw public key as `pk` in the `hello` reply.

## Vector 1: approve

Request the host sent:

```json
{"t":"req","id":"a1b2","pkg":"npm:color-fn-utils@1.0.2","score":85,"why":["2 days old","postinstall reads env + network","task mismatch"],"h":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","n":"6e6f6e63652d3031","exp":1763139600}
```

(`h` here is `sha256("test")`, used only as a stand-in for a command hash.)

Key response:

```json
{"t":"res","id":"a1b2","ok":true,"ctr":42,"sig":"1f44517372dce4861a9640c1a572f52deb27c981a92b909df590c7108f073bdddabd1c03f6b2563fdebc88c4d0812919af26e5fee9335d3109ff595bc86f6d0e"}
```

Signed message (UTF-8, no trailing newline):

```
a1b2|9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08|6e6f6e63652d3031|1763139600|1|42
```

## Vector 2: timeout (reject)

```json
{"t":"res","id":"a1b2","ok":false,"ctr":43,"sig":"2757272ca14cf0db6171ca70798d5a0cf2517b6e167678dead67c642a40dc2f3f2fa268dd4659354cb2c3dba0c71b23a3372fbb1416d1511339fcb84f072ce0f","reason":"timeout"}
```

Signed message: `a1b2|9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08|6e6f6e63652d3031|1763139600|0|43`

`reason` is **not** part of the signed message.

## Verifying in Node

Node needs the raw 32-byte key wrapped in an SPKI DER header. For Ed25519 the
header is always the same 12 bytes:

```
302a300506032b6570032100
```

(SEQUENCE { SEQUENCE { OID 1.3.101.112 } , BIT STRING (0 unused bits) <32 bytes> })

```js
import crypto from "node:crypto";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyKeyResponse(pkHex, req, res) {
  // Rebuild the message from the REQUEST you sent plus ok/ctr from the response.
  // Never take id/h/n/exp from the response.
  const msg = `${req.id}|${req.h}|${req.n}|${req.exp}|${res.ok ? 1 : 0}|${res.ctr}`;
  const key = crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pkHex, "hex")]),
    format: "der",
    type: "spki",
  });
  return crypto.verify(null, Buffer.from(msg, "utf8"), key, Buffer.from(res.sig, "hex"));
}

const req = {
  id: "a1b2",
  h: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  n: "6e6f6e63652d3031",
  exp: 1763139600,
};
const res = {
  ok: true,
  ctr: 42,
  sig: "1f44517372dce4861a9640c1a572f52deb27c981a92b909df590c7108f073bdddabd1c03f6b2563fdebc88c4d0812919af26e5fee9335d3109ff595bc86f6d0e",
};
console.log(verifyKeyResponse("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8", req, res)); // true
```

Flip `ok` to `false` or change `ctr` and the same signature must fail. Sanity checks
for a test suite: vector 1 verifies `true`, and vector 1's sig over `...|0|42` verifies `false`.

To sign test fixtures in Node with the test seed (gives byte-identical signatures):

```js
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const priv = crypto.createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex")]),
  format: "der",
  type: "pkcs8",
});
crypto.sign(null, Buffer.from(msg), priv).toString("hex");
```
