# Airlock: design

**Date:** 2026-08-15
**Status:** revised for the full feature set, superseding the store-and-forward-only v1

A self-hosted encrypted file transfer system. One Go binary, one installable web
app, no native clients. Files move directly between the owner's devices across a
tailnet. The server queues and introduces them, and never holds their contents.

---

## 1. Problem and framing

Blip moves files between a person's devices over direct peer-to-peer links. Most
of its engineering solves NAT traversal, transport encryption, and device
identity. Tailscale already solves all three, so Airlock is what remains once
Tailscale is assumed: a queue that says who owes what to whom, a way for two
devices to find each other, and a client fast enough that nobody thinks about it.

**Transfers are peer to peer. The server is a queue, not a courier.**

File content never touches the server. The sending device chunks, hashes and
seals locally, then holds the sealed chunks on its own disk. The server records
that a transfer is pending, who it is for, and how much of it has arrived. When
the two devices are both online, they connect directly across the tailnet over a
WebRTC data channel and the bytes move in one hop.

**Resumability is what makes this practical.** The two devices do not have to
overlap for a whole transfer, only repeatedly. A 20 GB file can cross in five
separate ten-minute windows, resuming exactly where it stopped, because the
server holds a progress bitmap over the transfer's chunk list and both ends stage
their partial work in the Origin Private File System, which survives a reload and
a reboot.

So the sender is not required to sit and wait. Opening Airlock drains whatever is
pending to whoever is now reachable.

The honest cost: some overlap must eventually happen. If the sender never opens
the app again, a queued transfer never completes. And staging costs local disk on
both ends while a transfer is in flight, on hardware the owner controls rather
than rented hardware.

On a tailnet the direct path is unusually cheap to reach: ICE finds the `100.x`
addresses as host candidates, so there is no STUN and no TURN, and the server's
only role in a transfer is to pass two session descriptions it cannot interpret.

**One deliberate escape hatch.** A per-transfer checkbox, off by default, spools
the sealed chunks to the server so a transfer completes without the sender ever
being reachable again. It exists for the case where availability genuinely
matters more than principle, and it is never used unless it is ticked. That is
the only path by which content reaches the server, and even then it is ciphertext
under a key the server does not have.

### Goals

1. Send files and text between the owner's devices, to everyone or to a chosen device.
2. Only devices the tailnet vouches for can send or receive, and access is revocable.
3. The host cannot read file contents, filenames, or thumbnails.
4. Multi-gigabyte files, resumable across drops and reloads, deduplicated, delta-synced.
5. Behaves like an installed app: share sheet, notifications, file handlers.

### Non-goals

Multi-user accounts, sharing with people outside the tailnet, public links,
and any server-side view of plaintext.

---

## 2. The mechanism everything hangs off: content-addressed chunks

Files are split by content-defined chunking, and each chunk is stored under an
id derived from its own content. This one decision delivers four requested
features at once:

| Feature | Falls out as |
| --- | --- |
| **Dedup** | Identical chunks produce identical ids, so a receiver that already holds one asks for nothing |
| **Delta sync** | A changed file shares most chunk ids with its old version, so only the changed chunks cross |
| **Resume after a drop** | Ask which ids are present, send the rest |
| **Resume across sessions** | The same question, answered from a progress bitmap and local staging, so a transfer survives both devices closing |

The last row is what makes queued peer-to-peer delivery practical rather than a
compromise: two devices need to overlap repeatedly, not continuously.

The question is identical whether it is asked of a peer over a data channel or of
the server on the one opt-in path where it holds content. That is why there is
one mechanism here and not two.

### Content-defined chunking

Boundaries are chosen by a rolling hash (FastCDC), not by fixed offsets. Fixed
offsets defeat delta sync: inserting one byte at the front shifts every
subsequent boundary and invalidates every chunk. Content-defined boundaries
re-synchronize within one chunk of an edit.

Parameters: minimum 1 MiB, average 4 MiB, maximum 16 MiB. A 20 GB file yields
roughly 5000 chunks and a 160 KB chunk list, which is the balance point between
dedup granularity and per-chunk request overhead.

### Convergent encryption

