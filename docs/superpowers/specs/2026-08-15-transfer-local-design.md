# transfer-local: design

**Date:** 2026-08-15
**Status:** approved, pending implementation plan

A self-hosted replacement for Blip. One Go binary, one installable web app, no
native clients. Files move between the owner's devices through an encrypted
inbox that only Tailscale-verified devices can reach, and that the host itself
cannot read.

---

## 1. Problem and framing

Blip moves files between a person's devices over direct peer-to-peer links. Most
of its engineering solves NAT traversal, transport encryption, and device
identity.

Tailscale already solves all three. So this project is not Blip plus Tailscale.
It is what remains of Blip once Tailscale is assumed: an availability layer (a
place to leave bytes when the other device is asleep) and a UI.

Because the receiver may be offline, the system is store-and-forward rather than
direct. That single decision makes both clients pure HTTP clients, which is why
no native app is needed.

### Goals

1. Send files and text from any of the owner's devices to all the others.
2. Only devices verified by Tailscale can send or receive.
3. The host cannot read file contents or filenames.
4. Multi-gigabyte files, resumable across network drops.
5. Behaves like an installed app: own icon, own window, Android share sheet,
   notifications.

### Non-goals

Multi-user accounts, sharing with other people, transfer history, thumbnails,
dedup, delta sync, relays, and per-device routing. Native Android and Windows
apps are explicitly deferred, not planned.

---

## 2. Architecture

```
  Pixel 10 Pro                     axiom-vps                  axiom-pc
  Chrome PWA                    transfer-local                Chrome PWA
      |                        (tsnet node, Go)                   |
      |  https://transfer-local.<tailnet>.ts.net                  |
      +------------------ WireGuard / TLS ------------------------+
                                    |
                          data/blobs/<id>/{meta.json,0,1,2,...}
                          ciphertext only
```

One process. It joins the tailnet as its own node via **tsnet**, which supplies
three things from a single dependency:

- A `*.ts.net` TLS certificate that every device already trusts. No self-signed
  warnings, no CA install. This is what makes the page a *secure context*, which
  is the precondition for service workers, push, install, and share target.
- A hostname that resolves only on the tailnet, via MagicDNS.
- `LocalClient.WhoIs(remoteAddr)`, which returns the WireGuard-verified node and
  user behind each connection. This is the authorization primitive, and it
  cannot be forged by anything not already holding a valid tailnet key.

Static assets are embedded with `embed.FS`. Deployment is one binary plus a
systemd unit.

### Shared inbox, not per-device routing

There is no recipient picker. Everything sent lands in one inbox that all of the
owner's devices see, and is picked up wherever the owner happens to be.

This removes the device registry, the recipient picker, per-device delivery
state, and the "which of my eight devices was that" problem. Per-device
targeting is an additive change later: a plaintext `to` field on the blob and a
filter on the inbox query.

### Tailscale is the default, not the only mode

The request was for opt-in Tailscale integration. Interpreted as: Tailscale
verification is the default and the reason the project exists, and a
non-Tailscale mode exists for LAN use.

- `--auth=tailscale` (default): tsnet node, `WhoIs` on every request, allowlist.
- `--auth=token`: binds a normal listener, requires a bearer token on every
  request, no tsnet. TLS is the operator's problem in this mode.

If the intent was the reverse (plain by default, Tailscale opted into), flip the
default. Nothing else in the design changes.

---

## 3. Security model

| Layer | Protects against | Mechanism |
|---|---|---|
| Reachability | The public internet | tsnet node, MagicDNS name, no public port |
| Identity | An unauthorized tailnet device | `WhoIs` plus a node/user allowlist |
| Transport | Passive interception | WireGuard, plus TLS |
| At rest | The VPS provider, or root on the box | AES-256-GCM in the browser, key never sent |

The server learns: blob id, uploading node, chunk count, ciphertext byte counts,
and timestamps. It never learns filename, MIME type, or content.

### Key derivation

