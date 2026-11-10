# hardware

Physical design of the **Ladon Key**: an ESP32-S3 USB device with a 2.0" screen and a
press-and-hold approve button, which signs install approvals out of band. Firmware is in `../firmware`.

| File | Contents |
|---|---|
| `BOM.csv` | Parts list with example sources and approximate prices (~$40-50 one-off, ~$30 with generic parts) |
| `WIRING.md` | Pin-by-pin wiring table (matches `firmware/include/pins.h`), ASCII diagram, bring-up checklist |
| `ENCLOSURE.md` | Layered laser-cut enclosure: stack order, assembly, fit notes |
| `enclosure/gen_dxf.py` | Dependency-free generator for the enclosure DXFs (parametric) |
| `enclosure/dxf/` | Generated DXF R12 cut files + SVG previews (regenerate with `python3 enclosure/gen_dxf.py`) |

## Status

- Prototype build: DevKitC-1 + breakout display + perfboard switches, wired per `WIRING.md`.
- Enclosure: DXFs generated and validated as DXF R12 (closed contours, single `CUT` layer). Not yet cut.
- **TODO (hardware owner): KiCad carrier PCB.** A 2-layer board carrying the ESP32-S3 module (or
  the DevKitC as a daughterboard), the two 12 mm switches at the enclosure hole positions, the
  WS2812, the display header/FPC and a USB-C receptacle, with Gerbers for PCBWay. No KiCad files exist
  yet. Nothing in this folder is a placeholder pretending to be one. Use the hole coordinates in
  `enclosure/gen_dxf.py` as the board's mechanical reference.
- Photos: TODO once the prototype is assembled.
