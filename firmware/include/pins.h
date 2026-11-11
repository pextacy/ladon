// Ladon Key — pin assignments and hardware options.
// Single source of truth: hardware/WIRING.md mirrors this file.
// Defaults target an Espressif ESP32-S3-DevKitC-1 (N8 / N8R2 / N16R8 modules).
//
// Pins deliberately AVOIDED:
//   GPIO0, 3, 45, 46  strapping pins (boot mode / JTAG / VDD_SPI)
//   GPIO19, 20        native USB D-/D+ (this is our host link)
//   GPIO26-32         SPI flash / PSRAM
//   GPIO33-37         octal PSRAM on N16R8 / R8 modules
//   GPIO43, 44        UART0 TX/RX (USB-UART bridge on the DevKitC)
#pragma once

// ---- Display: ST7789 2.0" IPS on hardware SPI (FSPI default pins) ----------
#define PIN_TFT_SCK    12   // SPI clock
#define PIN_TFT_MOSI   11   // SPI data (SDA on most breakout boards)
#define PIN_TFT_MISO   -1   // not used (display is write-only)
#define PIN_TFT_CS     10   // chip select
#define PIN_TFT_DC      9   // data/command
#define PIN_TFT_RST     8   // reset (tie to 3V3 and set -1 if the board has none)
#define PIN_TFT_BL      7   // backlight enable (HIGH = on); -1 if hard-wired

// Native (portrait) panel resolution. 240x320 for the common 2.0" ST7789;
// set TFT_NATIVE_H to 240 for a 240x240 panel.
#define TFT_NATIVE_W  240
#define TFT_NATIVE_H  320
// 1 or 3 = landscape. Use 3 if the image is upside down in your enclosure.
#define TFT_ROTATION    1

// ---- Buttons: momentary tactile switch to GND, internal pull-up -------------
#define PIN_BTN_APPROVE  4   // recessed, press-and-HOLD to approve
#define PIN_BTN_CANCEL   5   // single press to reject

// ---- Status LED: one WS2812 / SK6812 -----------------------------------------
// DevKitC-1 v1.0 has its onboard RGB LED on GPIO48; v1.1 boards moved it to GPIO38.
// For an external LED in the enclosure, wire its DIN here.
#define PIN_LED         48
#define LED_BRIGHTNESS  60   // 0-255; WS2812s are blinding at full power

// ---- Behaviour constants ------------------------------------------------------
#define HOLD_TO_APPROVE_MS   1500UL
#define REQUEST_TIMEOUT_MS   120000UL
#define BUTTON_DEBOUNCE_MS   25UL
// The host allows pkg <= 240 and 3 x why <= 120 UTF-16 units; JSON-escaped that is up to ~3.9 KB
// (6 bytes per control char, 3 per non-ASCII BMP char), so 1024 could reject legitimate requests.
#define MAX_LINE_LEN         4096