For plaintext chunk `P`, with master key `MK`:

```
h    = SHA-256(P)                                     never leaves the device
cid  = HKDF(MK, salt=h, info="airlock-cid-v1",  32)   the server-facing chunk id
ck   = HKDF(MK, salt=h, info="airlock-key-v1",  32)   the chunk's AES key
iv   = HKDF(MK, salt=h, info="airlock-iv-v1",   12)   the chunk's nonce
C    = AES-256-GCM(ck, iv, P, aad = cid)
```

Three properties make this safe:

- **Deterministic IVs are correct here.** GCM's nonce-reuse catastrophe requires
  reusing an `(key, iv)` pair across *different* plaintexts. Both the key and the
  IV are derived from the plaintext's own hash, so the same pair can only ever
  encrypt the same bytes.
- **The server learns equality, and only equality.** It sees that two chunks are
  identical. It cannot recover content.
- **`MK` blocks the confirmation-of-file attack.** Plain convergent encryption
  sets `cid = H(H(P))`, which lets anyone test whether you hold a file they
  already have by computing the id themselves. Mixing `MK` into the derivation
  means only the passphrase holders can compute an id from a plaintext.

The cost is honest and stated: an attacker who compromises the host learns which
chunks repeat within and across your transfers. That is the price of dedup, and
it is the reason dedup is not free in a zero-knowledge system.

### Where ordering integrity moved

The v1 design bound each chunk to its position through the AAD. Content
addressing forbids that, because a chunk's ciphertext must be identical wherever
it appears. Ordering integrity moves to a **sealed chunk list**: an ordered array
of the `h` values, sealed under `AAD = "L" || transferId`.

This is at least as strong. A reordered, truncated, or spliced transfer fails
because the client derives each chunk's key from the list's `h` at that position,
and the resulting decryption fails its GCM tag. The list itself cannot be swapped
between transfers because its AAD names the transfer.

The client also verifies `HKDF(MK, h_i, "airlock-cid-v1") == cid_i` against the
server's plaintext id list before downloading. The two lists are derived from the
same truth by different parties, so a disagreement is detectable.

### Reference counting

Chunks are shared between transfers, so deleting a transfer must not delete
chunks another transfer still needs. The server keeps each transfer's ordered
`cid` list in **plaintext** (it needs them for dedup negotiation anyway), and the
sweep loop mark-and-sweeps: walk every live transfer's list, delete any chunk
nothing references.

`ponytail: mark-and-sweep over all transfers each cycle. Swap in a refcount file
per chunk if the sweep ever takes longer than the interval.`

---

## 3. Architecture

```
  Phone (PWA)                        Server            Desktop (PWA)
             |                    airlock                    |
             |               (tsnet node, Go)                |
             |    https://airlock.<tailnet>.ts.net           |
             +------------- WireGuard / TLS -----------------+
                                  |
                    chunks/<ab>/<cid>       shared ciphertext
                    transfers/<id>/...      per transfer records
                                  |
                          peer relays (optional)
```

One Go process, joined to the tailnet through `tsnet`, which supplies three
things from one dependency:

- A `*.ts.net` TLS certificate every device already trusts. This makes the page a
  *secure context*, the precondition for service workers, push, install, and
  share target. Without it the entire client design collapses.
- A hostname that resolves only on the tailnet, through MagicDNS.
- `WhoIs()` on every request, returning the WireGuard-verified node and user.

Static assets embed into the binary. Deploy is one binary plus a systemd unit.

### Tailscale is the default, not the only mode

- `--auth=tailscale` (default): tsnet node, `WhoIs` per request, allowlist.
- `--auth=token`: plain listener, bearer token or `/login` cookie, no tsnet. Not
  a secure context over plain HTTP, so install, push, share target and the
  service worker download path are all unavailable. A development and LAN
  fallback, not a peer of the default.

---

## 4. Security model

| Layer | Protects against | Mechanism |
| --- | --- | --- |
| Reachability | The public internet | tsnet node, MagicDNS name, no public port |
| Identity | An unauthorized tailnet device | `WhoIs` plus a user and node allowlist |
| Revocation | A lost or stolen device | Live allowlist file, no restart needed |
| Transport | Passive interception | WireGuard, plus TLS |
| At rest | The host provider, or root on the box | AES-256-GCM, keys derived in-browser |

