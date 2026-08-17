# Brand assets

The mark and the lockup are the source artwork in `../../design/icons/`. From
them, `make-assets.py` produces every derived file:

| File | Where it is used |
| --- | --- |
| `logo-light.png`, `logo-dark.png` | the README hero, one per theme |
| `logo-mark.png` | the mark alone |
| `../../web/wordmark-light.png`, `-dark.png` | the app's own bar, one per theme |
| `../../web/icon-mark.png` | the browser tab |
| `../../web/icon-192.png`, `icon-512.png` | the installed app |
| `../../web/icon-maskable.png` | Android, which crops to its own shape |
| `../../web/icon-badge.png` | the unread badge, recolored by the platform |

Run it after changing the source artwork:

```bash
python docs/assets/make-assets.py
```

Two rules it encodes, both easy to get wrong by hand:

The lockup's lettering has to follow the theme while the mark keeps its green,
so the script re-inks only the near-neutral bright pixels and leaves the
saturated ones alone. That is why there are two files rather than one.

The maskable icon keeps an opaque field out to its edges. A launcher crops it to
whatever shape it uses, and transparency there leaves the logo floating in a
hole cut out of nothing.
