#!/usr/bin/env python3
"""Generate the Ladon Key layered laser-cut enclosure as DXF R12 files.

No dependencies: DXF R12 is written by hand (POLYLINE/VERTEX with bulges + CIRCLE).
Units are millimetres. Every closed contour on layer CUT is a through-cut.

    python3 gen_dxf.py            # writes ./dxf/*.dxf and ./dxf/*.svg previews

Stack (top to bottom, 3 mm sheet each; see ../ENCLOSURE.md):
  1  top.dxf         display window, approve WELL (large), cancel hole, LED hole
  2  recess.dxf      display window, approve hole (cap passes through), cancel, LED
  3  frame_usb.dxf   x2  wall ring with USB-C notch
  4  frame.dxf       x2  closed wall ring
  5  bottom.dxf      solid plate
All layers share the outer outline and the 4 corner screw holes.
"""
import math
import os

# ---- Parameters (mm). Tweak to match your exact display / dev board. ----
OUTER_W, OUTER_H, OUTER_R = 96.0, 64.0, 4.0
SCREW_D, SCREW_INSET = 3.2, 5.0            # M3 clearance
WALL = 8.0                                 # frame wall width (leaves room for screw bosses)
POCKET_R = 2.0

DISPLAY_CX, DISPLAY_CY = 40.0, 33.0        # centre of the visible area
DISPLAY_WIN_W, DISPLAY_WIN_H = 42.0, 32.0  # 2.0" ST7789 active area is ~40.8 x 30.6
DISPLAY_WIN_R = 1.5

APPROVE_CX, APPROVE_CY = 80.0, 36.0
APPROVE_WELL_D = 18.0                      # top plate: finger well, button sits one layer down
APPROVE_HOLE_D = 12.5                      # recess layer: 12 mm round tactile cap passes through
CANCEL_CX, CANCEL_CY = 80.0, 15.0
CANCEL_HOLE_D = 12.5
LED_CX, LED_CY, LED_D = 80.0, 52.0, 5.0

USB_SLOT_CY, USB_SLOT_W = 21.0, 13.0       # notch in left wall, on the dev board's USB end

# --------------------------------------------------------------------------


def rounded_rect(x0, y0, x1, y1, r):
    """Closed polyline (list of (x, y, bulge)) for a rounded rectangle, CCW."""
    b = math.tan(math.pi / 8)  # bulge for a 90 degree arc
    return [
        (x0 + r, y0, 0), (x1 - r, y0, b),
        (x1, y0 + r, 0), (x1, y1 - r, b),
        (x1 - r, y1, 0), (x0 + r, y1, b),
        (x0, y1 - r, 0), (x0, y0 + r, b),
    ]


def ring_with_left_notch(ny0, ny1):
    """One closed contour for a C-shaped frame: outer outline (CCW) that dives through the
    left wall at the USB notch and runs round the pocket (CW). A single contour means no
    overlapping cut lines on the outer edge."""
    b = math.tan(math.pi / 8)
    r, pr = OUTER_R, POCKET_R
    x0, y0, x1, y1 = WALL, WALL, OUTER_W - WALL, OUTER_H - WALL
    return [
        (r, 0, 0), (OUTER_W - r, 0, b),
        (OUTER_W, r, 0), (OUTER_W, OUTER_H - r, b),
        (OUTER_W - r, OUTER_H, 0), (r, OUTER_H, b),
        (0, OUTER_H - r, 0), (0, ny1, 0),
        (x0, ny1, 0), (x0, y1 - pr, -b),          # into the pocket, then clockwise
        (x0 + pr, y1, 0), (x1 - pr, y1, -b),
        (x1, y1 - pr, 0), (x1, y0 + pr, -b),
        (x1 - pr, y0, 0), (x0 + pr, y0, -b),
        (x0, y0 + pr, 0), (x0, ny0, 0),
        (0, ny0, 0), (0, r, b),                   # back out through the notch
    ]


