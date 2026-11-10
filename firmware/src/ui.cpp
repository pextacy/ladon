#include "ui.h"

#include <Adafruit_GFX.h>
#include <Adafruit_NeoPixel.h>
#include <Adafruit_ST7789.h>
#include <Fonts/FreeSans9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <SPI.h>

#include "pins.h"

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
namespace ui {
namespace {

Adafruit_ST7789 tft(PIN_TFT_CS, PIN_TFT_DC, PIN_TFT_RST);

constexpr uint16_t kBg = ST77XX_BLACK;
constexpr uint16_t kFg = ST77XX_WHITE;
constexpr uint16_t kRed = 0xF8A2;    // slightly warm red, readable on IPS
constexpr uint16_t kGreen = 0x2FE6;
constexpr uint16_t kGrey = 0x9CD3;
constexpr uint16_t kDim = 0x39E7;

constexpr int16_t kPad = 12;
constexpr int16_t kBarTop = 184;
constexpr int16_t kBarH = 14;
constexpr int16_t kFooterBase = 228;

uint32_t lastRemaining = UINT32_MAX;
int16_t lastBarPx = -1;

int16_t W() { return tft.width(); }
int16_t H() { return tft.height(); }

// 320-wide panels fit footer text + countdown on one line. On 240-wide panels the
// countdown moves up to the right end of the hold-bar row and the bar gets shorter.
constexpr int16_t kCountdownW = 44;
bool wide() { return W() >= 300; }
int16_t countdownBase() { return wide() ? kFooterBase : kBarTop + kBarH - 1; }
int16_t barWidth() { return W() - 2 * kPad - (wide() ? 0 : kCountdownW + 6); }

uint16_t textWidth(const char* s, const GFXfont* f) {
  int16_t x1, y1;
  uint16_t w, h;
  tft.setFont(f);
  tft.getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
  return w + (x1 > 0 ? x1 : 0);
}

// Copy src into dst, truncated with "..." so it fits maxW pixels in font f.
void fit(const char* src, char* dst, size_t dstSize, const GFXfont* f, uint16_t maxW) {
  strlcpy(dst, src, dstSize);
  if (textWidth(dst, f) <= maxW) return;
  size_t len = strlen(dst);
  while (len > 0) {
    len--;
    if (len + 4 > dstSize) continue;
    memcpy(dst + len, "...", 4);
    if (textWidth(dst, f) <= maxW) return;
  }
  dst[0] = '\0';
}

void text(int16_t x, int16_t baseline, const char* s, const GFXfont* f, uint16_t color) {
  tft.setFont(f);
  tft.setTextColor(color);
  tft.setCursor(x, baseline);
  tft.print(s);
}

void textCentered(int16_t baseline, const char* s, const GFXfont* f, uint16_t color) {
  text((W() - textWidth(s, f)) / 2, baseline, s, f, color);
}

// Icons: shape carries the meaning, colour only reinforces it.
void iconSquare(int16_t x, int16_t y, int16_t s, uint16_t c) { tft.fillRect(x, y, s, s, c); }

void iconCheck(int16_t x, int16_t y, int16_t s, uint16_t c) {
  int16_t t = s / 6 + 1;  // stroke thickness
  for (int16_t i = 0; i < t; i++) {
    tft.drawLine(x, y + s / 2 + i, x + s / 3, y + s - t + i, c);
    tft.drawLine(x + s / 3, y + s - t + i, x + s - 1, y + i, c);
  }
}

void iconCross(int16_t x, int16_t y, int16_t s, uint16_t c) {
  int16_t t = s / 6 + 1;
  for (int16_t i = 0; i < t; i++) {
    tft.drawLine(x + i, y, x + s - 1, y + s - 1 - i, c);
    tft.drawLine(x, y + i, x + s - 1 - i, y + s - 1, c);
    tft.drawLine(x + s - 1 - i, y, x, y + s - 1 - i, c);
    tft.drawLine(x + s - 1, y + i, x + i, y + s - 1, c);
  }
}

void splitPkg(const char* pkg, char* reg, size_t regSize, char* name, size_t nameSize, char* ver,
              size_t verSize) {
  reg[0] = ver[0] = '\0';
  const char* rest = pkg;
  const char* colon = strchr(pkg, ':');
  if (colon && colon != pkg && (size_t)(colon - pkg) < regSize && !memchr(pkg, '@', colon - pkg)) {
    memcpy(reg, pkg, colon - pkg);
    reg[colon - pkg] = '\0';
    rest = colon + 1;
  }
  const char* at = strrchr(rest, '@');
  if (at && at != rest) {  // '@' at index 0 is an npm scope, not a version
    size_t n = at - rest;
    if (n >= nameSize) n = nameSize - 1;
    memcpy(name, rest, n);
    name[n] = '\0';
    strlcpy(ver, at + 1, verSize);
  } else {
    strlcpy(name, rest, nameSize);
  }
}

}  // namespace

void begin() {
  if (PIN_TFT_BL >= 0) {
    pinMode(PIN_TFT_BL, OUTPUT);
    digitalWrite(PIN_TFT_BL, HIGH);
  }
  SPI.begin(PIN_TFT_SCK, PIN_TFT_MISO, PIN_TFT_MOSI, PIN_TFT_CS);
  tft.init(TFT_NATIVE_W, TFT_NATIVE_H);
  tft.setSPISpeed(40000000);
  tft.setRotation(TFT_ROTATION);
  tft.setTextWrap(false);
  tft.fillScreen(kBg);
}

void showBoot() {
  tft.fillScreen(kBg);
  textCentered(H() / 2, "Ladon Key", &FreeSansBold18pt7b, kFg);
  textCentered(H() / 2 + 30, "starting", &FreeSans9pt7b, kGrey);
}

void showFatal(const char* line1, const char* line2) {
  tft.fillScreen(kBg);
  iconCross((W() - 48) / 2, 40, 48, kRed);
  textCentered(130, line1, &FreeSansBold18pt7b, kRed);
  textCentered(165, line2, &FreeSans9pt7b, kFg);
}

void showIdle(const char* pubkeyHex, uint32_t counter) {
  tft.fillScreen(kBg);
  textCentered(62, "Ladon Key", &FreeSansBold18pt7b, kFg);

  char fp[9];
  strlcpy(fp, pubkeyHex, sizeof(fp));
  char line[40];
  snprintf(line, sizeof(line), "key  %s", fp);
  textCentered(112, line, &FreeSansBold12pt7b, kFg);
  snprintf(line, sizeof(line), "counter  %lu", static_cast<unsigned long>(counter));
  textCentered(142, line, &FreeSans9pt7b, kGrey);

  // Hollow ring + word: "nothing to do".
  const char* w = "waiting";
  int16_t tw = textWidth(w, &FreeSans9pt7b);
  int16_t x = (W() - tw - 20) / 2;
  tft.drawCircle(x + 6, 196, 6, kGrey);
  text(x + 20, 201, w, &FreeSans9pt7b, kGrey);
}

void showRequest(const protocol::Request& req) {
  tft.fillScreen(kBg);
  lastRemaining = UINT32_MAX;
  lastBarPx = -1;

  // Header: [■] HOLD ............ risk 85
  iconSquare(kPad, 13, 24, kRed);
  text(kPad + 34, 37, "HOLD", &FreeSansBold18pt7b, kRed);
  int16_t holdEnd = tft.getCursorX();
  char score[8];
  snprintf(score, sizeof(score), "%d", req.score);
  int16_t sw = textWidth(score, &FreeSansBold18pt7b);
  text(W() - kPad - sw, 37, score, &FreeSansBold18pt7b, kRed);
  int16_t labelX = W() - kPad - sw - textWidth("risk", &FreeSans9pt7b) - 8;
  if (labelX > holdEnd + 6) text(labelX, 37, "risk", &FreeSans9pt7b, kGrey);  // drop on narrow panels
  tft.drawFastHLine(kPad, 50, W() - 2 * kPad, kDim);

  // Package name (large) + version/registry (small).
  char reg[16], name[protocol::kPkgMax + 1], ver[48], buf[protocol::kPkgMax + 4];
  splitPkg(req.pkg, reg, sizeof(reg), name, sizeof(name), ver, sizeof(ver));
  fit(name, buf, sizeof(buf), &FreeSansBold12pt7b, W() - 2 * kPad);
  text(kPad, 80, buf, &FreeSansBold12pt7b, kFg);

  char meta[80];
  if (ver[0] && reg[0]) snprintf(meta, sizeof(meta), "v%s   %s", ver, reg);
  else if (ver[0]) snprintf(meta, sizeof(meta), "v%s", ver);
  else snprintf(meta, sizeof(meta), "%s", reg[0] ? reg : "no version");
  fit(meta, buf, sizeof(buf), &FreeSans9pt7b, W() - 2 * kPad);
  text(kPad, 102, buf, &FreeSans9pt7b, kGrey);

  // Reasons.
  for (uint8_t i = 0; i < req.whyCount; i++) {
    int16_t base = 130 + i * 22;
    tft.fillCircle(kPad + 5, base - 5, 3, kFg);
    fit(req.why[i], buf, sizeof(buf), &FreeSans9pt7b, W() - 2 * kPad - 18);
    text(kPad + 18, base, buf, &FreeSans9pt7b, kFg);
  }

  // Footer: "Hold [check] to approve · [x] to reject"
  bool wide = ui::wide();
  tft.drawFastHLine(kPad, kFooterBase - 20, W() - 2 * kPad, kDim);
  tft.setFont(&FreeSans9pt7b);
  tft.setTextColor(kFg);
  tft.setCursor(kPad, kFooterBase);
  tft.print("Hold ");
  int16_t x = tft.getCursorX();
  iconCheck(x, kFooterBase - 12, 13, kGreen);
  tft.setCursor(x + 16, kFooterBase);
  tft.print(wide ? " to approve " : " approve ");
  x = tft.getCursorX();
  tft.fillCircle(x + 2, kFooterBase - 5, 2, kGrey);
  tft.setCursor(x + 9, kFooterBase);
  x = tft.getCursorX();
  iconCross(x, kFooterBase - 12, 12, kRed);
  tft.setCursor(x + 15, kFooterBase);
  tft.print(wide ? " to reject" : " reject");
}

void updateRequest(uint32_t remainingSec, float holdProgress) {
  if (remainingSec != lastRemaining) {
    lastRemaining = remainingSec;
    char s[12];
    snprintf(s, sizeof(s), "%lus", static_cast<unsigned long>(remainingSec));
    tft.fillRect(W() - kPad - kCountdownW, countdownBase() - 15, kCountdownW, 19, kBg);
    text(W() - kPad - textWidth(s, &FreeSansBold9pt7b), countdownBase(), s, &FreeSansBold9pt7b,
         remainingSec <= 15 ? kRed : kFg);
  }

  int16_t barW = barWidth();
  if (holdProgress < 0) holdProgress = 0;
  if (holdProgress > 1) holdProgress = 1;
  int16_t px = holdProgress > 0 ? static_cast<int16_t>((barW - 4) * holdProgress) : -1;
  if (px == lastBarPx) return;
  if (px < 0) {
    tft.fillRect(kPad, kBarTop, barW, kBarH, kBg);  // hold released: clear the bar
  } else {
    if (lastBarPx < 0) tft.drawRect(kPad, kBarTop, barW, kBarH, kFg);
    if (px < lastBarPx) tft.fillRect(kPad + 2, kBarTop + 2, barW - 4, kBarH - 4, kBg);
    tft.fillRect(kPad + 2, kBarTop + 2, px, kBarH - 4, kGreen);
  }
  lastBarPx = px;
}

void showOutcome(Outcome o) {
  tft.fillScreen(kBg);
  int16_t s = 64, x = (W() - s) / 2, y = 44;
  switch (o) {
    case Outcome::Approved:
      iconCheck(x, y, s, kGreen);
      textCentered(156, "APPROVED", &FreeSansBold18pt7b, kGreen);
      textCentered(186, "signed + sent", &FreeSans9pt7b, kGrey);
      break;
    case Outcome::Rejected:
      iconCross(x, y, s, kRed);
      textCentered(156, "REJECTED", &FreeSansBold18pt7b, kRed);
      textCentered(186, "install blocked", &FreeSans9pt7b, kGrey);
      break;
    case Outcome::TimedOut:
      iconCross(x, y, s, kRed);
      textCentered(156, "TIMED OUT", &FreeSansBold18pt7b, kRed);
      textCentered(186, "install blocked", &FreeSans9pt7b, kGrey);
      break;
    case Outcome::Error:
      iconCross(x, y, s, kRed);
      textCentered(156, "ERROR", &FreeSansBold18pt7b, kRed);
      textCentered(186, "nothing was signed", &FreeSans9pt7b, kGrey);
      break;
  }
}

}  // namespace ui

