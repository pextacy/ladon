# Ladon Key enclosure

A layered laser-cut stack: five different parts, seven sheets, all 96 x 64 mm with 4 mm corner
radius, held together by four M3 screws at the corners. Made for 3 mm acrylic (or 3 mm
plywood/MDF). Black or smoked acrylic for the top two layers hides the wiring.

Generate the DXFs (no dependencies, Python 3.8+):

```sh
python3 hardware/enclosure/gen_dxf.py
```

This writes `hardware/enclosure/dxf/*.dxf` (DXF R12, millimetres, single layer `CUT`, every
contour is a through-cut) plus an `.svg` preview of each part. All dimensions are constants at the
top of the script. It runs sanity checks (holes don't overlap, screws sit inside the wall,
the USB notch clears the pocket corners) and refuses to write a broken design.

## Stack (top to bottom)

| # | File | Qty | What it does |
|---|---|---|---|
| 1 | `top.dxf` | 1 | Display window 42 x 32, **approve finger well 18 mm**, cancel hole 12.5 mm, LED hole 5 mm |
| 2 | `recess.dxf` | 1 | Display window, **approve hole 12.5 mm** (button cap passes through), cancel 12.5 mm, LED 5 mm |
| 3 | `frame.dxf` | 2 | 8 mm wall ring, 80 x 48 mm cavity for the electronics |
| 4 | `frame_usb.dxf` | 2 | Same ring with a 13 mm notch through the left wall for the USB-C plug (6 mm tall with 2 layers) |
| 5 | `bottom.dxf` | 1 | Solid base, 4 screw holes |

Total height is 21 mm (7 x 3 mm). Use M3 x 25 screws with nuts, and add rubber feet.

## Why the approve button is recessed

The approve switch sits under layer 2. Its short cap comes up through the 12.5 mm hole in the
recess layer and ends about 3 mm below the top surface, inside an 18 mm well in the top plate. You
have to put a fingertip into the well on purpose. A brush, a bag or a palm resting on the case
won't press it. Combined with the 1.5 s hold-to-approve in firmware, an accidental approval is
very unlikely. CANCEL uses a tall cap that sits flush with the top plate, so saying no is always
the easy action.

## Assembly

1. Stick the DevKitC to the **bottom** plate with foam tape, USB end at the left, centred on the
   USB notch (notch centre is 21 mm from the bottom edge; change `USB_SLOT_CY` if your board differs).
   Solder headers pointing **up**, or solder wires directly, so the board lies flat.
2. Stack 2 x `frame_usb`, then 2 x `frame`. The USB-C plug enters through the notch in the two
   lower layers.
3. Mount the two switches and the LED on a small piece of perfboard that sits directly under the
   recess layer, centred on the holes (approve 80,36, cancel 80,15, LED 80,52 mm from the
   bottom-left corner).
4. Hot-glue or tape the display module under the **recess** layer so its visible area lines up with the
   window. The 2.0" module's active area is about 40.8 x 30.6 mm; the window is 42 x 32 mm.
5. Add **recess** and then **top**, and screw the stack together.

## Fit notes / TODO for the hardware owner

- Measure your actual display module before cutting. Board outlines differ between vendors (Waveshare is
  58 x 35 mm). Change `DISPLAY_CX/CY` and the window size in the script.
- If headers point down or the wiring is bulky, add another `frame.dxf` and use longer screws.
- Laser kerf (~0.1-0.2 mm) makes holes slightly larger. That's fine for the button holes. For a
  press-fit LED, cut the LED hole at 4.8 mm.
- No paid fab order has been placed yet. SendCutSend accepts these DXFs directly (units: mm).