The server learns: chunk ids and sizes, which chunks each transfer references,
who uploaded it, who it is addressed to, and timestamps. It never learns
filenames, MIME types, thumbnails, or content.

### Key hierarchy

```
passphrase --PBKDF2(600k, SHA-256, public salt)--> MK (256 bits, HKDF base key)
   |
   +--HKDF(salt=h,    info="airlock-cid-v1")--> per-chunk id
   +--HKDF(salt=h,    info="airlock-key-v1")--> per-chunk AES key
   +--HKDF(salt=h,    info="airlock-iv-v1")---> per-chunk IV
   +--HKDF(salt=0x00, info="airlock-meta-v1")-> the record key, for everything
                                                sealed per transfer rather than
                                                per chunk
```

The record key seals four things, each with its own AAD domain so none can be
substituted for another:

| Sealed record | AAD |
| --- | --- |
| Transfer metadata (name, size, mime) | `"M" \|\| transferId` |
| Chunk list (ordered `h` values) | `"L" \|\| transferId` |
| Thumbnail | `"T" \|\| transferId` |
| Passphrase verifier | `"K"` |

`MK` is imported as a non-extractable HKDF key and stored in IndexedDB, readable
by the service worker (needed to decrypt downloads and notification metadata)
and by nothing else.

### Passphrase verification

The server holds one verifier: a known string sealed under the record key. A new
device decrypts it during setup, so a wrong passphrase fails loudly instead of
silently producing an inbox full of undecryptable transfers. Written once,
`POST /api/check` rejects overwrite.

### Abuse pre-check

The caller to design against is an authenticated, allowlisted device running
`curl`, not the UI.

| Vector | Control |
| --- | --- |
| Fill the disk | Per-transfer and total quotas, reserved before bytes are accepted, enforced under a lock so concurrent creates cannot both pass |
| Oversized bodies | Every write path bounded in the store itself, not only at the HTTP layer, because a quota reservation the store cannot enforce is advisory |
| Integer overflow in quota math | Counts bounded by division before any multiplication |
| Path traversal | Ids validated against `^[0-9a-f]{64}$` (chunks) or `^[0-9a-f]{32}$` (transfers) before any path is built |
| Chunk-id squatting | A `cid` is content-derived; a client uploading wrong bytes under a real id corrupts only its own transfers, and every download verifies the GCM tag |
| Unauthorized read, delete, or relay | Every route gated, static assets included, and inbox, history and delete scoped to transfers the caller sent or received |
| Storage growth | TTL sweep on last write, plus mark-and-sweep of unreferenced chunks |

Fail closed: if tsnet cannot come up, or token mode has no token, the process
exits non-zero. There is no path from a missing credential to an open listener.

---

## 5. Devices, routing, and history

### Device registry

Every node that authenticates is recorded: node name, user login, first seen,
last seen, whether it has completed passphrase setup, and whether it is allowed.
The registry is what the recipient picker and the pairing UI read.

Allow and revoke write to the registry, and the identity function consults it on
every request, so revoking a device takes effect on its next call with no
restart.

### Recipient routing

A transfer carries a plaintext `to` list of node names. Empty means everyone,
which stays the default because it is the common case. The inbox returns
transfers addressed to everyone or to the caller. Push notifies only the
recipients, and never the sender.

`to` is deliberately plaintext: the server must route on it, and it reveals only
which of your own devices talk to each other.

### Transfer history

When a transfer is deleted or expires, its chunks go but a tombstone stays: id,
sender, recipients, sealed metadata, byte count, created and ended timestamps.
The metadata stays sealed, so history is a list of filenames only the owner's
devices can read.

History is capped at 1000 entries and 90 days, whichever binds first.

### The life of a transfer

1. **Queued.** The sender chunks and seals the file, stages it locally, and tells
   the server a transfer is pending: recipients, chunk ids, and the sealed
   metadata, chunk list and thumbnail. No content.
