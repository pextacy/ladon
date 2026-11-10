#include "buttons.h"

#include "pins.h"

void Button::begin() {
  pinMode(pin_, INPUT_PULLUP);
  lastRaw_ = stable_ = digitalRead(pin_) == LOW;
  lastFlip_ = millis();
  downSince_ = lastFlip_;
}

bool Button::update(uint32_t nowMs) {
  changed_ = false;
  bool raw = digitalRead(pin_) == LOW;
  if (raw != lastRaw_) {
    lastRaw_ = raw;
    lastFlip_ = nowMs;
  }
  if (raw != stable_ && nowMs - lastFlip_ >= BUTTON_DEBOUNCE_MS) {
    stable_ = raw;
    changed_ = true;
    if (stable_) downSince_ = nowMs;
  }
  return changed_;
}