PBKDF2-HMAC-SHA256, 600,000 iterations, over a 16-byte salt generated once by
the server and served publicly at `/api/config`. Output is a 256-bit AES-GCM
key. The salt is not a secret; its job is to stop cross-service precomputation.
The same passphrase on every device therefore yields the same key.

Derivation costs roughly one second on a phone and happens once per device. The
resulting `CryptoKey` is stored non-extractable in IndexedDB, which makes it
readable by the service worker (needed for decrypting notification metadata and
downloads) while remaining unexportable by page script.

### Passphrase verification

The server holds one `check` blob: a short known string encrypted under the key.
A new device decrypts it during setup, so a wrong passphrase fails immediately
and loudly instead of silently producing corrupt downloads. It is written once
by the first device; `POST /api/check` rejects overwrite.

### Chunk format

Plaintext is cut into fixed 8 MiB chunks. Each chunk is encrypted independently
and stored as:

```
IV (12 random bytes) || AES-256-GCM ciphertext || tag (16 bytes)
```

Additional authenticated data binds each chunk to its position:

```
chunk    AAD = "C" || fileId(16B) || chunkIndex(uint32 BE) || chunkCount(uint32 BE)
manifest AAD = "M" || fileId(16B)
```

This is load-bearing. Independently encrypted AES-GCM chunks without positional
AAD are reorderable, truncatable, and spliceable across files, even though every
individual chunk authenticates correctly. Binding position and count closes the
entire class for the cost of one argument per encrypt call.

The manifest is a JSON object `{name, size, mime, createdAt}` encrypted the same
way. `chunkCount` cannot live inside it, because the server needs it to know
when an upload is complete, so it is sent in plaintext. It leaks an approximate
file size, which the ciphertext byte count already leaks anyway.

### Abuse pre-check

The hostile caller to reason about is an authenticated, allowlisted device
running `curl`, not the UI.

| Vector | Control |
|---|---|
| Fill the disk | `max_blob_bytes` (default 50 GiB) and `max_inbox_bytes` (default 200 GiB), both enforced server-side; upload rejected with 507 past either |
| Oversized chunk body | `http.MaxBytesReader` capped at `chunkSize + 64` |
| Path traversal via blob id | Blob ids are server-generated from `crypto/rand`; the id parameter must match `^[0-9a-f]{32}$` before touching the filesystem |
| Path traversal via chunk index | Index must parse as an integer in `[0, chunkCount)`; the path is built from the parsed integer, never from the raw string |
| Unauthorized read or delete | Every handler, including static asset routes, checks identity first |
| Storage growth over time | TTL sweep, default 24 hours from completion, hourly |

Fail closed: if `--auth=tailscale` and tsnet cannot come up, or if `--auth=token`
and no token is configured, the process exits non-zero. There is no fallback to
an unauthenticated listener on any path.

Deletion is available to any allowlisted device. In a single-owner system, a
device able to delete is a device already trusted with the passphrase.

---

## 4. HTTP API

```
GET    /api/whoami                    -> {node, user, allowed}
GET    /api/config                    -> {salt, vapidKey, chunkSize, ttlHours, check|null}
POST   /api/check      {check}        -> 204, or 409 if already set
POST   /api/blob       {chunkCount}   -> {id}
PUT    /api/blob/{id}/meta            <- encrypted manifest bytes
PUT    /api/blob/{id}/chunk/{n}       <- encrypted chunk bytes, idempotent
GET    /api/blob/{id}                 -> {chunkCount, have:[...], complete, sender, meta, createdAt}
GET    /api/blob/{id}/chunk/{n}       -> encrypted chunk bytes
GET    /api/inbox                     -> [blob summary, newest first]
DELETE /api/blob/{id}                 -> 204
POST   /api/push/subscribe {sub}      -> 204
GET    /login?t=<token>               -> sets cookie, redirects; token mode only
```

Creation is two calls rather than one because the manifest's AAD binds to the
blob id, and the id is server-generated, so the client cannot encrypt the
manifest until the id exists. Keeping id generation on the server is worth one
extra round trip that happens once per file. A blob counts as complete only once
the manifest and every chunk are present.

