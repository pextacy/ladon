// Debounced active-low push buttons.
#pragma once
#include <Arduino.h>

class Button {
 public:
  explicit Button(uint8_t pin) : pin_(pin) {}
  void begin();
  // Call every loop. Returns true when the debounced state changed.
  bool update(uint32_t nowMs);
  bool isDown() const { return stable_; }
  bool pressedEdge() const { return changed_ && stable_; }
  bool releasedEdge() const { return changed_ && !stable_; }
  uint32_t downSinceMs() const { return downSince_; }

 private:
  uint8_t pin_;
  bool stable_ = false;
  bool lastRaw_ = false;
  bool changed_ = false;
  uint32_t lastFlip_ = 0;
  uint32_t downSince_ = 0;
};
