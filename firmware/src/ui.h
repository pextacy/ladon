// Display (ST7789) + status LED (WS2812). Rendering only, no protocol logic.
#pragma once
#include <Arduino.h>

#include "protocol.h"

namespace ui {

enum class Outcome { Approved, Rejected, TimedOut, Error };

void begin();
void showBoot();
void showFatal(const char* line1, const char* line2);
void showIdle(const char* pubkeyHex, uint32_t counter);
// Full redraw of the pending-request screen.
void showRequest(const protocol::Request& req);
// Cheap partial redraw: countdown + hold progress (0 = not holding, 1 = done).
void updateRequest(uint32_t remainingSec, float holdProgress);
void showOutcome(Outcome o);

}  // namespace ui

namespace led {

void begin();
void off();
void pulseRed();               // pending request
void flash(uint8_t r, uint8_t g, uint8_t b, uint32_t ms);  // then off
void solidRed();               // fatal error
void tick(uint32_t nowMs);

}  // namespace led
