// Host <-> Key wire protocol: newline-delimited JSON over USB CDC (115200 baud).
// See firmware/README.md for the full spec.
#pragma once
#include <Arduino.h>

#include "pins.h"

namespace protocol {

constexpr size_t kIdMax = 64;     // [A-Za-z0-9_-]{1,64}
constexpr size_t kHashLen = 64;   // sha256 hex
constexpr size_t kNonceMax = 128; // hex, 1..128 chars
constexpr size_t kPkgMax = 128;   // display only, truncated
constexpr size_t kWhyMax = 96;    // display only, truncated
constexpr size_t kWhyLines = 3;

struct Request {
  // Signed fields: kept byte-for-byte as received.
  char id[kIdMax + 1];
  char h[kHashLen + 1];
  char n[kNonceMax + 1];
  uint64_t exp;
  // Display-only fields (sanitized to printable ASCII).
  char pkg[kPkgMax + 1];
  int score;
  char why[kWhyLines][kWhyMax + 1];
  uint8_t whyCount;
};

enum class Kind { None, Hello, Req, Cancel, Time };

struct Message {
  Kind kind = Kind::None;
  Request req;          // valid when kind == Req
  char cancelId[kIdMax + 1];  // valid when kind == Cancel
  uint64_t now = 0;     // valid when kind == Time
};

void begin();

// Reads available serial bytes. Returns true and fills *out when a complete,
// valid message arrived. Malformed lines are answered with {"t":"err"} here.
bool poll(Message* out);

void sendHello();
void sendErr(const char* msg, const char* id = nullptr);

// Increments + persists the counter, then signs `${id}|${h}|${n}|${exp}|${ok}|${ctr}`
// and sends {"t":"res",...}. reason (nullable) is appended unsigned.
// Returns false (and sends err) if the counter could not be persisted.
bool sendResult(const Request& req, bool ok, const char* reason);

}  // namespace protocol