2. **Announced.** The recipient is notified, by the live event stream if it is
   connected and by push if it is not. The notification carries the real filename
   and thumbnail, decrypted on the receiving device.
3. **Delivered, possibly in pieces.** Whenever both devices are online, they
   connect directly and the sender sends whatever the progress bitmap says is
   still missing. An interrupted transfer resumes on the next overlap.
4. **Completed or declined.** On completion the receiver assembles and saves,
   both ends drop their staged copies, and a tombstone records it. A decline ends
   it immediately and nothing further is sent.

A sender never chooses a transport. It picks a destination, and delivery happens
when delivery becomes possible.

### Declining

A recipient can decline a transfer, from the live offer, from the notification
without opening the app, or from a button in the inbox.

Declining is a server-side record, not a dismissed notification. A Decline button
that only closed a notification would be a dismiss wearing a stronger word: the
file would still occupy the quota and still reappear next time the inbox opened.

It hides the transfer from the declining device. If the transfer named its
recipients and every one of them has declined, it is deleted outright, because
nobody is left who could collect it, and the tombstone records who declined so
the sender can see what happened. An unaddressed transfer is not deleted by one
refusal, since every device was equally its destination; it stops appearing for
whoever declined and expires on the usual clock.

Decline and delete are different actions and keep different labels. Delete
removes a transfer for everyone. Decline removes it for you.

### One visibility rule, everywhere

A device may see and delete exactly the transfers that were its own: the ones it
sent, plus the ones addressed to it or to everyone. `GET /api/inbox`,
`GET /api/history` and `DELETE /api/transfer/{id}` all apply that same predicate.

This is stricter than it strictly needs to be on a single-owner tailnet, and it
is deliberate. An earlier version of this design let any allowlisted device
delete anything, reasoning that a device holding the passphrase can already read
everything. That reasoning was incomplete on two counts. Disclosure and
destruction are different harms and only one of them is recoverable. And once
transfers carry a recipient list, letting an unrelated device delete an addressed
transfer is surprising rather than permissive.

Applying the rule to history as well as to the inbox also removes an
inconsistency that would otherwise leak which devices talk to each other, which
is metadata the sealed records were specifically designed to withhold.

### Thumbnails

Generated on the sending device with a canvas, at most 256 pixels on the long
edge, JPEG quality 0.7, for images and for the first frame of videos. Sealed
under the record key and stored as a small per-transfer blob. The server cannot
generate them, because it cannot see the image; it only stores what it is given.

---

## 6. Throughput

The product is moving large files quickly over a LAN, so the constraints that
matter are the ones that bind at gigabit speeds rather than at internet speeds.

**One data channel is not enough.** A single WebRTC data channel typically caps
well below a LAN link, because SCTP flow control and the message-oriented API get
in the way. Airlock opens several channels on one connection and stripes chunks
across them by index, each with its own send buffer and backpressure. This is the
same reason a torrent client opens several connections.

**Ordering is pure overhead here.** Chunks carry their index and are reassembled
by it, so an ordered channel buys nothing and costs head-of-line blocking.
Channels are opened unordered and still reliable.

**Sealing is parallel, cutting is not.** A content-defined boundary depends on
the bytes before it, so cutting is inherently sequential. Hashing and sealing a
chunk depend on nothing but that chunk, so they run in a worker pool while the
main thread keeps cutting.

**The file is read once.** Chunks are sealed and staged in the same pass that
cuts them, and sent from staging. An earlier design read the file twice, once to
compute ids and once to seal, which is a second full read of a 20 GB file for
nothing.

**The device is kept awake for the duration.** A screen wake lock is held while a
transfer is in flight, because the common way a large transfer fails is the
sending device going to sleep halfway. No web API can keep a closed application
running; this covers the case where it is open and idle.

**What makes large transfers survive** is not speed but the three properties
already in the design: resume from a persisted progress bitmap, memory that stays
flat regardless of file size, and per-chunk authentication so a damaged chunk
fails by itself instead of poisoning the file.

---
---

## 7. HTTP API

