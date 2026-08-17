# Airlock: visual design

**Date:** 2026-08-15
**Status:** approved direction, binds every UI task in Phase 1 and Phase 2

## Subject

One technical person moving files between machines they own. Not a landing page:
a tool opened many times a day, where the job is always the same. Get this file
onto that machine, and see what is waiting for me here.

The subject's own world supplies the vocabulary. An airlock is a chamber with two
doors that never open at once, a light that changes while it cycles, and a seal
that is either intact or it is not. The tailnet supplies the other half: a small
set of machines that know each other by name.

## Palette

Dark-first, as the brief requires. Within that, deliberately not near-black with
one acid accent, which is the default every dark tool arrives at. The ground is a
desaturated green-black, the color of a pressure vessel under low light, and
there are exactly two signal colors, each with one job it never leaves.

| Token | Value | Job |
| --- | --- | --- |
| `--hull` | `#0E1614` | Page ground |
| `--hull-raised` | `#16211E` | Cards, the hatch, raised surfaces |
| `--seam` | `#24332E` | Dividers, borders, the seam between plates |
| `--bone` | `#E4E7E1` | Primary text, slightly warm so it does not glare |
| `--vapor` | `#8A9A93` | Secondary text, labels, timestamps |
| `--sodium` | `#F0A83C` | **In transit.** Primary actions, active upload, the cycling light |
| `--seal` | `#4FD1A5` | **Sealed or already held.** Encryption state, dedup hits, verified devices |
| `--breach` | `#E8654F` | Failure only. Never decorative |

Two accents is one more than the minimum, and the discipline that earns it is
that neither is ever used for the other's meaning. Amber never marks a completed
thing. Green never marks an action. A reader learns that in one session and then
the interface tells them the state at a glance without reading a word.

## Typography

No embedded font files. The binary is self-contained and the app must work
offline on a tailnet, so a web font would be an embedded asset earning its cost
in kilobytes, and the personality is available for free elsewhere.

- **Display and labels:** the system mono stack, uppercase, tracked wide
  (`0.14em`), small. Machine labeling reads as machine labeling. This is what
  carries the identity.
- **Data:** the same mono at normal tracking, for node names, byte counts,
  chunk counts, and ids. These are data and they want a mono.
- **Body and controls:** the system sans stack. Neutral on purpose, so the mono
  does the talking.

```
--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
--sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
```

Scale: 11px tracked labels, 13px data, 15px body, 20px view titles, 28px wordmark.
Nothing larger. This is an instrument, not a poster.

## Layout

One column, 760px maximum, centered. Navigation is a single element that changes
position rather than two separate designs: fixed to the bottom edge below 720px
where thumbs are, sticky to the left above it where the cursor is.

Four views, because there are four things a person comes here to do: **Send**,
**Inbox**, **History**, **Devices**.

The Send view is the landing view and needs no hero above it. The drop target is
the hero. The only thing above it is the wordmark and the name of the machine you
are currently on, which matters more here than in most apps because the whole
product is about which machine is which.

```
+--------------------------------------------------+
|  AIRLOCK                        pixel-10-pro  ●   |   <- wordmark, this device
+--------------------------------------------------+
|                                                  |
|   +------------------------------------------+   |
|   |                                          |   |
|   |             drop files here              |   |   <- the hatch
|   |               or choose                  |   |
|   |                                          |   |
|   +------------------------------------------+   |
|                                                  |
|   TO   [ All my devices  v ]                     |
|                                                  |
|   ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌               |   <- the chunk strip
|   holiday.mp4 · 1.2 GB · 340 of 512 held        |
|                                                  |
+--------------------------------------------------+
|   SEND      INBOX      HISTORY      DEVICES      |
+--------------------------------------------------+
```

## Signature: the chunk strip

The one element Airlock is remembered by, and the only place boldness is spent.

A transfer renders as a row of thin vertical segments, one per chunk, bucketed
when there are thousands. Each segment carries a state:

| State | Rendering | Means |
| --- | --- | --- |
| held | filled `--seal` | The server already had this chunk. Nothing to upload |
| sending | `--sodium`, gently pulsing | In flight now |
| stored | filled `--vapor` | Uploaded during this transfer |
| pending | `--seam` outline | Queued |

This replaces the progress bar rather than adding to it, so it is not
decoration. It exists because it makes the product's central mechanism visible:
send a file you have sent before, or a new version of one, and the strip goes
green almost entirely at once and the upload finishes immediately. The obvious
question that produces is "why was that instant", and the strip has already
answered it.

The risk it takes is that a first-time user does not know what the segments mean.
It is worth taking because the alternative is a progress bar that hides the most
interesting thing the software does, and because the caption underneath states it
in words: `340 of 512 held`.

## Motion

Three moments, nothing else.

1. The hatch border shifts to `--sodium` on drag-over. No scale, no bounce.
2. Sending segments pulse opacity, 1.4s, ease-in-out.
3. A held segment fades in over 120ms as its dedup result arrives, so a re-send
   reads as a wave rather than a jump cut.

All three sit behind `prefers-reduced-motion: reduce`, which flattens the pulse
to a static fill and removes the fade.

## Copy

Written from the user's side of the screen. Plain verbs, sentence case, and the
same word for the same action from control to confirmation.

| Situation | Copy |
| --- | --- |
| Drop target | `Drop files here` / `or choose` |
| Recipient, default | `All my devices` |
| Action | `Send`, and the confirmation says `Sent` |
| Encryption state | `Sealed on this device` |
| Plaintext mode | `Not sealed. Anyone with access to the server can read this.` |
| Empty inbox | `Nothing waiting. Anything sent from another device lands here.` |
| Empty history | `Nothing has expired yet.` |
| Wrong passphrase | `That passphrase does not match the one this server was set up with.` |
| Unapproved device | `This device is waiting for approval. Approve it from a device that is already set up.` |
| Device actions | `Approve` / `Revoke`, and a revoked row reads `Blocked` |
| History row | `Cleared 3 days ago` |

Errors state what happened and what to do. They do not apologize and they are
never vague. Empty states are invitations, not decoration.

## Quality floor

Responsive to 320px. Visible keyboard focus on every control, using `--sodium` at
2px offset. `prefers-reduced-motion` respected. Every colored state also carries
a text label, so the two signal colors are never the only channel. Contrast: bone
on hull is 13.6:1, vapor on hull is 6.2:1, both above AA.
