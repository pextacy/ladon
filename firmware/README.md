# Ladon Key firmware

ESP32-S3 USB device that shows a risky install and signs the human's decision
(approve or reject) with a device-held Ed25519 key. The host daemon
(`packages/cli`) talks to it over USB CDC serial.

```
include/pins.h      all pin assignments + timing constants (mirrored in hardware/WIRING.md)
src/main.cpp        state machine: idle -> pending -> outcome -> idle
src/protocol.*      line reader, JSON parsing/validation, response builder, signing call
src/keystore.*      Ed25519 keypair + monotonic counter in NVS, RFC 8032 self-test
src/ui.*            ST7789 screens + WS2812 LED patterns
src/buttons.*       debounced active-low buttons
test-vectors.md     signature vectors + Node verification code for the host side
```

## Build and flash

Needs [PlatformIO Core](https://platformio.org/install/cli) (`pipx install platformio`
or `brew install platformio`).

```sh
cd firmware
pio run                 # build
pio run -t upload       # flash (plug into the DevKitC's "USB" port, not "UART")
pio device monitor      # 115200 baud; type {"t":"hello"} + Enter to test
```

If upload can't find the port: hold BOOT, tap RESET, release BOOT, then upload again.
After the first flash the board enumerates as a USB CDC serial device
(`/dev/cu.usbmodem*` on macOS, `/dev/ttyACM*` on Linux, `COMx` on Windows).

Board: `esp32-s3-devkitc-1`, Arduino framework, built with `ARDUINO_USB_CDC_ON_BOOT=1`
and `ARDUINO_USB_MODE=1` (native USB-Serial/JTAG controller). Libraries (fetched by
`lib_deps`): ArduinoJson 7, rweather Crypto (Ed25519), Adafruit GFX, Adafruit ST7735/ST7789,
Adafruit NeoPixel.

For a 240x240 panel set `TFT_NATIVE_H 240` in `include/pins.h`. If the picture is upside down
in the case, set `TFT_ROTATION 3`. On a 240-wide panel the footer is shortened to
"Hold ✓ approve · ✕ reject" and the countdown moves to the right of the hold bar.

## Protocol (v1)

USB CDC, 115200 baud, one JSON object per line, `\n` terminated (`\r` ignored).
Lines over 1024 bytes are discarded and answered with `{"t":"err","msg":"oversize"}`.
The USB serial port carries **only** protocol JSON; the host should still skip any line
that does not parse.

### Host -> Key

| message | effect |
|---|---|
| `{"t":"hello"}` | reply `{"t":"hello","v":1,"pk":"<64 hex>","ctr":<uint32>,"name":"Ladon Key"}`. `ctr` = last counter used (0 = never signed). |
| `{"t":"req","id":"a1b2","pkg":"npm:color-fn-utils@1.0.2","score":85,"why":["..."],"h":"<64 hex>","n":"<hex>","exp":1763139600}` | show request, wait for the human. |
| `{"t":"cancel","id":"a1b2"}` | drop the pending request with that id and return to idle. No reply. Unknown or stale ids are silently ignored. |
| `{"t":"time","now":<unix s>}` | optional. Display only: the countdown shows `min(120 s local, exp - now)`. |

Field rules for `req`. A field that breaks a rule gets `{"t":"err","msg":"bad req"}`:

| field | rule |
|---|---|
| `id` | 1-64 chars of `[A-Za-z0-9_-]` (signed) |
| `h` | exactly 64 hex chars (signed, used byte-for-byte as received, case kept) |
| `n` | 1-128 hex chars (signed, as received) |
| `exp` | non-negative JSON integer (signed, printed in decimal) |
| `pkg` | non-empty string. Display only; non-ASCII becomes `?`, truncated to 128 |
| `score` | JSON integer. Display only, clamped to 0-100 |
| `why` | optional array of strings. First 3 shown, each truncated to 96 chars |

Because `id`, `h` and `n` can't contain `|`, the signed message can't be ambiguous.