```
GET    /api/whoami                        -> {node, user, allowed, paired}
GET    /api/config                        -> {salt, vapidKey, cdc, ttlHours, check|null}
POST   /api/check          {check}        -> 204, or 409 if already set

GET    /api/devices                       -> [{node, user, firstSeen, lastSeen, paired, allowed}]
POST   /api/devices/{node}/allow          -> 204
POST   /api/devices/{node}/revoke         -> 204
POST   /api/devices/me/paired             -> 204

POST   /api/transfer   {cids[], to[]}     -> {id, missing: [cid...]}
PUT    /api/transfer/{id}/meta            <- sealed metadata bytes
PUT    /api/transfer/{id}/chunklist       <- sealed ordered hash list
PUT    /api/transfer/{id}/thumb           <- sealed thumbnail bytes
PUT    /api/chunk/{cid}                   <- ciphertext, idempotent
GET    /api/chunk/{cid}                   -> ciphertext
GET    /api/transfer/{id}                 -> {cids[], to[], sender, have[], complete, meta, thumb}
GET    /api/transfer/{id}/chunklist       -> sealed bytes
GET    /api/inbox                         -> [transfers this node sent or received]
DELETE /api/transfer/{id}                 -> 204, or 404 if not this node's transfer
POST   /api/transfer/{id}/decline         -> 204, hides it here and deletes it
                                             once every addressee has declined
GET    /api/history                       -> [tombstones this node sent or received]

GET    /api/presence                      -> [node names with an open stream]
POST   /api/signal   {to, kind, payload}  -> 204, relayed to that node's stream;
                                             the payload is opaque to the server
GET    /api/queue                         -> [pending transfers this node sent]
PUT    /api/transfer/{id}/progress        <- base64 bitmap, one bit per chunk,
                                             written by the receiver as it stages

POST   /api/push/subscribe {sub}          -> 204
POST   /api/relay/offer    {transfer}     -> {missing: [cid...]}   relay peers only
GET    /login?t=<token>                   -> sets cookie, token mode only
```

`POST /api/transfer` is the whole dedup, delta-sync, and resume mechanism: the
client sends the ids it computed, and the server answers with the subset it does
not already hold. Upload is then a loop over `missing`.

`sender` comes from `WhoIs` and is never read from the body.

### Storage layout

```
data/
  salt  vapid.json  subs.json  check.bin  devices.json  history.json  allow.json
  chunks/<first2>/<cid>                       shared ciphertext, content-addressed
  transfers/<id>/
    meta.json      {sender, to[], createdAt, chunkCount, complete}
    cids.json      plaintext ordered chunk ids, the server's reference record
    manifest       sealed metadata
    chunklist      sealed ordered hashes
    thumb          sealed thumbnail, optional
```

No database. `ponytail: JSON records and directory scans. Swap in SQLite if the
inbox or history ever holds tens of thousands of rows.`

---

## 8. Clients

### Web app (primary)

Plain HTML and vanilla JavaScript modules. No framework, no bundler, no build
step. Served from the embedded filesystem.

**Upload:** stream the file through FastCDC, hash and derive ids for each chunk,
`POST /api/transfer` with the full id list, then upload only what came back in
`missing`. One chunk in memory at a time.

**Download:** the service worker owns it. The page points an `<a download>` at
`/dl/{id}`; the worker fetches the chunk list, verifies it against the server's
id list, then streams chunks through decryption into a synthesized `Response`
with `Content-Disposition`. The browser saves it natively, streaming to disk,
with its own progress UI. A 20 GB file never sits in memory on either end.

**Background receive without a native app:** where the Background Fetch API is
available, a push wakes the worker, which fetches the transfer's chunks in the
background and caches them, so opening the app afterward is instant rather than
a fresh download. Where it is not available, push plus tap remains the path.

**Notifications carry everything the device can decrypt.** The sending machine as
the title, the filename and size as the body, the transfer's own thumbnail as the
large image, and two buttons: Accept downloads without opening the app, Decline
tells the server and completes inside the worker with no window at all. The
thumbnail is served from a worker-intercepted route rather than a blob URL,
because notification images are fetched by the browser process and a blob minted
in a worker is not reliably reachable from there. One tag per transfer, so
several arrivals stack rather than replacing one another. A locked device says so
instead of showing a name it cannot read.

