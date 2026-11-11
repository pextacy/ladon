// Ladon Key — out-of-band human approval for risky package installs.
//
// State machine:  IDLE --req--> PENDING --(hold approve 1.5 s | cancel | 120 s)--> OUTCOME --1.5 s--> IDLE
//                                  \--host cancel--> IDLE
#include <Arduino.h>

#include "buttons.h"
#include "keystore.h"
#include "pins.h"
#include "protocol.h"
#include "ui.h"

namespace {

enum class State { Idle, Pending, Outcome };

constexpr uint32_t kOutcomeShowMs = 1500;

State state = State::Idle;
bool keyOk = false;

Button approveBtn(PIN_BTN_APPROVE);
Button cancelBtn(PIN_BTN_CANCEL);

protocol::Message msg;      // large-ish: keep off the stack
protocol::Request pending;
uint32_t pendingSinceMs = 0;
bool approveArmed = false;  // approve must be seen released after the request appears
bool holding = false;
uint32_t holdStartMs = 0;
uint32_t outcomeUntilMs = 0;

// Optional wall clock from {"t":"time"} — display only.
bool haveTime = false;
uint64_t timeBaseUnix = 0;
uint32_t timeBaseMs = 0;

void goIdle() {
  state = State::Idle;
  holding = false;
  led::off();
  ui::showIdle(keystore::publicKeyHex(), keystore::counter());
}

void finish(bool ok, const char* reason) {
  holding = false;
  bool sent = protocol::sendResult(pending, ok, reason);
  if (!sent) {
    ui::showOutcome(ui::Outcome::Error);
    led::flash(255, 0, 0, 600);
  } else if (ok) {
    ui::showOutcome(ui::Outcome::Approved);
    led::flash(0, 255, 0, 600);
  } else {
    ui::showOutcome(reason ? ui::Outcome::TimedOut : ui::Outcome::Rejected);
    led::flash(255, 0, 0, 600);
  }
  state = State::Outcome;
  outcomeUntilMs = millis() + kOutcomeShowMs;
}

// No RTC: wall-clock time is only known from the host's {"t":"time"} (sent before every req)
// plus millis() since then. Without it only the local 120 s timeout applies.
bool pastExpiry(uint32_t now) {
  if (!haveTime) return false;
  uint64_t unixNow = timeBaseUnix + (now - timeBaseMs) / 1000;
  return unixNow > pending.exp;  // same rule as the host: valid while now <= exp
}

uint32_t remainingSeconds(uint32_t now) {
  uint32_t elapsed = now - pendingSinceMs;
  uint32_t local = elapsed >= REQUEST_TIMEOUT_MS ? 0 : (REQUEST_TIMEOUT_MS - elapsed + 999) / 1000;
  if (!haveTime) return local;
  uint64_t unixNow = timeBaseUnix + (now - timeBaseMs) / 1000;
  // Seconds left including the current one (exp itself is still valid on the host).
  uint64_t toExp = pending.exp >= unixNow ? pending.exp - unixNow + 1 : 0;
  return toExp < local ? static_cast<uint32_t>(toExp) : local;
}

void handleMessage(uint32_t now) {
  switch (msg.kind) {
    case protocol::Kind::Hello:
      if (keyOk) protocol::sendHello();
      else protocol::sendErr("keystore unavailable");
      break;
    case protocol::Kind::Time:
      haveTime = true;
      timeBaseUnix = msg.now;
      timeBaseMs = now;
      break;
    case protocol::Kind::Req:
      if (!keyOk) {
        protocol::sendErr("keystore unavailable", msg.req.id);
      } else if (state == State::Pending) {
        protocol::sendErr("busy", msg.req.id);
      } else {
        pending = msg.req;
        pendingSinceMs = now;
        approveArmed = !approveBtn.isDown();
        holding = false;
        state = State::Pending;
        ui::showRequest(pending);
        ui::updateRequest(remainingSeconds(now), 0);
        led::pulseRed();
      }
      break;
    case protocol::Kind::Cancel:
      // Unknown / stale ids are ignored silently (the host may race a response).
      if (state == State::Pending && strcmp(msg.cancelId, pending.id) == 0) goIdle();
      break;
    case protocol::Kind::None:
      break;
  }
}

void tickPending(uint32_t now) {
  if (!approveArmed && !approveBtn.isDown()) approveArmed = true;

  // Reject wins over approve if both happen in the same tick.
  if (cancelBtn.pressedEdge()) {
    finish(false, nullptr);
    return;
  }
  // Time out at whichever comes first: 120 s on the Key, or the request's own exp. Signing an
  // approval after exp would only produce something the host rejects as "approval expired".
  if (now - pendingSinceMs >= REQUEST_TIMEOUT_MS || pastExpiry(now)) {
    finish(false, "timeout");
    return;
  }

  float progress = 0;
  if (approveArmed && approveBtn.isDown()) {
    if (!holding) {
      holding = true;
      holdStartMs = now;
    }
    progress = static_cast<float>(now - holdStartMs) / HOLD_TO_APPROVE_MS;
    if (progress >= 1.0f) {
      ui::updateRequest(remainingSeconds(now), 1.0f);
      finish(true, nullptr);
      return;
    }
  } else {
    holding = false;  // released early: hold is cancelled, bar resets
  }
  ui::updateRequest(remainingSeconds(now), progress);
}

}  // namespace

void setup() {
  protocol::begin();
  led::begin();
  ui::begin();
  ui::showBoot();
  approveBtn.begin();
  cancelBtn.begin();

  keyOk = keystore::begin() && keystore::selfTest();
  if (!keyOk) {
    ui::showFatal("KEY ERROR", "keystore / self-test failed");
    led::solidRed();
    return;
  }
  goIdle();
}

void loop() {
  uint32_t now = millis();
  approveBtn.update(now);
  cancelBtn.update(now);

  if (protocol::poll(&msg)) handleMessage(now);

  if (keyOk) {
    switch (state) {
      case State::Pending:
        tickPending(now);
        break;
      case State::Outcome:
        if ((int32_t)(now - outcomeUntilMs) >= 0) goIdle();
        break;
      case State::Idle:
        break;
    }
  }
  led::tick(now);
  delay(2);
}