class Drawing:
    def __init__(self, name):
        self.name = name
        self.polys = []    # list of vertex lists
        self.circles = []  # (cx, cy, r)

    def poly(self, verts):
        self.polys.append(verts)

    def circle(self, cx, cy, d):
        self.circles.append((cx, cy, d / 2.0))

    # ---- DXF R12 ----
    def dxf(self):
        out = []

        def g(code, value):
            out.append(str(code))
            out.append(f"{value:.4f}" if isinstance(value, float) else str(value))

        g(0, "SECTION"); g(2, "HEADER")
        g(9, "$ACADVER"); g(1, "AC1009")
        g(9, "$INSBASE"); g(10, 0.0); g(20, 0.0); g(30, 0.0)
        g(9, "$EXTMIN"); g(10, 0.0); g(20, 0.0); g(30, 0.0)
        g(9, "$EXTMAX"); g(10, OUTER_W); g(20, OUTER_H); g(30, 0.0)
        g(0, "ENDSEC")
        g(0, "SECTION"); g(2, "TABLES")
        g(0, "TABLE"); g(2, "LAYER"); g(70, 1)
        g(0, "LAYER"); g(2, "CUT"); g(70, 0); g(62, 7); g(6, "CONTINUOUS")
        g(0, "ENDTAB")
        g(0, "ENDSEC")
        g(0, "SECTION"); g(2, "ENTITIES")
        for verts in self.polys:
            g(0, "POLYLINE"); g(8, "CUT"); g(66, 1); g(10, 0.0); g(20, 0.0); g(30, 0.0); g(70, 1)
            for x, y, bulge in verts:
                g(0, "VERTEX"); g(8, "CUT"); g(10, float(x)); g(20, float(y)); g(30, 0.0)
                if bulge:
                    g(42, float(bulge))
            g(0, "SEQEND"); g(8, "CUT")
        for cx, cy, r in self.circles:
            g(0, "CIRCLE"); g(8, "CUT"); g(10, float(cx)); g(20, float(cy)); g(30, 0.0); g(40, float(r))
        g(0, "ENDSEC")
        g(0, "EOF")
        return "\n".join(out) + "\n"

    # ---- SVG preview (y flipped so it looks like the DXF) ----
    def svg(self):
        def fy(y):
            return OUTER_H - y

        parts = []
        for verts in self.polys:
            d = f"M {verts[0][0]:.3f} {fy(verts[0][1]):.3f} "
            n = len(verts)
            for i in range(n):
                x0, y0, bulge = verts[i]
                x1, y1, _ = verts[(i + 1) % n]
                if bulge:
                    chord = math.hypot(x1 - x0, y1 - y0)
                    radius = chord * (1 + bulge * bulge) / (4 * abs(bulge))
                    sweep = 0 if bulge > 0 else 1  # y flip inverts direction
                    d += f"A {radius:.3f} {radius:.3f} 0 0 {sweep} {x1:.3f} {fy(y1):.3f} "
                else:
                    d += f"L {x1:.3f} {fy(y1):.3f} "
            parts.append(f'<path d="{d}Z"/>')
        for cx, cy, r in self.circles:
            parts.append(f'<circle cx="{cx:.3f}" cy="{fy(cy):.3f}" r="{r:.3f}"/>')
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{OUTER_W * 4:.0f}" height="{OUTER_H * 4:.0f}" '
            f'viewBox="-2 -2 {OUTER_W + 4} {OUTER_H + 4}">'
            f'<rect x="-2" y="-2" width="{OUTER_W + 4}" height="{OUTER_H + 4}" fill="white"/>'
            f'<g fill="none" stroke="#c00" stroke-width="0.3">{"".join(parts)}</g>'
            f'<text x="1" y="{OUTER_H + 1.5}" font-size="2.5" font-family="sans-serif">{self.name}</text></svg>\n'
        )