### Key -> Host

```json
{"t":"res","id":"a1b2","ok":true,"ctr":42,"sig":"<128 hex>"}
{"t":"res","id":"a1b2","ok":false,"ctr":43,"sig":"<128 hex>","reason":"timeout"}
{"t":"err","msg":"busy"}
```

Signed message: the UTF-8 string `${id}|${h}|${n}|${exp}|${ok?1:0}|${ctr}`.
`ctr` is incremented and committed to NVS (read back and checked) **before** signing, on
every response, approve or reject. If the commit fails the Key sends
`{"t":"err","msg":"counter persist failed"}` and signs nothing. The host must treat that as a rejection.
`reason` is not signed.

`err` messages: `bad json`, `missing t`, `unknown t`, `bad req`, `bad cancel`, `bad time`,
`oversize`, `busy` (a req arrived while one is pending), `keystore unavailable`,
`counter persist failed`.

### Human interaction

- **Approve**: press and hold the recessed APPROVE button for 1.5 s. A progress bar fills while
  you hold. Let go early and the hold resets. If the button is already down when the request
  arrives, it must be released and pressed again, so a jammed or taped button can't approve.
- **Reject**: one press of CANCEL. If both buttons are active in the same tick, reject wins.
- **Timeout**: 120 s after the request arrives, the Key sends a signed `ok:false` with
  `reason:"timeout"`. The Key has no RTC, so it does not check `exp`; the host must.
- LED: off when idle, red pulse while a request waits, green flash on approve, solid red flash on
  reject or timeout, steady red on a fatal keystore error.

## Host-side checklist

1. `hello` -> store/pin `pk` at pairing time. Reject any later `pk` that doesn't match.
2. Rebuild the signed message from **your own request** (`id`,`h`,`n`,`exp`) plus `ok`,`ctr`
   from the response, then verify with the SPKI-wrapped key. See `test-vectors.md`.
3. Accept only if `ctr > lastSeenCtr` (persist `lastSeenCtr`), `exp` is still in the future,
   the nonce hasn't been used before, and `ok === true`.
4. Treat `err`, a timeout, or a bad signature as **deny** (fail closed).
5. Send one `req` at a time. Wait for `res`, or send `cancel`, before the next one.

## Security notes

**Threat model.** The Key protects against a hijacked *agent*: a coding agent that has been
prompt-injected can run commands and edit files as the user, but it cannot press a physical
button. Every approval is bound to the exact command hash `h`, a one-time nonce `n`, an expiry
`exp`, and a monotonic counter `ctr`. A captured signature can't be replayed for another command
or reused later. A fully compromised OS account or a malicious daemon is out of scope: it could
show the human one thing and do another. The screen shows what the Key is signing, which helps,
but the host still decides what `h` means.

- **Private key**: 32-byte seed drawn from the ESP32-S3 hardware RNG (`esp_fill_random` with
  the SAR-ADC entropy source on via `bootloader_random_enable`, because Wi-Fi/BT are off) on
  first boot and stored in NVS namespace `ladon`. No command can read it out.
  Only the public key leaves the device.
- **Counter**: stored next to the key, committed before each signature, never wraps (the Key
  refuses to sign at `UINT32_MAX`).
- **Self-test**: at boot the Key checks RFC 8032 TEST 1 and a sign/verify round trip. If either
  fails it shows KEY ERROR and refuses all requests.
- **Not yet done (recommended follow-ups):**
  - Turn on **flash encryption + NVS encryption** (and Secure Boot v2). Without them, anyone
    with the board and a USB cable can dump flash with `esptool read_flash` and pull the seed.
    In production mode this also means JTAG off and no re-flashing.
  - Reflashing the firmware erases nothing in NVS by default, so a malicious firmware could
    read the existing key. Secure Boot closes that gap.
  - Re-pairing: `pio run -t erase` wipes NVS and makes a new identity on next boot. The host
    must then re-pair (new `pk`, counter starts at 0).