Token mode needs the `/login` cookie route because a browser cannot attach an
`Authorization` header to a top-level navigation. Tailscale mode needs no such
route, since `WhoIs` works on every connection including navigations. Note that
token mode over plain HTTP is not a secure context, so install, push, share
target, and the service worker download path are all unavailable there. It is a
degraded fallback, not a peer of the default.

The manifest is uploaded as raw encrypted bytes and returned base64-encoded; it
is opaque to the server either way. `sender` is the node name returned by
`WhoIs`, so it is server-asserted and never client-supplied. All limits and
settings are command-line flags with environment variable fallbacks; there is no
config file.

Blob expiry is measured from the most recent write to the blob directory rather
than from its creation, so a long upload is never swept mid-flight and a
finished blob expires the stated TTL after its last chunk landed.

Resume falls out of `have[]`: the client asks which chunks arrived and PUTs the
rest. PUTs are idempotent, so a retry after a timeout is always safe.

`/dl/{id}` is not a server route. It is intercepted by the service worker and
never reaches the network.

### Storage layout

```
data/
  salt, vapid.json, subs.json, check.bin
  blobs/<32-hex-id>/
    meta.json        {chunkCount, sender, createdAt, complete, encMeta(b64)}
    0, 1, 2, ...     encrypted chunk files
```

No database. Listing the inbox is a directory scan.

`ponytail: JSON manifest per blob, O(n) scan on inbox list. Swap in SQLite if
the inbox ever holds thousands of live blobs.`

---

## 5. Client

Plain HTML and vanilla JavaScript. No framework, no build step, no bundler. Five
source files plus two icons, all served from the embedded FS.

### Upload

Read the file in 8 MiB slices with `File.slice().arrayBuffer()`, encrypt each,
`PUT` it. One chunk in memory at a time, so a 20 GB file works on a phone.

Uploads are sequential. At 8 MiB per chunk, a single round trip of dead time per
chunk is negligible against transfer time.
`ponytail: sequential PUTs. Pipeline three deep if the VPS link is ever
latency-bound rather than bandwidth-bound.`

### Download

The service worker owns decryption. The page points an `<a download>` at
`/dl/{id}`; the SW intercepts, pulls chunks, decrypts, and returns a synthesized
streaming `Response` carrying `Content-Disposition`. The browser saves it
natively, streams to disk, and shows its own progress UI.

This is the same code path on Android and Windows, and it removes any need for
the File System Access API, which does not exist on Android anyway.

### Resume after reload

In-progress uploads are recorded in IndexedDB as `{blobId, name, size,
chunkCount}`. A `File` handle cannot survive a page reload, so on reopen the app
offers "resume: reselect this file", matches on name and size, and continues
from `have[]`.

Priority: SHOULD. Drop it if it bloats the plan; resume across network drops
within a session is the MUST, and that needs no persistence.

### Push

VAPID keypair generated on first run into `data/vapid.json`. Subscriptions in
`data/subs.json`, pruned on 404 or 410 from the push service.

Pushes carry **no payload**, because a payload would leak the filename past the
encryption boundary. The service worker wakes, fetches `/api/inbox`, decrypts
the newest manifest with the key from IndexedDB, and shows a notification with
the real filename. Clicking it opens the app.

Push delivery uses Google's and Mozilla's public push services over the ordinary
internet, not the tailnet, so it arrives regardless. But the notification's
target URL only resolves while Tailscale is connected on that device.

### PWA integration

`manifest.webmanifest` declares:

- **`share_target`**: `POST /share`, `multipart/form-data`, accepting files,
  text, and url. The service worker intercepts the POST (it must never reach the
  network, since the server cannot accept plaintext), stashes the payload, and
  redirects to `/?share=1` for the page to encrypt and upload. This is what puts
  the app in Android's share sheet, and it is the single most valuable UX
  affordance here.
- **`file_handlers`**: `/open` with an enumerated list of common MIME types and
  extensions, giving a Windows Explorer "Open with" entry. Chrome requires
  concrete types, so wildcard coverage is not achievable; drag-and-drop onto the
  app window is the general path and covers every file type.