// ---------------------------------------------------------------------------
// LED
// ---------------------------------------------------------------------------
namespace led {
namespace {

Adafruit_NeoPixel pixel(1, PIN_LED, NEO_GRB + NEO_KHZ800);
enum class Mode { Off, Pulse, Flash, Solid } mode = Mode::Off;
uint32_t flashUntil = 0;
uint32_t lastShow = 0;
uint32_t current = 0xFFFFFFFF;

void set(uint32_t c) {
  if (c == current) return;
  current = c;
  pixel.setPixelColor(0, c);
  pixel.show();
}

}  // namespace

void begin() {
  pixel.begin();
  pixel.setBrightness(LED_BRIGHTNESS);
  set(0);
}

void off() {
  mode = Mode::Off;
  set(0);
}

void pulseRed() { mode = Mode::Pulse; }

void flash(uint8_t r, uint8_t g, uint8_t b, uint32_t ms) {
  mode = Mode::Flash;
  flashUntil = millis() + ms;
  set(Adafruit_NeoPixel::Color(r, g, b));
}

void solidRed() {
  mode = Mode::Solid;
  set(Adafruit_NeoPixel::Color(255, 0, 0));
}

void tick(uint32_t nowMs) {
  if (nowMs - lastShow < 20) return;
  lastShow = nowMs;
  switch (mode) {
    case Mode::Pulse: {
      // 1.2 s triangle-ish breathing between dim and bright red.
      uint32_t phase = nowMs % 1200;
      uint32_t tri = phase < 600 ? phase : 1200 - phase;  // 0..600
      uint8_t v = 10 + (tri * 245) / 600;
      set(Adafruit_NeoPixel::Color(v, 0, 0));
      break;
    }
    case Mode::Flash:
      if ((int32_t)(nowMs - flashUntil) >= 0) off();
      break;
    case Mode::Off:
    case Mode::Solid:
      break;
  }
}

}  // namespace led
