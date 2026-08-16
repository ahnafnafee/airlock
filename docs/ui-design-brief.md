# Airlock interface design brief

A prompt for a design pass on the Airlock app. Paste the whole file.

---

You are the design lead on Airlock. The product works and is verified; what it
lacks is a face. Your job is to give it one that could not be mistaken for any
other tool, working from the identity it already has rather than replacing it.

## What you are designing

A self-hosted encrypted file transfer app. It is a browser PWA, installed to a
phone's Home Screen or run in a desktop tab, and it is the entire product. There
is no native app and no marketing page. What you design is what Airlock is.

Seven surfaces, all of them real and all already built:

| Surface | What happens there |
| --- | --- |
| Unlock | First run sets a passphrase; later runs enter it. The key never leaves the device. |
| Pairing | A new device says "waiting for approval" and names itself until another device admits it. |
| Install gate | iOS only. Tells the owner to add to Home Screen before setting a passphrase. |
| Send | Pick files, choose who, choose whether the server may hold a copy, send. |
| Inbox | What arrived. Name, size, sender, thumbnail, and Save. |
| History | Tombstones of transfers that ended. The filename survives the transfer. |
| Devices | Every device that reached this server. Approve, revoke, see its tailnet address. |

## The world this design comes from

Do not design a file manager. Do not design a dashboard. Design the thing the
product is named after.

An airlock is a chamber with two doors that never open at once. You put
something in, the chamber seals, pressure equalizes, and only then does the far
side open. Nothing passes unsealed. That is literally what this software does:
a file is cut into pieces, each piece is sealed on your device, and only sealed
pieces ever move.

Two facts make this product unusual, and the interface should carry both.

**The server cannot read your files.** It holds ciphertext and metadata it has
no key for. Every other transfer tool asks you to trust a server that could
read your data and promises not to. This one removes the promise. Right now
nothing in the interface expresses this at all. That is the largest unexploited
idea in the product.

**Some of this file is already there.** Files are cut on content, so a re-send,
an edited document, or a second device sending the same bytes moves only what is
genuinely new. A 16 MB file with a 256 KB edit moves one chunk of eight. No
progress bar can show that, which is why the chunk strip exists.

The vocabulary is already chosen and it is good: hull, seam, sealed, held, in
transit, breach, chunk, stage, tailnet. Mine it. Do not add a cloud, a rocket, a
shield, or a padlock.

## Binding, do not change

These carry meaning that users learn once and then read without words. Breaking
them breaks comprehension, not just taste.

- **Amber `--sodium: #F0A83C` means in transit and only that.** Never decorative,
  never a brand accent on a static element.
- **Green `--seal: #4FD1A5` means sealed or already held and only that.** A held
  chunk must never render as newly stored; that distinction is the only thing on
  screen explaining why a re-send finished instantly.
- **Red `--breach: #E8654F` means failure and only that.**
- **The chunk strip is the signature element.** One segment per chunk in file
  order, bucketed above a few hundred. Position is meaningful: a segment's place
  in the row is that chunk's place in the file.
- **Copy voice.** Plain verbs, sentence case, no exclamation marks, no filler.
  Errors say what happened and what to do. An empty screen invites an action. A
  control keeps the same name through a whole flow.

## Open, and where the work is

The current interface is competent and anonymous. Specifically:

1. **Typography has no identity whatsoever.** `--sans` is `system-ui` and
   `--mono` is `ui-monospace`. Both are the absence of a decision. This is the
   single highest-leverage change available and where most of your effort should
   go.
2. **The wordmark is letter-spaced monospace capitals.** It is a placeholder
   wearing a logo's clothes.
3. **Everything sits at one visual weight.** The type scale is 11 / 13 / 15 / 20 /
   28 px and hierarchy is carried by size alone. Nothing else varies.
4. **The desktop layout wastes most of the screen.** A 760px column centered in a
   2560px viewport, with a mostly empty rail on the left. Either earn the width
   or commit to the column deliberately and make the surrounding space part of
   the design.
5. **The drop zone is a dashed rectangle**, which is the most generic possible
   treatment of the most important control in the product. It is the airlock's
   door. Treat it as one.
6. **There is no motion identity** beyond the strip's opacity pulse.
7. **The strip only ever appears as a progress row.** It is the one form in this
   product nobody else has. Consider whether it earns a structural role: a seam,
   a divider, a device's identity, the texture of a row.

## Hard constraints, all real

Violating any of these means the design cannot ship.

- **One Go binary.** Every asset is embedded with `//go:embed`. No build step, no
  bundler, no CDN, no npm, no Tailwind, no framework. Vanilla ESM and plain CSS.
