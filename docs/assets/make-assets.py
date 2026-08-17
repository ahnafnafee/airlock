"""Derive every brand asset from the source artwork in design/icons/.

Run from the repository root:

    python docs/assets/make-assets.py

Two rules here are easy to get wrong by hand and are the reason this exists.

The lockup ships with white lettering, which is invisible on the light ground,
so it becomes two files that differ only in the ink. Only the near-neutral
bright pixels are re-inked; the mark's green is saturated and is left alone.

The maskable icon keeps an opaque field out to its edges. A launcher crops it to
whatever shape it uses, and transparency there leaves the logo floating in a
hole cut out of nothing. Every other icon is transparent, because a plate of one
color is wrong against the other theme.
"""

import glob
import os

from PIL import Image

INK_LIGHT = (23, 32, 29)
INK_DARK = (236, 242, 239)
MASKABLE_FIELD = (16, 22, 20, 255)


def trimmed(path):
    im = Image.open(path).convert("RGBA")
    return im.crop(im.getchannel("A").getbbox())


def squared(im):
    w, h = im.size
    side = max(w, h)
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return out


def reink(im, ink):
    """Recolor the lettering and leave the mark. Letterforms are near-neutral
    and bright; the mark is saturated, which is what tells them apart."""
    out = im.copy()
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a and r > 120 and g > 120 and b > 120 and max(r, g, b) - min(r, g, b) < 46:
                px[x, y] = (*ink, a)
    return out


def write(im, path):
    im.save(path)
    print("%-38s %s  %.1f KB" % (path, "x".join(map(str, im.size)), os.path.getsize(path) / 1024))


def icon(square, size, path, pad=0.0, field=None):
    inner = round(size * (1 - pad * 2))
    art = square.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), field or (0, 0, 0, 0))
    canvas.paste(art, ((size - inner) // 2, (size - inner) // 2), art)
    write(canvas, path)


def main():
    src = sorted(glob.glob(os.path.join("design", "icons", "*.png")))
    if len(src) < 3:
        raise SystemExit("expected the mark and the lockup in design/icons/")
    square = squared(trimmed(src[0]))
    lockup = trimmed(src[2])

    icon(square, 512, os.path.join("web", "icon-512.png"))
    icon(square, 192, os.path.join("web", "icon-192.png"))
    icon(square, 128, os.path.join("web", "icon-mark.png"))
    icon(square, 512, os.path.join("web", "icon-maskable.png"), pad=0.18, field=MASKABLE_FIELD)
    write(square.resize((160, 160), Image.LANCZOS), os.path.join("docs", "assets", "logo-mark.png"))

    # A silhouette the platform recolors, so it is one flat white shape.
    alpha = square.getchannel("A").resize((72, 72), Image.LANCZOS)
    badge = Image.new("RGBA", (72, 72), (255, 255, 255, 0))
    badge.paste((255, 255, 255, 255), (0, 0), alpha)
    badge.putalpha(alpha)
    write(badge, os.path.join("web", "icon-badge.png"))

    for height, out in ((96, "web"), (132, os.path.join("docs", "assets"))):
        scale = height / lockup.size[1]
        size = (round(lockup.size[0] * scale), height)
        stem = "wordmark" if out == "web" else "logo"
        for ink, suffix in ((INK_LIGHT, "light"), (INK_DARK, "dark")):
            write(reink(lockup, ink).resize(size, Image.LANCZOS),
                  os.path.join(out, "%s-%s.png" % (stem, suffix)))


if __name__ == "__main__":
    main()
