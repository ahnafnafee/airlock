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
  - [`4` Resumable, unlimited size](#4-resumable-unlimited-size)
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

No native Android app. No native Windows app. A thin wrapper remains possible later if silent background receive ever matters, and it would reuse the protocol and the entire UI.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

### `4` Resumable, unlimited size

Files are cut into 8 MiB chunks, encrypted one at a time, and uploaded with idempotent writes. Ask the server which chunks it already has, send the rest. A dropped connection, a sleeping laptop, or a flaky uplink costs you the current chunk and nothing more.

Downloads are handled by the service worker, which fetches, decrypts, and hands the browser a streaming response with a real `Content-Disposition`. The browser saves it natively, with its own progress bar, streaming to disk. A 20 GB file never sits in memory, on either end.

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
| `--hostname` | `airlock` | tsnet node name |
| `--allow-users` | node owner | comma-separated tailnet logins |
| `--allow-nodes` | any | comma-separated node names |
| `--chunk-size` | 8 MiB | plaintext chunk size |
| `--max-blob` | 50 GiB | maximum per transfer |
| `--max-total` | 200 GiB | maximum stored at once |
| `--ttl-hours` | 24 | inactivity before a transfer is swept |
| `--addr` | `127.0.0.1:8080` | listen address, token mode only |

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
| `server.go` | HTTP handlers, identity gate, request validation |
| `store.go` | Blob store on disk: create, chunk writes, listing, sweep |
| `push.go` | VAPID keys, subscriptions, notification delivery |
| `web/crypto.js` | Key derivation, chunk sealing, AAD construction |
| `web/app.js` | UI, upload loop, inbox, setup |
| `web/sw.js` | Decrypt-on-download, push handling, share target |

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

| # | Task | State |
| --- | --- | --- |
| 1 | Blob store, write path | 🟡 In review |
| 2 | Blob store, read and lifecycle | ⬜ Pending |
| 3 | HTTP core, identity gate and config | ⬜ Pending |
| 4 | HTTP blob endpoints | ⬜ Pending |
| 5 | Wiring, flags, token mode, sweep loop | ⬜ Pending |
| 6 | Tailscale identity, TLS and allowlist | ⬜ Pending |
| 7 | Browser crypto module | ⬜ Pending |
| 8 | Setup flow and upload | ⬜ Pending |
| 9 | Service worker download | ⬜ Pending |
| 10 | Inbox | ⬜ Pending |
| 11 | Web Push | ⬜ Pending |
| 12 | PWA install, share target, file handlers | ⬜ Pending |
| 13 | Deployment | ⬜ Pending |

Airlock becomes genuinely usable at task 9 and feature complete at task 12.

**Deliberately not built:** device pairing UI, recipient picker, transfer history, thumbnails, dedup, delta sync, relays, and accounts. Resume across a full page reload is deferred; resume across network drops ships.

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
