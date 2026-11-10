# Ladon Key wiring

Matches `firmware/include/pins.h`. If you change a pin, change both files.
All logic is 3.3 V. Board: ESP32-S3-DevKitC-1, connected to the host on the port labelled **USB**
(native USB, GPIO19/20). The port labelled UART is not used.

## Pin table

| Function | Module pin | ESP32-S3 GPIO | DevKitC header | Notes |
|---|---|---|---|---|
| Display power | VCC | 3V3 | J1 pin 1 (3V3) | ST7789 modules take 3.3 V |
| Display ground | GND | GND | any GND | |
| Display SPI clock | SCL / SCK | **GPIO12** | J1 | FSPI default SCK |
| Display SPI data | SDA / MOSI | **GPIO11** | J1 | FSPI default MOSI |
| Display chip select | CS | **GPIO10** | J1 | |
| Display data/command | DC / RS | **GPIO9** | J1 | |
| Display reset | RST / RES | **GPIO8** | J1 | Or tie to 3V3 and set `PIN_TFT_RST -1` |
| Display backlight | BL / BLK / LED | **GPIO7** | J1 | HIGH = on. Some modules have BL always on: leave it unconnected |
| APPROVE button | leg A | **GPIO4** | J1 | Leg B to GND. Internal pull-up, active LOW |
| CANCEL button | leg A | **GPIO5** | J1 | Leg B to GND. Internal pull-up, active LOW |
| Status LED data | DIN | **GPIO48** | J1 | Through 330 ohm. Same pin as the on-board RGB LED of DevKitC-1 v1.0 (v1.1 boards: on-board LED is GPIO38) |
| Status LED power | VDD | 5V (or 3V3) | J1/J3 5V | 100 nF across VDD/GND. See note |
| Status LED ground | GND | GND | any GND | |

Pins to avoid on this board: GPIO0/3/45/46 (strapping), GPIO19/20 (USB), GPIO26-37
(flash/PSRAM), GPIO43/44 (UART0).

**LED voltage note:** a WS2812B on 5 V wants at least 3.5 V on DIN, and the ESP32-S3 gives 3.3 V.
It usually works anyway. If the colour flickers, power the LED from 3V3 (dimmer but in
spec) or use an SK6812, which is happier at 3.3 V logic.

If the on-board RGB LED (GPIO48) is wired to the same pin as the external one, both get the same
data and show the same colour. That's fine.

## Diagram

```
                       ESP32-S3-DevKitC-1  (top view, USB ports at bottom)
                     +---------------------------+
   ST7789 2.0"       |                           |
  +-----------+      |                           |
  | VCC  -----+------| 3V3                       |
  | GND  -----+------| GND                       |
  | SCL  -----+------| GPIO12                    |
  | SDA  -----+------| GPIO11                    |
  | CS   -----+------| GPIO10                    |          APPROVE (recessed)
  | DC   -----+------| GPIO9                     |            _|_
  | RST  -----+------| GPIO8              GPIO4  |-----------o   o----+
  | BL   -----+------| GPIO7                     |                     |
  +-----------+      |                           |          CANCEL     |
                     |                    GPIO5  |-----------o   o----+
       WS2812        |                           |            "|"      |
     +--------+      |                           |                     |
     | DIN <--+-330R-| GPIO48                    |                     |
     | VDD <--+------| 5V   (100nF VDD-GND)      |                     |
     | GND <--+------| GND -----------------------------------------+
     +--------+      |                           |
                     |   [USB]        [UART]     |
                     +-----|---------------------+
                           |
                     USB-C to host (CDC serial, 115200, NDJSON)
```

## Bring-up checklist

1. Flash with nothing attached: `pio run -t upload`, then `pio device monitor`, then type `{"t":"hello"}`.
   You should get a `hello` reply with `pk`. (The screen will be blank, which is fine.)
2. Attach the display. You should see the idle screen "Ladon Key / key xxxxxxxx / counter N / waiting".
   If it's mirrored or upside down, change `TFT_ROTATION` to 3. Colours inverted or a white screen
   usually means a wrong panel size in `pins.h`.
3. Attach the buttons and LED. Send a test `req` (see `firmware/test-vectors.md`). The LED should pulse red.
   Hold APPROVE for 1.5 s and you should get a `res` with `"ok":true`.
