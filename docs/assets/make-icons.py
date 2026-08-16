"""Generate Airlock's PNG icons from the same mark as docs/assets/logo.svg.

Hand-rolled because the project ships no build step and no image dependency.
The two things that matter and that a naive rasterizer gets wrong:

  * Supersampling. Coverage is averaged over a grid of samples per pixel, so
    curves are antialiased instead of stair-stepped.
  * Real shapes. The arrowhead is a triangle tested by barycentric sign, not a
    diagonal band approximated with an inequality, which is what produced the
    mangled chevron in the first attempt.
"""
import math
import struct
import zlib

HULL = (0x0E, 0x16, 0x14)
MARK = (0x5B, 0x9D, 0xFF)
SS = 3  # samples per pixel, per axis


def dist(ax, ay, bx, by):
    return math.hypot(ax - bx, ay - by)


def capsule(px, py, x0, y0, x1, y1, radius):
    """Distance test against a line segment with round caps."""
    dx, dy = x1 - x0, y1 - y0
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / length2))
    return dist(px, py, x0 + t * dx, y0 + t * dy) <= radius


def triangle(px, py, a, b, c):
    def side(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
    d1 = side((px, py), a, b)
    d2 = side((px, py), b, c)
    d3 = side((px, py), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def mark(px, py, size, scale):
    """True when this point is inside the Airlock mark.

    A hatch: two concentric rings, six bolts between them, and an arrow through
    the middle. Geometry is proportional to size so every icon is the same
    drawing.
    """
    c = size / 2
    s = size * scale

    # Work in coordinates relative to the centre so scaling is one factor.
    x, y = px - c, py - c

    # Both rings carry the same weight. They are two edges of one hatch, not a
    # primary line and a decorative one, and unequal strokes read as a mistake.
    stroke = 0.046 * s
    r_out, w_out = 0.435 * s, stroke
    r_in, w_in = 0.275 * s, stroke

    # Bolts float in the visible gap between the two rings. That gap runs from
    # the outer ring's inner edge to the inner ring's outer edge, which is not
    # the midpoint of the two centrelines once the strokes differ in width.
    # Deriving both position and size from the gap keeps them centred if the
    # stroke weights are ever changed.
    gap_outer = r_out - w_out / 2
    gap_inner = r_in + w_in / 2
    r_bolt = (gap_outer + gap_inner) / 2
    rad_bolt = (gap_outer - gap_inner) * 0.26

    d = math.hypot(x, y)
    if abs(d - r_out) <= w_out / 2:
        return True
    if abs(d - r_in) <= w_in / 2:
        return True

    for i in range(6):
        a = math.radians(90 + i * 60)
        if dist(x, y, math.cos(a) * r_bolt, -math.sin(a) * r_bolt) <= rad_bolt:
            return True

    # The arrow fills the inner disc without touching it. Furthest extents are
    # the shaft's tail cap at 0.208s and the head's tip at 0.195s, against an
    # inner clear radius of 0.265s.
    if capsule(x, y, -0.175 * s, 0, 0.050 * s, 0, 0.033 * s):
        return True
    if triangle(x, y, (0.195 * s, 0), (0.040 * s, -0.108 * s), (0.040 * s, 0.108 * s)):
        return True
    return False


def render(size, scale, fg, bg):
    """Rasterize with SS x SS supersampling. bg=None gives a transparent field."""
    rows = []
    step = 1.0 / SS
    offset = step / 2
    for py in range(size):
        row = []
        for px in range(size):
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    if mark(px + offset + sx * step, py + offset + sy * step, size, scale):
                        hits += 1
            a = hits / (SS * SS)
            if bg is None:
                row.append((fg[0], fg[1], fg[2], int(round(a * 255))))
            else:
                row.append(tuple(int(round(bg[i] + (fg[i] - bg[i]) * a)) for i in range(3)) + (255,))
        rows.append(row)
    return rows


def write_png(path, rows):
    size = len(rows)
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in rows)
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))
    with open(path, "wb") as f:
        f.write(
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))
    print("wrote", path, size)


if __name__ == "__main__":
    # Slightly inset: an app icon is usually drawn with rounded corners or a
    # mask, and a ring flush to the edge looks clipped even when it is not.
    write_png("web/icon-192.png", render(192, 0.94, MARK, HULL))
    write_png("web/icon-512.png", render(512, 0.94, MARK, HULL))
    # Maskable icons are cropped to a circle of 80% diameter, so the mark is
    # scaled to sit inside that safe zone rather than being clipped.
    write_png("web/icon-maskable.png", render(512, 0.78, MARK, HULL))
    # A status-bar badge is drawn as a silhouette at roughly 24 pixels, so it is
    # white on transparency and nothing finer than the ring survives.
    write_png("web/icon-badge.png", render(72, 1.0, (255, 255, 255), None))
