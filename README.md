<a name="readme-top"></a>

<div align="center">

<img height="120" src="./docs/assets/logo.svg" alt="Airlock">

<h1>Airlock</h1>

End-to-end encrypted file transfer between your own devices, gated by Tailscale.<br/>
One Go binary and an installable web app. No accounts, no cloud, no public port.

[![][go-shield]][go-link]
[![][tailscale-shield]][tailscale-link]
[![][crypto-shield]][crypto-link]
[![][client-shield]][client-link]
[![][deps-shield]][deps-link]

[Features](#-features) · [Installation](#-installation) · [Architecture](#-architecture) · [Measured](#-measured) · [Threat model](#-threat-model) · [Status](#-status)

</div>

> \[!IMPORTANT]
>
> Airlock is under active construction, and this file distinguishes what runs from what is designed. Sending and receiving work end to end today, through the server. The direct device-to-device channel that the design now centers on is specified and not yet built. [Status](#-status) says which task is where.

<details>
<summary><kbd>Table of contents</kbd></summary>

#### TOC

- [✨ Features](#-features)
  - [`1` The server is a queue, not a courier](#1-the-server-is-a-queue-not-a-courier)
  - [`2` Sealed before it moves](#2-sealed-before-it-moves)
  - [`3` Verified by Tailscale](#3-verified-by-tailscale)
  - [`4` Deduplicated, delta-synced, resumable](#4-deduplicated-delta-synced-resumable)
  - [`5` Installs like an app](#5-installs-like-an-app)
- [📦 Installation](#-installation)
  - [Per device](#per-device)
- [⌨️ Local development](#️-local-development)
- [🏗 Architecture](#-architecture)
- [📊 Measured](#-measured)
- [🔒 Threat model](#-threat-model)
  - [What this does not protect against](#what-this-does-not-protect-against)
- [🗺 Status](#-status)
- [🔗 Links](#-links)

<br/>

</details>

## ✨ Features

Airlock is what remains of a peer-to-peer file transfer app once you assume Tailscale. NAT traversal, transport encryption, and cryptographic device identity are already solved, so the interesting parts are the two that are left: knowing who owes what to whom while the other device is asleep, and a client good enough that you never think about it.

### `1` The server is a queue, not a courier

File content is meant to move directly between your devices. The sending device chunks, hashes and seals the file, and holds the sealed chunks on its own disk. The server is told only that a transfer is pending: who it is for, which chunk ids it is made of, and how much of it has arrived. When both devices are online they connect across the tailnet and the bytes move in one hop.

That is unusually cheap to reach here. On a tailnet the `100.x` addresses are host candidates, so there is no STUN, no TURN, and no relay to rent. The server's whole role in a transfer is to pass two session descriptions it cannot interpret.

The devices do not have to overlap for a whole transfer, only repeatedly. The server holds a progress bitmap over the transfer's chunk list and both ends stage their partial work locally, so a 20 GB file can cross in five separate ten-minute windows.

The honest cost is that some overlap must eventually happen. If the sender never opens the app again, a queued transfer never completes. One escape hatch answers that: a per-transfer checkbox, off by default, spools the sealed chunks to the server so a transfer finishes without the sender ever being reachable again. It is the only path by which content reaches the server, and even then it is ciphertext under a key the server does not have.

> **Where the code actually is.** The direct channel is designed and not built. Every transfer today takes the server-storage path, which is why that path is the one that is fully implemented, quota-bounded and tested rather than sketched. Tasks 27 to 32 are the transport, and task 32 is that checkbox: until they land there is nothing to opt out of, because holding the sealed chunks on the server is all there is.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

### `2` Sealed before it moves

Files are encrypted in the browser before a single byte leaves it. The server holds ciphertext and routing metadata, and that is all it can ever hold. It does not learn the filename, the MIME type, the thumbnail, or the contents, because the key derives from a passphrase that never leaves your devices.

Chunks are sealed with AES-256-GCM under convergent encryption: the chunk's own SHA-256 seeds an HKDF that produces its id, its key and its nonce. Deterministic nonces are safe under exactly this construction, because both the key and the nonce derive from the plaintext, so the same pair can only ever encrypt the same bytes. Mixing the master key into the id derivation is what blocks the confirmation-of-file attack that plain convergent encryption invites.

Ordering integrity cannot live in each chunk's authenticated data, because a chunk's ciphertext has to be identical wherever it appears or dedup stops working. It lives in a **sealed chunk list** instead: the ordered array of content hashes, sealed under an authenticated domain that names the transfer. A reordered, truncated or spliced transfer fails, because the client derives each chunk's key from the hash the list gives for that position, and a mismatch fails the GCM tag. The list cannot be swapped between transfers because its own authenticated data names one.

| The server sees | The server never sees |
| --- | --- |
| Chunk ids, sizes and counts | Filename |
| Which chunks a transfer references | MIME type |
| That two transfers share a chunk | The thumbnail image |
| Sender node, recipient list, timestamps | One byte of content |

<div align="right">

[![][back-to-top]](#readme-top)

</div>

### `3` Verified by Tailscale

Airlock is a tailnet node in its own right rather than something hiding behind a reverse proxy. One dependency buys three things at once:

- A `*.ts.net` TLS certificate every device already trusts, with no warnings and no CA to install
- A hostname that resolves only on your tailnet, through MagicDNS
- `WhoIs()` on every single request, returning the WireGuard-verified node and user behind the connection

That last one is the actual authorization primitive, and nothing outside your tailnet can forge it. Every route is gated, static assets included. There is deliberately no unauthenticated path. Above the tailnet allowlist sits a device registry, consulted on every request, so revoking a device takes effect on its next call with no restart and no cached decision to expire.

Two modes reach the tailnet. `host` serves through the machine's own running tailscaled, which owns the kernel TUN path. `embedded` joins as its own `tsnet` node and needs nothing installed. Host is the default, for reasons that are argued rather than measured; see [Measured](#-measured).

A `--auth=token` mode exists for a LAN without Tailscale. It is a degraded fallback and the docs say so plainly, because plain HTTP is not a secure context and half the client stops working there.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

### `4` Deduplicated, delta-synced, resumable

Files are split by content, not by offset. Each chunk is stored under an id derived from its own bytes, which means one question answers four features at once: *which of these ids do you already have?*

| You get | Because |
| --- | --- |
| **Dedup** | Identical chunks produce identical ids, so one copy is stored and one copy is sent |
| **Delta sync** | An edited file shares most ids with its old version, so only the changed parts move |
| **Resume after a drop** | Ask which ids are present, send the rest |
| **Resume after a reload** | The same question. Re-chunking is deterministic, so no client state has to survive |

That last row is why the design is worth its complexity. Nothing is persisted in the browser to make resume work: close the tab mid-upload, reopen, pick the same file, and it continues.

Boundaries come from a rolling hash rather than fixed offsets, because fixed offsets defeat delta sync entirely: inserting one byte at the front shifts every later boundary and invalidates every chunk.

Downloads are handled by the service worker, which fetches, decrypts, and hands the browser a streaming response with a real `Content-Disposition`. The browser saves it natively, with its own progress bar, streaming to disk. A 20 GB file never sits in memory, on either end.

The honest cost is stated in full under [what this does not protect against](#what-this-does-not-protect-against): equality between chunks is visible to whoever holds them.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

### `5` Installs like an app

Because the Tailscale certificate makes the page a genuine secure context, the web client is not a compromise. It installs, it gets its own icon and window, and it does the things people actually want from a transfer app:

- **Android share sheet.** Share a photo from Gallery, pick Airlock, and it is staged in the Send view with the recipient picker in reach. Sending stays an explicit action, because a share target that uploaded on arrival would let any page choose what you sent.
- **Web Push.** A file lands and your desktop notifies you with the real filename, decrypted locally, because the push itself carries no payload to leak.
- **Windows file handling.** Right-click a PDF, an image, an archive, Open with, Airlock. A file handler has to name the types it accepts, so the list is the common ones; dragging onto the window covers everything else.
- **A live inbox.** An open app is nudged by a server-sent event stream rather than by polling, so an arrival appears without a refresh.

You pick a destination, or leave it at all your devices, which stays the default because it is the common case. The recipient list is deliberately plaintext: the server has to route on it, and it reveals only which of your own devices talk to each other.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📦 Installation

Two things must be enabled in the Tailscale admin console, under Settings then Features:

- **MagicDNS**, or the server's hostname does not resolve.
- **HTTPS Certificates**, or there is no trusted certificate, therefore no secure context, therefore no install, push, share target, or download. Airlock does not work without this one.

```bash
go build -o airlock .
scp airlock your-server:/usr/local/bin/
scp deploy/airlock.service your-server:/etc/systemd/system/
scp deploy/sysctl-airlock.conf your-server:/etc/sysctl.d/
```

On the server:

```bash
sudo useradd --system --home /var/lib/airlock --shell /usr/sbin/nologin airlock

# Host mode reads the tailscaled local API socket, which is root-owned by
# default. This is the supported way to hand it to one non-root user.
sudo tailscale set --operator=airlock

sudo sysctl --system          # UDP buffer sizes, see deploy/sysctl-airlock.conf
sudo systemctl daemon-reload
sudo systemctl enable --now airlock
journalctl -u airlock -f
```

The unit's `StateDirectory=` creates `/var/lib/airlock` at mode 0700 owned by that user, so there is no directory to make by hand. The startup line names the mode and the allowed tailnet users, which is worth reading once: it is the only place the server reports which mode answered.

In `host` mode Airlock answers on the server machine's own tailnet name, `https://<that-machine>.<your-tailnet>.ts.net`. The two modes do not share a URL. `embedded` joins as its own node named by `--hostname`, so it answers on `https://airlock.<your-tailnet>.ts.net` instead, and it needs `TS_AUTHKEY` in the environment the first time it starts:

```bash
sudo systemctl edit airlock
```

```ini
[Service]
Environment=TS_AUTHKEY=tskey-auth-...
# The empty assignment is required: Type=simple permits one ExecStart, so a
# drop-in that only adds a second one refuses to load.
ExecStart=
ExecStart=/usr/local/bin/airlock --data /var/lib/airlock --tailscale-mode=embedded
```

Open the URL on any device and choose a passphrase. Every other device enters the same one. It is never sent to the server: it derives a key that stays in that device's IndexedDB, and the server holds only a verifier sealed under it, so a wrong passphrase fails loudly on the next device instead of quietly filling an inbox with records nothing can open.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--auth` | `tailscale` | `tailscale` or `token` |
| `--data` | `./data` | data directory |
| `--tailscale-mode` | `host` | `host` serves through the machine's tailscaled, `embedded` joins as its own tsnet node |
| `--hostname` | `airlock` | node name, embedded mode only |
| `--addr` | `127.0.0.1:8080` | listen address, token mode only |
| `--allow-users` | node owner | comma-separated tailnet logins |
| `--allow-nodes` | any | comma-separated node names |
| `--require-approval` | off | hold new devices until an approved device admits them |
| `--max-chunk` | 16 MiB | maximum bytes per chunk |
| `--max-total` | 200 GiB | maximum bytes stored across all chunks |
| `--max-chunks-per-transfer` | 200000 | maximum chunks in one transfer |
| `--max-record` | 4 MiB | maximum bytes per sealed record |
| `--ttl-hours` | 24 | hours of inactivity before a transfer is swept |
| `--vapid-subject` | `mailto:airlock@invalid` | contact address carried in the VAPID token sent to push services |

Tailnet mode is chosen with `--tailscale-mode`, and the flag defaults to `host`, so a server started without it is a host-mode server.

### Per device

**Windows and macOS, Chrome or Edge.** Open the URL and install from the address bar. It gets its own window and icon. Right-click any file and choose **Send with Airlock**, or drag it onto the window.

**Android, Chrome.** Add to Home screen. Share to it from any app's share sheet.

**iOS, Safari.** Add to Home Screen. Notifications require the Home Screen install, not a browser tab. iOS has no Web Share Target, so sending starts from inside Airlock rather than from another app's share sheet.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## ⌨️ Local development

Go 1.26 or later and Node 22 or later. There is no frontend build step and no bundler, so what you edit is what the browser runs.

```bash
git clone https://github.com/ahnafnafee/airlock.git
cd airlock

go vet ./...
go test ./...
go test -bench=. -run='^$' ./...
node --test web/*.test.mjs
```

To run against localhost without a tailnet:

```bash
AIRLOCK_TOKEN=devtoken go run . --auth=token --data ./devdata
```

Then open `http://localhost:8080/login?t=devtoken`. Localhost counts as a secure context even over plain HTTP, so Web Crypto and the service worker both work in development.

The three checks that matter most, because these are the ones whose failure looks like success:

1. `node --test web/crypto.test.mjs` must refuse a chunk opened under the wrong id, a corrupted chunk, a truncated hash list, and a record spliced in from another transfer or another domain. If any of those open, a transfer can be tampered with undetectably.
2. A chunk file under `data/chunks/` must be unreadable. If `cat` shows your file, encryption is not actually in the path.
3. A non-allowlisted tailnet node must get 403 on every route, static assets included.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🏗 Architecture

```
  Phone (PWA)               Server                Desktop (PWA)
  iOS / Android             airlock               Windows / macOS / Linux
      |                (tailnet node, Go)                |
      |         https://<node>.<tailnet>.ts.net          |
      +---------------- WireGuard / TLS -----------------+
      |                                                  |
      +--- direct tailnet channel, designed, pending ----+

        data/chunks/<ab>/<cid>       sealed, content addressed
        data/transfers/<id>/         records and the sealed list
```

One Go process joined to the tailnet, with the static assets embedded in the binary. Deploy is one binary plus a systemd unit. No database: records are JSON files and directory scans, with a `ponytail:` note naming SQLite as the upgrade if an inbox ever holds tens of thousands of rows.

The server may run anywhere on the tailnet, including a machine that is also a client. An always-on box is still the recommendation, because a queue is only useful when it is reachable.

| File | Responsibility |
| --- | --- |
| `main.go` | Flags, listener selection, wiring, sweep loop |
| `tailscale.go` | Tailnet identity and TLS, in host and embedded modes |
| `server.go` | HTTP handlers, identity gate, request validation |
| `chunkstore.go` | Content-addressed ciphertext, quotas, mark-and-sweep |
| `transfers.go` | Transfer records, recipient-filtered inbox, history tombstones |
| `devices.go` | Device registry, live allowlist, pairing state |
| `push.go` | VAPID keys, subscriptions, targeted delivery |
| `events.go` | The server-sent nudge stream |
| `web/cdc.js` | Content-defined chunk boundaries |
| `web/crypto.js` | Key hierarchy, convergent sealing, record domains |
| `web/upload.js` | Two-pass upload with dedup negotiation |
| `web/thumb.js` | Sealed thumbnails from a canvas |
| `web/api.js`, `web/app.js`, `web/strip.js` | Typed API wrapper, shell and routing, the status strip |
| `web/views/*.js` | One module per view: send, inbox, history, devices |
| `web/sw.js` | Decrypt-on-download, push, share target |

Exactly two Go dependencies, `tailscale.com` and `webpush-go`. Everything else is the standard library. The frontend has zero dependencies and no build step.

The identity gate is a seam, `func(*http.Request) (Identity, bool)`. Production supplies a `WhoIs` implementation, tests supply a fake, and the whole HTTP surface is testable without a tailnet.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📊 Measured

Full method, machine and caveats in [docs/benchmarks.md](./docs/benchmarks.md). Two things it set out to settle:

**Does `host` beat `embedded`? Not measured.** The comparison needs a real tailnet and two devices, and it has not been run. The default rests on an argument: the daemon owns the kernel TUN path and the TSO, GRO, GSO and `mmsg()` work that got Tailscale's userspace WireGuard past 10 Gb/s, none of which the in-process netstack has, and [an open upstream issue](https://github.com/tailscale/tailscale/issues/9707) reports `tsnet` running roughly 8 to 9 times slower. That argument is why `host` is the default; it is not evidence, and the default should not be defended as though it were. The benchmark file carries the exact commands, the traps that would turn the run into a measurement of nothing, and the empty table waiting for it.

**Is the plaintext toggle worth anything? Measured, and no.** On a desktop i9-14900K, sealing costs 0.572 ms per MiB more than plaintext. Almost all of that is already hidden: the uploader runs four chunks in flight, so the AES-GCM overlaps the network and would only surface on a link past about 12 gigabits. What does not overlap is the first pass, which hashes the whole file before the transfer can be created, and hashing happens in both modes. Turning sealing off removes 0.106 ms per MiB from the critical path, about a tenth of a second per gigabyte, which is well under one percent of a transfer on any tailnet link.

So the toggle is not a performance setting, and the interface never presents it as one. Turning it off buys a rounding error and gives up the entire threat model, so the control is labeled by what it does to secrecy and its off state states the consequence plainly.

Both crypto figures are floors rather than browser costs: they were taken under Node against the app's own unmodified `web/crypto.js`, so they include the real cipher work but not the page's overhead. Every one of them came off a desktop CPU, and a phone is both the thinnest case and the common sending device, which is the open question that file leaves behind.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🔒 Threat model

| Layer | Protects against | Mechanism |
| --- | --- | --- |
| Reachability | The public internet | Tailnet node, MagicDNS name, no public port |
| Identity | An unauthorized tailnet device | `WhoIs` plus a user and node allowlist |
| Revocation | A lost or stolen device | Device registry read on every request, no restart |
| Transport | Passive interception | WireGuard, plus TLS |
| At rest | The host provider, or root on the box | AES-256-GCM, keys derived in the browser |

The caller Airlock is designed against is an authenticated, allowlisted device running `curl`, not the UI. Ids are validated against `^[0-9a-f]{64}$` for chunks and `^[0-9a-f]{32}$` for transfers before any path is built. Quota is checked under a lock and reserves a whole chunk's worth before the body is read, so two concurrent writers cannot both pass on the same stale total, and records and chunks are counted against one budget rather than each pretending the other's bytes are free. Every write path is bounded inside the store itself rather than only at the HTTP layer, because a reservation the store cannot enforce is advisory. Chunk ids are content-derived and first-write-wins, so a client uploading wrong bytes under a real id corrupts only its own transfers and every download verifies the tag. Inbox, history and delete all apply one predicate: a device sees exactly the transfers it sent, plus the ones addressed to it or to everyone.

Fail closed: if Tailscale cannot come up, or token mode has no token configured, the process exits non-zero. There is no path from a missing credential to an open listener.

### What this does not protect against

Stated because a security section that only lists wins is not a threat model.

- **Chunk equality, under dedup.** Whoever holds the ciphertext learns which chunks repeat within and across your transfers. That means they can tell you sent the same file twice, or that two transfers share content, or roughly how much of a new version changed. This leak is inherent to dedup in a zero-knowledge system, and it is the price of the whole of feature 4. Nothing in the design removes it; a scheme that did would give up dedup and delta sync.
- **A device that holds the passphrase.** There is one key for everything and no per-device key. Any device that has been unlocked can read every transfer, past and future, and can compute chunk ids from plaintext. Revoking a device in the registry stops it reaching the server; it does not unlearn the key already in its IndexedDB, and it does not make a copy of the ciphertext it already took unreadable. Rotating means choosing a new passphrase on every device, and anything still sealed under the old one becomes unopenable.
- **Traffic analysis.** Chunk ids, ciphertext sizes, chunk counts, sender, recipients and timestamps are plaintext by necessity, because the server routes and quotas on them. Sizes are not padded and timing is not smoothed.
- **A hostile server denying service.** Integrity is authenticated; availability is not. A compromised host can delete transfers, withhold chunks, or refuse to serve, and a client will notice but cannot prevent it. A corrupted chunk fails its GCM tag rather than producing a damaged file, which is the failure mode worth having.
- **Plaintext mode.** With the seal checkbox off, the server holds your bytes as they are. The interface says so in `--breach`, and nothing here softens it.
- **A tailnet member you allowlisted.** The gate is the tailnet plus the registry. Anyone you admit is inside the model, not outside it.
- **A compromised browser or device.** Plaintext and the master key exist in the client by construction. An extension in the app's origin, or malware on the machine, reads both.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🗺 Status

Built task by task from [the implementation plans](./docs/superpowers/plans/), against [the design spec](./docs/superpowers/specs/2026-08-15-airlock-design.md).

**Phase 1, tasks 1 to 12, is done.** The content-addressed foundation: send and receive end to end, with dedup, delta sync and resume, behind the identity gate.

**Phase 2** is where it is now.

| # | Task | State |
| --- | --- | --- |
| 13 | Scope inbox, history and deletion to the caller | ✅ Done |
| 14 | Web Push | ✅ Done |
| 15 | Thumbnails | ✅ Done |
| 16 | Devices view and pairing | ✅ Done |
| 17 | History view | ✅ Done |
| 18 | PWA install, share target and file handlers | ✅ Done |
| 19 | Server-sent events and a live inbox | ✅ Done |
| 20 | Relays | ❌ Cancelled |
| 21 | Android shell | ❌ Cancelled |
| 22 | Throughput benchmark and the plaintext toggle | ✅ Done |
| 23 | Deployment and hardening | ✅ Done |

Two tasks were cancelled outright rather than deferred.

**Relays** were specified as mirroring whole transfers to a second instance. Content no longer rests on a server, so there is nothing to mirror, and presence plus signalling already let devices on different instances find each other and connect directly. Nothing is lost by dropping it.

**The Android shell** existed for one capability a web app cannot provide: writing a received file to disk with the app closed. Its price was a second implementation of the crypto, and drift between two implementations does not fail loudly, it produces files that download successfully and will not open. Notification then tap costs a second and buys exactly one place where encryption happens.

**Designed, not yet built,** tasks 24 to 41: declining a transfer, rich notifications with accept and decline, staged send and the Windows context menu, presence and signalling, the queue and the progress bitmap, local staging, the direct channel, session orchestration, hold-for-me as the one server-storage path, the screen wake lock, parallel connections with fragmentation, parallel sealing in a single pass over the file, the throughput measurement, running with no flags anywhere, Windows file sharing, installing it anywhere, verifying what is still unverified, and accepting dropped folders.

**Deliberately not built:** accounts, sharing outside your own tailnet, public links, and any server-side view of plaintext.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🔗 Links

- [Design spec](./docs/superpowers/specs/2026-08-15-airlock-design.md) - architecture, security model, wire protocol
- [Visual design spec](./docs/superpowers/specs/2026-08-15-airlock-visual-design.md) - palette, type, and the two signal colors
- [Benchmarks](./docs/benchmarks.md) - what was measured, on what, and what is still open
- [Implementation plans](./docs/superpowers/plans/) - every task, with its tests
- [Tailscale HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) - the prerequisite everything depends on
- [Web Share Target](https://developer.mozilla.org/en-US/docs/Web/Manifest/share_target) - how the Android share sheet entry works
- [File Handling API](https://developer.mozilla.org/en-US/docs/Web/API/Window/launchQueue) - how the Windows Open with entry works

<div align="right">

[![][back-to-top]](#readme-top)

</div>

<!-- LINK GROUP -->

[back-to-top]: https://img.shields.io/badge/-BACK_TO_TOP-151515?style=flat-square
[client-link]: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps
[client-shield]: https://img.shields.io/badge/client-PWA-8A9A93?labelColor=black&style=flat-square
[crypto-link]: #-threat-model
[crypto-shield]: https://img.shields.io/badge/at%20rest-AES--256--GCM-4FD1A5?labelColor=black&style=flat-square
[deps-link]: #-architecture
[deps-shield]: https://img.shields.io/badge/go%20deps-2-8A9A93?labelColor=black&style=flat-square
[go-link]: https://go.dev
[go-shield]: https://img.shields.io/badge/go-1.26-00ADD8?labelColor=black&logo=go&logoColor=white&style=flat-square
[tailscale-link]: https://tailscale.com/kb/1244/tsnet
[tailscale-shield]: https://img.shields.io/badge/tailscale-tsnet-242424?labelColor=black&logo=tailscale&logoColor=white&style=flat-square