- **Any font must be a self-hosted woff2 subset** shipped inside the binary. Its
  bytes are real and you must state the budget you are spending. A pair of well
  chosen faces at 30 to 60 KB total is a legitimate cost; 400 KB is not. If you
  conclude a system stack is genuinely right, you must argue it rather than
  default to it.
- **320px to 2560px.** The nav is a bottom bar on a phone and a side rail on a
  desktop. Both are real; neither is the afterthought.
- **`viewport-fit=cover` is set**, so anything touching a screen edge pays its own
  `env(safe-area-inset-*)`.
- **Dark only.** There is no light theme and you are not adding one.
- **Offline.** This is a PWA that must render with no network.
- **Accessibility is a floor, not a feature.** Visible keyboard focus on every
  control, `prefers-reduced-motion` respected, contrast that holds for the
  secondary text color, and controls that are distinguishable by more than
  color. Icon-only buttons need names.

## Defaults you must not produce

If your design plan contains any of these, it is not finished.

**The three current AI-design clusters.** Warm cream background with a
high-contrast serif and a terracotta accent. Near-black with a single acid green
or vermilion accent. Broadsheet layout with hairline rules, zero border radius
and dense columns.

**The dark developer tool cluster**, which is the trap this project is closest
to falling into:

- Inter, Geist, or Satoshi as the whole type system
- `rounded-xl` on everything, `border-white/10`, `bg-white/5` glass panels
- A radial gradient glow behind the primary content
- A dot grid or graph paper background at 5% opacity
- Gradient text on the one heading that matters
- A fake terminal window with three colored traffic lights
- Secondary text as `#a3a3a3` at 14px, everywhere, forever
- Motion that is exclusively fade-and-rise on scroll, 300ms, staggered 50ms
- Monospace used only to mean "this is code" and never structurally

**Airlock-specific laziness:** anything resembling a cloud, a generic upload
button, a percentage progress bar, colored file-type icons, a shield, a padlock,
or a folder tree.

## Method

Work in two passes. Do not write code in the first.

**Pass one, the plan.** Produce, in this order:

1. **Palette.** Four to six named values with hex codes, each with the job it
   does. The three signal colors are given; what you decide is the ground, the
   raised surface, the seam, and the two text weights. Say what you changed from
   the current values and why.
2. **Type.** Two or three faces with roles, actual names, actual weights, and the
   byte budget. A display or wordmark face used with restraint, a text face, and
   a face for data and labels. For each one, say why it belongs to this product
   rather than to any product. A full scale with sizes, weights, tracking and
   line heights.
3. **Layout.** One paragraph of prose plus an ASCII wireframe for the phone and
   for the desktop. Say what happens to the desktop's spare width.
4. **Signature.** The one thing this interface is remembered by. The chunk strip
   is the incumbent and is strong; if you keep it, say how you push it further
   than a progress row. If you propose something else, it has to beat the strip
   on the strip's own ground, which is showing what a progress bar hides.
5. **Motion.** Where, why, and what it means. One orchestrated moment beats
   scattered effects. Say what happens under `prefers-reduced-motion`.

**The gate.** Before writing a line of code, take your own plan and answer this
honestly: if the brief had said "a self-hosted password manager" or "a private
bookmark sync", how much of this plan would change? If the answer is "the copy",
the plan is generic and you go back. Name what you revised and why.

**Pass two, the build.** Follow the revised plan exactly. Derive every color and
size from it. Then screenshot at 320, 393, 768 and 1440 wide, and walk every one
of the seven surfaces plus these states, which are all real and all reachable:

- A transfer mid-flight, with amber segments and grey ones and green ones in the
  same strip
- A re-send where seven of eight chunks were already held, with the one stored
  segment sitting at the position of the edit
- An inbox row with a thumbnail and one without
- A device that is blocked, next to one that is approved, next to this device
- A failed send
- An empty inbox and an empty history

## What done looks like

A person who has used two other transfer tools opens this one and can tell
within a second that it is not those. The screen says, without a paragraph of
copy, that the file was sealed here and that part of it was already there. And
every color still means exactly what it meant before you started.

## Reference

Current tokens live in `web/tokens.css`, layout in `web/app.css`, the strip in
`web/strip.js`, and the views in `web/views/`. The binding color semantics come
from `docs/superpowers/specs/2026-08-15-airlock-visual-design.md`. Measured
behavior worth designing around, including the delta and dedup numbers used
above, is in `docs/benchmarks.md` and `docs/platform-notes.md`.
