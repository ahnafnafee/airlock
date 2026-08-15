<a name="readme-top"></a>

<div align="center">

<img height="120" src="./docs/assets/logo.svg" alt="Airlock">

<h1>Airlock</h1>

End-to-end encrypted file transfer between your own devices, gated by Tailscale.<br/>
One Go binary, one installable web app, no native clients.

[![][go-shield]][go-link]
[![][tailscale-shield]][tailscale-link]
[![][crypto-shield]][crypto-link]
[![][client-shield]][client-link]
[![][deps-shield]][deps-link]

[Features](#-features) · [Installation](#-installation) · [Architecture](#-architecture) · [Threat model](#-threat-model) · [Status](#-status)

</div>

> \[!IMPORTANT]
>
> Airlock is under active construction. The store layer is in; the HTTP layer, the web client, and deployment are being built task by task. See [Status](#-status) for exactly where it is.

<details>
<summary><kbd>Table of contents</kbd></summary>

#### TOC

- [✨ Features](#-features)
  - [`1` Sealed at rest](#1-sealed-at-rest)
  - [`2` Verified by Tailscale](#2-verified-by-tailscale)
  - [`3` Installs like an app](#3-installs-like-an-app)
  - [`4` Deduplicated, delta-synced, resumable](#4-deduplicated-delta-synced-resumable)
  - [`5` One shared inbox](#5-one-shared-inbox)
- [📦 Installation](#-installation)
- [⌨️ Local Development](#️-local-development)
- [🏗 Architecture](#-architecture)
- [🔒 Threat model](#-threat-model)
- [🗺 Status](#-status)
- [🔗 Links](#-links)

<br/>

</details>

## ✨ Features

Airlock is what remains of a peer-to-peer file transfer app once you assume Tailscale. NAT traversal, transport encryption, and cryptographic device identity are already solved, so the interesting parts are the two that are left: a place to leave bytes when the other device is asleep, and a client good enough that you never think about it.

### `1` Sealed at rest

Files are encrypted in the browser before a single byte is uploaded. The server holds ciphertext and metadata, and that is all it can ever hold. It does not learn the filename, the MIME type, or the contents, because the key is derived from a passphrase that never leaves your devices.

Chunks are sealed with AES-256-GCM, and each chunk's position and its file's total chunk count are bound into the authenticated data. That detail is load bearing. Independently encrypted GCM chunks without it can be reordered, truncated, or spliced between files while every individual chunk still authenticates perfectly.

| The server sees | The server never sees |
| --- | --- |
| Blob id, uploading node | Filename |
| Chunk count, ciphertext sizes | MIME type |
| Timestamps | One byte of content |

<div align="right">

[![][back-to-top]](#readme-top)

</div>

### `2` Verified by Tailscale

Airlock joins your tailnet as its own node through `tsnet`, rather than hiding behind a reverse proxy. One dependency buys three things at once:

- A `*.ts.net` TLS certificate every device already trusts, with no warnings and no CA to install
- A hostname that resolves only on your tailnet, through MagicDNS
- `WhoIs()` on every single request, returning the WireGuard-verified node and user behind the connection

That last one is the actual authorization primitive, and nothing outside your tailnet can forge it. Every route is gated, static assets included. There is deliberately no unauthenticated path.

A `--auth=token` mode exists for a LAN without Tailscale. It is a degraded fallback and the docs say so plainly, because plain HTTP is not a secure context and half the client stops working there.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

### `3` Installs like an app

Because the Tailscale certificate makes the page a genuine secure context, the web client is not a compromise. It installs, it gets its own icon and window, and it can do the things people actually want from a transfer app:

- **Android share sheet.** Share a photo from Gallery, pick Airlock, done. This is the affordance people use most, and it costs one manifest entry.
- **Web Push.** A file lands and your desktop notifies you with the real filename, decrypted locally, because the push itself carries no payload to leak.
- **Windows file handling.** Right-click a file, Open with, Airlock. Or drag it onto the window.
- **Launch at login**, so it is simply always there.

No native Android app. No native Windows app. Airlock is browser-only on purpose: a native shell was designed for one capability the PWA cannot provide, writing a received file to disk with the app closed, and cut because its price was a second implementation of the crypto. Two implementations of a cipher drift, and drift there does not fail loudly, it produces files that download successfully and will not open. Notification-then-tap costs a second and buys exactly one place where encryption happens.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

### `4` Deduplicated, delta-synced, resumable

Files are split by content, not by offset. Each chunk is stored under an id derived from its own bytes, which means one question answers four features at once: *which of these ids do you already have?*

| You get | Because |
| --- | --- |
| **Dedup** | Identical chunks produce identical ids, so the server stores one copy |
| **Delta sync** | An edited file shares most ids with its old version, so only the changed parts upload |
| **Resume after a drop** | Ask which ids are present, send the rest |
| **Resume after a reload** | The same question. Re-chunking is deterministic, so no client state has to survive |

That last row is why the design is worth its complexity. Nothing is persisted in the browser to make resume work: close the tab mid-upload, reopen, pick the same file, and it continues.

Boundaries come from a rolling hash rather than fixed offsets, because fixed offsets defeat delta sync entirely: inserting one byte at the front shifts every later boundary and invalidates every chunk.

Downloads are handled by the service worker, which fetches, decrypts, and hands the browser a streaming response with a real `Content-Disposition`. The browser saves it natively, with its own progress bar, streaming to disk. A 20 GB file never sits in memory, on either end.

The honest cost: a host that compromises the box learns which chunks repeat within and across your transfers. That leak is inherent to dedup in a zero-knowledge system, and it is the price of this whole section.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

### `5` One shared inbox

You do not pick a recipient. Anything you send appears on every device you own, and you pick it up wherever you happen to be sitting.

This deletes the device registry, the recipient picker, per-device delivery tracking, and the "which of my eight devices was that" problem. Blobs expire on a TTL measured from their last write, so a long upload is never swept mid-flight and a finished transfer clears itself out.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📦 Installation

Two things must be enabled in the Tailscale admin console, under Settings then Features:

- **MagicDNS**, or the server's hostname does not resolve.
- **HTTPS Certificates**, or there is no trusted certificate, therefore no secure context, therefore no install, push, share target, or download. Airlock does not work without this one.

You also need a reusable auth key for the server node.

```bash
go build -o airlock .
scp airlock your-server:/usr/local/bin/
scp deploy/airlock.service your-server:/etc/systemd/system/
```

On the server:

```bash
sudo useradd --system --home /var/lib/airlock airlock
sudo mkdir -p /var/lib/airlock && sudo chown airlock /var/lib/airlock
sudo -u airlock AIRLOCK_TOKEN= TS_AUTHKEY=tskey-auth-... /usr/local/bin/airlock --data /var/lib/airlock
# once the node joins the tailnet, stop it and hand over to systemd
sudo systemctl enable --now airlock
```

Airlock is then at `https://airlock.<your-tailnet>.ts.net`.

Open it on any device and choose a passphrase. Every other device enters the same one. It is never sent to the server: it derives an AES key that stays in that device's IndexedDB. Lose it and you lose whatever is still in the inbox, which is at most one TTL window.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--auth` | `tailscale` | `tailscale` or `token` |
| `--data` | `./data` | data directory |
| `--tailscale-mode` | `host` | `host` serves through the machine's tailscaled, `embedded` joins as its own tsnet node |
| `--hostname` | `airlock` | node name, embedded mode only |
| `--allow-users` | node owner | comma-separated tailnet logins |
| `--allow-nodes` | any | comma-separated node names |
| `--require-approval` | off | hold new devices until an approved device admits them |
| `--max-chunk` | 16 MiB | maximum bytes per chunk |
| `--max-total` | 200 GiB | maximum bytes stored across all chunks |
| `--ttl-hours` | 24 | inactivity before a transfer is swept |
| `--addr` | `127.0.0.1:8080` | listen address, token mode only |

`host` is the default because embedded `tsnet` is in-process userspace netstack with no kernel TUN, and therefore misses the TSO, GRO, GSO and `mmsg()` work that got Tailscale's userspace WireGuard past 10 Gb/s. That work lives in the daemon. An [open upstream issue](https://github.com/tailscale/tailscale/issues/9707) reports tsnet running roughly 8 to 9 times slower. Embedded mode stays available for a host with no Tailscale installed.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## ⌨️ Local Development

Go 1.26 or later and Node 22 or later. There is no frontend build step and no bundler, so what you edit is what the browser runs.

```bash
git clone https://github.com/ahnafnafee/airlock.git
cd airlock

go vet ./...
go test ./...
node --test web/crypto.test.mjs
```

To run against localhost without a tailnet:

```bash
AIRLOCK_TOKEN=devtoken go run . --auth=token --data ./devdata
```

Then open `http://localhost:8080/login?t=devtoken`. Localhost counts as a secure context even over plain HTTP, so Web Crypto and the service worker both work in development.

The three checks that matter most, because these are the ones whose failure looks like success:

1. `node --test web/crypto.test.mjs` must reject reordered, truncated, and spliced chunks. If any of them decrypt, files can be tampered with undetectably.
2. A chunk file on the server must be unreadable. If `cat` shows your file, encryption is not actually in the path.
3. A non-allowlisted tailnet node must get 403 on every route, static assets included.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🏗 Architecture

```
  Phone                            Server                       Desktop
  Chrome PWA                       airlock                      Chrome PWA
      |                        (tsnet node, Go)                     |
      |     https://airlock.<tailnet>.ts.net                        |
      +-------------------- WireGuard / TLS ------------------------+
                                    |
                        data/blobs/<id>/{meta.json,0,1,2,...}
                        ciphertext only
```

Store and forward, not peer to peer. The receiver may be asleep, so bytes wait on the server, which means both clients are pure HTTP clients. That single decision is why no native app is required.

| File | Responsibility |
| --- | --- |
| `main.go` | Flags, listener selection, wiring, sweep loop |
| `tailscale.go` | Tailnet identity and TLS, in host and embedded modes |
| `server.go` | HTTP handlers, identity gate, request validation |
| `chunkstore.go` | Content-addressed ciphertext, quotas, mark-and-sweep |
| `transfers.go` | Transfer records, recipient-filtered inbox, history |
| `devices.go` | Device registry, live allowlist, pairing state |
| `push.go` | VAPID keys, subscriptions, targeted delivery |
| `web/cdc.js` | Content-defined chunk boundaries |
| `web/crypto.js` | Key hierarchy, convergent sealing, record domains |
| `web/upload.js` | Two-pass upload with dedup negotiation |
| `web/sw.js` | Decrypt-on-download, push, share target |

Exactly two Go dependencies, `tailscale.com` and `webpush-go`. Everything else is standard library. The frontend has zero dependencies.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🔒 Threat model

| Layer | Protects against | Mechanism |
| --- | --- | --- |
| Reachability | The public internet | tsnet node, MagicDNS name, no public port |
| Identity | An unauthorized tailnet device | `WhoIs` plus a node and user allowlist |
| Transport | Passive interception | WireGuard, plus TLS |
| At rest | The host provider, or root on the box | AES-256-GCM in the browser, key never sent |

The caller Airlock is designed against is an authenticated, allowlisted device running `curl`, not the UI. Blob ids are server-generated and the only client string that may reach a filesystem path must match `^[0-9a-f]{32}$`. Chunk indices are bounds-checked before a path is built. Request bodies are capped. Quota is reserved before bytes are accepted, and the store enforces its own write limits rather than trusting the HTTP layer to do it.

Fail closed: if Tailscale cannot come up, or token mode has no token configured, the process exits non-zero. There is no path from a missing credential to an open listener.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🗺 Status

Built task by task from [the implementation plan](./docs/superpowers/plans/2026-08-15-airlock.md), against [the design spec](./docs/superpowers/specs/2026-08-15-airlock-design.md).

**Phase 1** is the content-addressed foundation: send and receive end to end, with dedup, delta sync and resume, behind the identity gate.

| # | Task | State |
| --- | --- | --- |
| 1 | Content-addressed chunk store | ✅ Done |
| 2 | Transfer records, inbox and history | 🟡 In review |
| 3 | Device registry and live allowlist | ⬜ Pending |
| 4 | HTTP core and identity gate | ⬜ Pending |
| 5 | HTTP transfers and chunks | ⬜ Pending |
| 6 | Wiring, flags, sweep loop | ⬜ Pending |
| 7 | Tailscale identity, host and embedded modes | ⬜ Pending |
| 8 | Content-defined chunking | 🟡 In review |
| 9 | Browser crypto, sealed and plaintext | ⬜ Pending |
| 10 | App shell and unlock | ⬜ Pending |
| 11 | Upload with dedup negotiation | ⬜ Pending |
| 12 | Service worker download and inbox | ⬜ Pending |

**Phase 2** adds device pairing and the recipient picker, transfer history, thumbnails, Web Push, a live event stream, PWA install and share target, relays, and the throughput benchmark that settles which Tailscale mode is the default.

**Deliberately not built:** accounts, sharing outside your own tailnet, public links, and any server-side view of plaintext.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🔗 Links

- [Design spec](./docs/superpowers/specs/2026-08-15-airlock-design.md) - architecture, security model, wire protocol
- [Implementation plan](./docs/superpowers/plans/2026-08-15-airlock.md) - the 13 tasks, with their tests
- [Tailscale HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) - the prerequisite everything depends on
- [Web Share Target](https://developer.mozilla.org/en-US/docs/Web/Manifest/share_target) - how the Android share sheet entry works
- [File Handling API](https://developer.mozilla.org/en-US/docs/Web/API/Window/launchQueue) - how the Windows Open with entry works

<div align="right">

[![][back-to-top]](#readme-top)

</div>

<!-- LINK GROUP -->

[back-to-top]: https://img.shields.io/badge/-BACK_TO_TOP-151515?style=flat-square
[client-link]: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps
[client-shield]: https://img.shields.io/badge/client-PWA-5b9dff?labelColor=black&style=flat-square
[crypto-link]: #-threat-model
[crypto-shield]: https://img.shields.io/badge/at%20rest-AES--256--GCM-44cc11?labelColor=black&style=flat-square
[deps-link]: #-architecture
[deps-shield]: https://img.shields.io/badge/go%20deps-2-lightgrey?labelColor=black&style=flat-square
[go-link]: https://go.dev
[go-shield]: https://img.shields.io/badge/go-1.26-00ADD8?labelColor=black&logo=go&logoColor=white&style=flat-square
[tailscale-link]: https://tailscale.com/kb/1244/tsnet
[tailscale-shield]: https://img.shields.io/badge/tailscale-tsnet-242424?labelColor=black&logo=tailscale&logoColor=white&style=flat-square