**Nothing sends without a chosen destination.** Files arriving from the drop
zone, the Android share sheet, or the Windows context menu are staged in the Send
view with the recipient picker in reach. Sending is an explicit action. On
Windows a per-user registry entry adds "Send with Airlock" to the right-click
menu for every file type, pointing at the launcher the browser already created
for the installed app. It ships as an optional script, not a binary, because a
helper that uploaded straight from the shell would need the passphrase and would
become a second implementation of the encryption.

**PWA integration:** installable, with `share_target` for the Android share
sheet, `file_handlers` for the Windows Open with menu, drag and drop, launch at
login, and Web Push. Push payloads are empty by design, because a payload would
carry the filename past the encryption boundary; the worker fetches and decrypts
the name locally.

### No native clients

Airlock is browser-only, deliberately.

A native Android shell was designed and then cut. It would have served exactly
one capability the PWA cannot provide: writing a received file to the filesystem
with the app closed. Its price was a second implementation of the crypto in
Kotlin, and two implementations of a cipher drift. Drift here does not fail
loudly; it produces files that download successfully and cannot be opened, which
is the worst failure mode this design has.

Notification-then-tap is the accepted behavior for background receive. The tap
costs a second and buys a codebase with exactly one place where encryption
happens.

The consequence to be honest about: an upload from a phone slows down when the
screen locks, because a backgrounded tab is throttled. Content addressing makes
that recoverable rather than fatal, since reopening the app re-chunks
deterministically and resumes from whatever the server already holds.

### iOS

Untargeted but functional as an installed PWA, with Web Push from 16.4. No Web
Share Target on iOS, so sending from the share sheet is unavailable. No
iOS-specific code will be written.

---

## 9. Module boundaries

| File | Responsibility |
| --- | --- |
| `main.go` | Flags, listener selection, wiring, sweep loop |
| `server.go` | HTTP handlers, identity gate, request validation |
| `chunkstore.go` | Content-addressed ciphertext store, quotas, mark-and-sweep |
| `transfers.go` | Transfer records, inbox filtering, history tombstones |
| `devices.go` | Device registry, allowlist, pairing state |
| `relay.go` | Peer offers, chunk push, relay allowlist |
| `push.go` | VAPID keys, subscriptions, targeted delivery |
| `web/crypto.js` | KDF hierarchy, convergent sealing, AAD domains |
| `web/cdc.js` | FastCDC boundary detection |
| `web/api.js` | Typed wrapper over the HTTP API |
| `web/peer.js` | WebRTC data channel, live offers, direct chunk transfer |
| `events.go` | The nudge stream, presence, and signalling relay |
| `web/app.js` | Application shell and view routing |
| `web/ui/*.js` | Individual views: send, inbox, history, devices |
| `web/sw.js` | Decrypt-on-download, push, share target, background fetch |
| `web/views/*.js` | One module per view: send, inbox, history, devices |

The identity gate is a seam: `func(*http.Request) (Identity, bool)`. Production
supplies a `WhoIs` implementation, tests supply a fake, and the whole HTTP
surface is testable without a tailnet.

Dependencies: `tailscale.com` and `github.com/SherClockHolmes/webpush-go` on the
server, and zero on the web frontend.

---

## 10. Testing

- **Go:** chunk store (content addressing, quotas, overflow bounds, concurrent
  reservation, mark-and-sweep), transfers (inbox filtering by recipient, history
  tombstones), devices (allow and revoke taking effect live), relay negotiation.
- **JavaScript,** run under Node's built-in Web Crypto with `node --test`: the
  KDF hierarchy, convergent determinism (same plaintext yields the same id twice,
  different plaintext never does), AAD domain separation, chunk-list tamper
  detection for reorder, truncate, and splice, and FastCDC boundary stability
  under insertion.
There is no cross-language crypto suite, because there is only one
implementation of the crypto. That is the whole reason the native client was
cut.

The three checks whose failure looks like success, and which therefore matter
most: tampered chunk lists must fail to decrypt; a chunk file on the server must
be unreadable; and a non-allowlisted node must get 403 on every route including
static assets.
