#include "keystore.h"

#include <Ed25519.h>
#include <Preferences.h>
#include <esp_random.h>
#if __has_include(<bootloader_random.h>)
#include <bootloader_random.h>
#define LADON_HAVE_BOOTLOADER_RANDOM 1
#endif

namespace keystore {
namespace {

constexpr const char* kNamespace = "ladon";
constexpr const char* kKeySk = "sk";
constexpr const char* kKeyCtr = "ctr";

uint8_t sk[32];
uint8_t pk[32];
char pkHex[65];
uint32_t ctr = 0;
Preferences prefs;

void toHex(const uint8_t* in, size_t n, char* out) {
  static const char* digits = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[2 * i] = digits[in[i] >> 4];
    out[2 * i + 1] = digits[in[i] & 0x0f];
  }
  out[2 * n] = '\0';
}

bool fromHex(const char* hex, uint8_t* out, size_t n) {
  for (size_t i = 0; i < n; i++) {
    uint8_t b = 0;
    for (int j = 0; j < 2; j++) {
      char c = hex[2 * i + j];
      b <<= 4;
      if (c >= '0' && c <= '9') b |= c - '0';
      else if (c >= 'a' && c <= 'f') b |= c - 'a' + 10;
      else return false;
    }
    out[i] = b;
  }
  return true;
}

void generateSecret(uint8_t out[32]) {
#ifdef LADON_HAVE_BOOTLOADER_RANDOM
  // Wi-Fi/BT are off, so enable the SAR-ADC entropy source to make the
  // hardware RNG a true RNG while we draw key material (ESP-IDF docs, "Random Number Generation").
  bootloader_random_enable();
#endif
  esp_fill_random(out, 32);
#ifdef LADON_HAVE_BOOTLOADER_RANDOM
  bootloader_random_disable();
#endif
}

}  // namespace

bool begin() {
  if (!prefs.begin(kNamespace, false)) return false;

  bool haveKey = prefs.getBytesLength(kKeySk) == sizeof(sk) &&
                 prefs.getBytes(kKeySk, sk, sizeof(sk)) == sizeof(sk);
  if (!haveKey) {
    generateSecret(sk);
    if (prefs.putBytes(kKeySk, sk, sizeof(sk)) != sizeof(sk)) return false;
    prefs.putUInt(kKeyCtr, 0);
    uint8_t check[32];
    if (prefs.getBytes(kKeySk, check, sizeof(check)) != sizeof(check) ||
        memcmp(check, sk, sizeof(sk)) != 0) {
      return false;
    }
  }
  ctr = prefs.getUInt(kKeyCtr, 0);
  Ed25519::derivePublicKey(pk, sk);
  toHex(pk, sizeof(pk), pkHex);
  return true;
}

const char* publicKeyHex() { return pkHex; }

uint32_t counter() { return ctr; }

bool nextCounter(uint32_t* out) {
  if (ctr == UINT32_MAX) return false;  // exhausted: refuse rather than wrap
  uint32_t next = ctr + 1;
  if (prefs.putUInt(kKeyCtr, next) != sizeof(uint32_t)) return false;
  if (prefs.getUInt(kKeyCtr, 0) != next) return false;  // read back = committed
  ctr = next;
  *out = next;
  return true;
}

void signHex(const char* msg, size_t len, char sigHex[129]) {
  uint8_t sig[64];
  Ed25519::sign(sig, sk, pk, msg, len);
  toHex(sig, sizeof(sig), sigHex);
}

bool selfTest() {
  // RFC 8032 §7.1 TEST 1 (empty message).
  uint8_t tsk[32], tpk[32], expPk[32], expSig[64], sig[64];
  fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", tsk, 32);
  fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", expPk, 32);
  fromHex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555"
          "fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
          expSig, 64);
  Ed25519::derivePublicKey(tpk, tsk);
  if (memcmp(tpk, expPk, 32) != 0) return false;
  Ed25519::sign(sig, tsk, tpk, "", 0);
  if (memcmp(sig, expSig, 64) != 0) return false;

  // Round trip with the device key.
  static const char probe[] = "ladon-selftest";
  Ed25519::sign(sig, sk, pk, probe, sizeof(probe) - 1);
  return Ed25519::verify(sig, pk, probe, sizeof(probe) - 1);
}

}  // namespace keystore