- Standard icon, name, and `display: standalone` fields for installability.

Launch at login on Windows is a one-time manual toggle in the installed app's
Chrome or Edge settings, not something the app can set. Documented in the README.

### iOS

Untargeted but functional. Safari supports installing to the Home Screen and Web
Push from 16.4. Web Share Target is not supported, so sending from the iOS share
sheet does not work. No iOS-specific code will be written.

---

## 6. Module boundaries

| File | Purpose | Depends on |
|---|---|---|
| `main.go` | Flags, config, listener selection (tsnet or plain), wiring, GC loop | store, server, push |
| `server.go` | HTTP handlers, identity gate, request validation | store, push |
| `store.go` | Blob store on disk: create, put chunk, have, list, delete, sweep | stdlib only |
| `push.go` | VAPID keys, subscription list, notify | webpush-go |
| `web/crypto.js` | KDF, chunk encrypt/decrypt, AAD construction | Web Crypto |
| `web/app.js` | UI, upload loop, inbox, setup flow | crypto.js |
| `web/sw.js` | Download decryption, push handler, share target | crypto.js |

The identity gate in `server.go` is a seam: `func(*http.Request) (Identity,
bool)`. Production supplies a tsnet `WhoIs` implementation; tests inject a fake.
This keeps the entire HTTP surface testable without a tailnet.

`store.go` never sees an `http.Request` and `server.go` never touches the
filesystem directly.

### Dependencies

Two, both justified: `tailscale.com/tsnet` (the platform feature this project is
built on) and `github.com/SherClockHolmes/webpush-go` (RFC 8291 payload
encryption and VAPID signing, not worth hand-rolling). Everything else is
stdlib. The frontend has zero dependencies.

---

## 7. Testing

Two runnable checks, no frameworks.

**`store_test.go` and `server_test.go`**, plain `go test`:

- chunks PUT out of order, `have[]` reports correctly, blob flips to complete
  only at the full count
- re-PUT of an existing chunk is idempotent
- chunk index outside `[0, chunkCount)` is rejected
- a malformed blob id never produces a filesystem path
- oversize chunk body and over-quota upload are both rejected
- TTL sweep deletes expired blobs and leaves live ones

**`web/crypto.test.mjs`**, run with `node --test` against Node 22's built-in
Web Crypto, which is the same API the browser exposes:

- encrypt then decrypt round-trips a multi-chunk payload
- a wrong passphrase fails to decrypt the check blob
- swapping two chunks' ciphertext fails authentication
- dropping the final chunk is detected
- re-encoding a chunk from one file into another fails

The last three are the whole reason the AAD scheme exists, so they are the tests
that matter most.

---

## 8. Build order

1. **Server and protocol.** `store.go`, `server.go`, `main.go` with the identity
   seam, plain-token auth first so it is testable without a tailnet. Tests pass.
2. **tsnet.** Swap in the real identity source, TLS listener, allowlist, fail
   closed. Verify from a second tailnet device and from a non-allowlisted one.
3. **Web client core.** `crypto.js` with its tests, then setup and passphrase
   flow, upload, inbox, and SW download. This is the first point the thing is
   actually usable.
4. **PWA.** Manifest, install, share target, file handlers, push.
5. **Deploy.** systemd unit, README covering admin-console prerequisites and the
   per-device install steps.

Each step is independently shippable, and step 3 is the milestone where it
replaces Blip for real use.

## 9. Prerequisites

- MagicDNS enabled in the Tailscale admin console.
- HTTPS Certificates enabled in the Tailscale admin console. Without this there
  is no trusted cert, therefore no secure context, therefore no service worker,
  push, install, or share target, and the whole client design collapses.
- A reusable auth key for the server node, supplied as `TS_AUTHKEY`.

## 10. Deferred escape hatch

If notification-then-tap proves too slow in practice, a thin Android WebView or
Trusted Web Activity wrapper adds silent background receive and uploads that
survive screen lock. It reuses the protocol and the entire UI, so nothing built
here is discarded. It is not planned and not scheduled.