def base(name, outline=None):
    d = Drawing(name)
    d.poly(outline or rounded_rect(0, 0, OUTER_W, OUTER_H, OUTER_R))
    for x in (SCREW_INSET, OUTER_W - SCREW_INSET):
        for y in (SCREW_INSET, OUTER_H - SCREW_INSET):
            d.circle(x, y, SCREW_D)
    return d


def display_window(d):
    d.poly(rounded_rect(DISPLAY_CX - DISPLAY_WIN_W / 2, DISPLAY_CY - DISPLAY_WIN_H / 2,
                        DISPLAY_CX + DISPLAY_WIN_W / 2, DISPLAY_CY + DISPLAY_WIN_H / 2, DISPLAY_WIN_R))


def build():
    layers = {}

    top = base("1 top")
    display_window(top)
    top.circle(APPROVE_CX, APPROVE_CY, APPROVE_WELL_D)
    top.circle(CANCEL_CX, CANCEL_CY, CANCEL_HOLE_D)
    top.circle(LED_CX, LED_CY, LED_D)
    layers["top"] = top

    recess = base("2 recess")
    display_window(recess)
    recess.circle(APPROVE_CX, APPROVE_CY, APPROVE_HOLE_D)
    recess.circle(CANCEL_CX, CANCEL_CY, CANCEL_HOLE_D)
    recess.circle(LED_CX, LED_CY, LED_D)
    layers["recess"] = recess

    layers["frame_usb"] = base("3 frame_usb (cut 2)", ring_with_left_notch(
        USB_SLOT_CY - USB_SLOT_W / 2, USB_SLOT_CY + USB_SLOT_W / 2))

    frame = base("4 frame (cut 2)")
    frame.poly(rounded_rect(WALL, WALL, OUTER_W - WALL, OUTER_H - WALL, POCKET_R))
    layers["frame"] = frame

    layers["bottom"] = base("5 bottom")
    return layers


def check(layers):
    """Cheap sanity checks so a parameter tweak can't silently break the design."""
    s = SCREW_INSET + SCREW_D / 2
    assert s < WALL, "screw holes must sit inside the frame wall"
    assert WALL + POCKET_R <= USB_SLOT_CY - USB_SLOT_W / 2, "USB notch hits pocket corner"
    assert USB_SLOT_CY + USB_SLOT_W / 2 <= OUTER_H - WALL - POCKET_R, "USB notch hits pocket corner"
    assert APPROVE_WELL_D > APPROVE_HOLE_D, "approve well must be larger than the recess hole"
    for cx, cy, d in ((APPROVE_CX, APPROVE_CY, APPROVE_WELL_D), (CANCEL_CX, CANCEL_CY, CANCEL_HOLE_D),
                      (LED_CX, LED_CY, LED_D)):
        assert DISPLAY_CX + DISPLAY_WIN_W / 2 < cx - d / 2, "control overlaps display window"
        assert WALL <= cx - d / 2 and cx + d / 2 <= OUTER_W - WALL + 2, "control outside pocket"
    holes = [(APPROVE_CX, APPROVE_CY, APPROVE_WELL_D), (CANCEL_CX, CANCEL_CY, CANCEL_HOLE_D),
             (LED_CX, LED_CY, LED_D)]
    for i in range(len(holes)):
        for j in range(i + 1, len(holes)):
            (ax, ay, ad), (bx, by, bd) = holes[i], holes[j]
            assert math.hypot(ax - bx, ay - by) > (ad + bd) / 2 + 1.5, "holes too close"


def main():
    layers = build()
    check(layers)
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dxf")
    os.makedirs(out_dir, exist_ok=True)
    for name, d in layers.items():
        with open(os.path.join(out_dir, f"{name}.dxf"), "w", newline="\n") as f:
            f.write(d.dxf())
        with open(os.path.join(out_dir, f"{name}.svg"), "w", newline="\n") as f:
            f.write(d.svg())
        print(f"wrote dxf/{name}.dxf  ({len(d.polys)} outlines, {len(d.circles)} holes)")


if __name__ == "__main__":
    main()
