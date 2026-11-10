// Device identity: Ed25519 keypair + monotonic counter, persisted in NVS.
// The private key never leaves this module.
#pragma once
#include <Arduino.h>

namespace keystore {

// Load (or on first boot, generate) the keypair and counter. Returns false on NVS failure.
bool begin();

// 64 lowercase hex chars.
const char* publicKeyHex();

// Last counter value used in a signed response (0 = never signed).
uint32_t counter();

// Increment the counter and persist it to NVS. Writes the new value to *out.
// Returns false if persisting failed; callers must then NOT sign anything.
bool nextCounter(uint32_t* out);

// Ed25519 (RFC 8032, SHA-512) signature over msg. sigHex receives 128 hex chars + NUL.
void signHex(const char* msg, size_t len, char sigHex[129]);

// Boot self-test against RFC 8032 test vector 1 + a sign/verify round trip.
bool selfTest();

}  // namespace keystore
