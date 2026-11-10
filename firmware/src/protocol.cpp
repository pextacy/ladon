#include "protocol.h"

#include <ArduinoJson.h>

#include "keystore.h"

namespace protocol {
namespace {

char lineBuf[MAX_LINE_LEN + 1];
size_t lineLen = 0;
bool overflow = false;

bool isHex(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

bool isIdChar(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
         c == '-' || c == '_';
}

// Copy a field that goes into the signed message. Rejects anything outside the
// allowed alphabet so no '|' or other ambiguity can be smuggled in.
bool copyStrict(const char* src, char* dst, size_t minLen, size_t maxLen, bool (*ok)(char)) {
  if (!src) return false;
  size_t len = strlen(src);
  if (len < minLen || len > maxLen) return false;
  for (size_t i = 0; i < len; i++) {
    if (!ok(src[i])) return false;
  }
  memcpy(dst, src, len + 1);
  return true;
}

// Copy a display string, reducing UTF-8 to printable ASCII ('?' per non-ASCII codepoint).
void copyDisplay(const char* src, char* dst, size_t maxLen) {
  size_t o = 0;
  for (const uint8_t* p = reinterpret_cast<const uint8_t*>(src); *p && o < maxLen; p++) {
    uint8_t c = *p;
    if (c >= 0x20 && c < 0x7f) dst[o++] = static_cast<char>(c);
    else if (c == '\t') dst[o++] = ' ';
    else if (c >= 0xc0) dst[o++] = '?';
    // control chars and UTF-8 continuation bytes are dropped
  }
  dst[o] = '\0';
}

bool parseReq(JsonDocument& doc, Request* r) {
  if (!copyStrict(doc["id"].as<const char*>(), r->id, 1, kIdMax, isIdChar)) return false;
  if (!copyStrict(doc["h"].as<const char*>(), r->h, kHashLen, kHashLen, isHex)) return false;
  if (!copyStrict(doc["n"].as<const char*>(), r->n, 1, kNonceMax, isHex)) return false;
  if (!doc["exp"].is<uint64_t>()) return false;
  r->exp = doc["exp"].as<uint64_t>();

  const char* pkg = doc["pkg"].as<const char*>();
  if (!pkg || !*pkg) return false;
  copyDisplay(pkg, r->pkg, kPkgMax);

  if (!doc["score"].is<int>()) return false;
  r->score = constrain(doc["score"].as<int>(), 0, 100);

  r->whyCount = 0;
  JsonVariant why = doc["why"];
  if (!why.isNull()) {
    if (!why.is<JsonArray>()) return false;
    for (JsonVariant v : why.as<JsonArray>()) {
      if (r->whyCount >= kWhyLines) break;
      const char* s = v.as<const char*>();
      if (!s) continue;
      copyDisplay(s, r->why[r->whyCount], kWhyMax);
      if (r->why[r->whyCount][0]) r->whyCount++;
    }
  }
  return true;
}

bool handleLine(char* line, size_t len, Message* out) {
  JsonDocument doc;
  DeserializationError err =
      deserializeJson(doc, line, len, DeserializationOption::NestingLimit(4));
  if (err || !doc.is<JsonObject>()) {
    sendErr("bad json");
    return false;
  }
  const char* t = doc["t"].as<const char*>();
  if (!t) {
    sendErr("missing t");
    return false;
  }
  if (strcmp(t, "hello") == 0) {
    out->kind = Kind::Hello;
    return true;
  }
  if (strcmp(t, "req") == 0) {
    if (!parseReq(doc, &out->req)) {
      sendErr("bad req");
      return false;
    }
    out->kind = Kind::Req;
    return true;
  }
  if (strcmp(t, "cancel") == 0) {
    if (!copyStrict(doc["id"].as<const char*>(), out->cancelId, 1, kIdMax, isIdChar)) {
      sendErr("bad cancel");
      return false;
    }
    out->kind = Kind::Cancel;
    return true;
  }
  if (strcmp(t, "time") == 0) {
    if (!doc["now"].is<uint64_t>()) {
      sendErr("bad time");
      return false;
    }
    out->now = doc["now"].as<uint64_t>();
    out->kind = Kind::Time;
    return true;
  }
  sendErr("unknown t");
  return false;
}

void writeLine(const char* s) {
  Serial.print(s);
  Serial.print('\n');
}

}  // namespace

void begin() {
  Serial.begin(115200);
  lineLen = 0;
  overflow = false;
}

bool poll(Message* out) {
  out->kind = Kind::None;
  while (Serial.available() > 0) {
    int c = Serial.read();
    if (c < 0) break;
    if (c == '\r') continue;
    if (c == '\n') {
      bool wasOverflow = overflow;
      size_t len = lineLen;
      lineLen = 0;
      overflow = false;
      if (wasOverflow) {
        sendErr("oversize");
        continue;
      }
      if (len == 0) continue;
      lineBuf[len] = '\0';
      if (handleLine(lineBuf, len, out)) return true;  // rest stays buffered in Serial
      continue;
    }
    if (overflow) continue;
    if (lineLen >= MAX_LINE_LEN) {
      overflow = true;  // discard until the next newline
      continue;
    }
    lineBuf[lineLen++] = static_cast<char>(c);
  }
  return false;
}

void sendHello() {
  char buf[192];
  snprintf(buf, sizeof(buf), "{\"t\":\"hello\",\"v\":1,\"pk\":\"%s\",\"ctr\":%lu,\"name\":\"Ladon Key\"}",
           keystore::publicKeyHex(), static_cast<unsigned long>(keystore::counter()));
  writeLine(buf);
}

void sendErr(const char* msg) {
  JsonDocument doc;
  doc["t"] = "err";
  doc["msg"] = msg;
  char buf[160];
  serializeJson(doc, buf, sizeof(buf));
  writeLine(buf);
}

bool sendResult(const Request& req, bool ok, const char* reason) {
  uint32_t ctr;
  if (!keystore::nextCounter(&ctr)) {
    sendErr("counter persist failed");
    return false;
  }
  // `${id}|${h}|${n}|${exp}|${ok?1:0}|${ctr}`
  char msg[kIdMax + kHashLen + kNonceMax + 48];
  int len = snprintf(msg, sizeof(msg), "%s|%s|%s|%llu|%d|%lu", req.id, req.h, req.n,
                     static_cast<unsigned long long>(req.exp), ok ? 1 : 0,
                     static_cast<unsigned long>(ctr));
  char sig[129];
  keystore::signHex(msg, static_cast<size_t>(len), sig);

  char out[kIdMax + 256];
  int o = snprintf(out, sizeof(out), "{\"t\":\"res\",\"id\":\"%s\",\"ok\":%s,\"ctr\":%lu,\"sig\":\"%s\"",
                   req.id, ok ? "true" : "false", static_cast<unsigned long>(ctr), sig);
  if (reason) snprintf(out + o, sizeof(out) - o, ",\"reason\":\"%s\"}", reason);
  else snprintf(out + o, sizeof(out) - o, "}");
  writeLine(out);
  return true;
}

}  // namespace protocol
