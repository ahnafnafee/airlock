<a name="readme-top"></a>

<div align="center">

<img height="120" src="./docs/assets/logo.svg" alt="Airlock">

<h1>Airlock</h1>

**Self-hosted, end-to-end encrypted file transfer between your own devices.**<br/>
One Go binary, an installable web app, and your Tailscale network. No accounts, no cloud, no public port.

[![][license-shield]][license-link]
[![][go-shield]][go-link]
[![][tailscale-shield]][tailscale-link]
[![][crypto-shield]][crypto-link]
[![][client-shield]][client-link]
[![][deps-shield]][deps-link]

[Quick start](#-quick-start) · [Why](#-why-airlock) · [Install](#-install) · [How it works](#-how-it-works) · [Security](#-security) · [FAQ](#-faq)

</div>

> \[!NOTE]
>
> Airlock works end to end today: send, receive, notify, save. It is a personal
> project under active development, and [Status](#-status) is explicit about
> which platforms have been verified on real hardware and which have not.

---

## ⚡ Quick start

Three steps, about two minutes. You need [Tailscale](https://tailscale.com) on
at least two devices and [HTTPS certificates enabled](https://tailscale.com/kb/1153/enabling-https)
on your tailnet.

**1. Download** the binary for your machine from
[Releases](https://github.com/ahnafnafee/airlock/releases), or build it:

```bash
go build -o airlock .
```

**2. Run it** on the machine that will hold your transfers:

```bash
./airlock
```

It prints the one URL that works:

```
open https://your-machine.your-tailnet.ts.net/ on any device on your tailnet
```

**3. Open that URL** on any device on your tailnet. Choose a passphrase on the
first device, enter the same one on the others, and send a file.

That is the whole setup. No account, no port forwarding, no DNS record, no
certificate to manage.

<details>
<summary><kbd>Port 443 already taken?</kbd></summary>

<br/>

Common if you already run `tailscale serve`. Pick any free port:

```bash
./airlock --port 9443
```

The startup line will show the new URL. Everything else is unchanged.

</details>

<details>
<summary><kbd>Just want to try it without Tailscale?</kbd></summary>

<br/>

There is a local mode for development. It is not for daily use: it has no device
identity, so anyone who reaches the address and holds the token is you.

```bash
AIRLOCK_TOKEN=devtoken ./airlock --auth token --addr 127.0.0.1:8080
```

Then open `http://localhost:8080/login?t=devtoken`. Localhost counts as a secure
context even over plain HTTP, so Web Crypto and the service worker both work.

</details>

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🎯 Why Airlock

You already have a private network between your devices. Airlock is the file
transfer app that assumes it.

**The problem.** Moving a large file between your own phone, laptop and desktop
is worse than it should be. Email caps out at 25 MB. Cloud drives upload your
file to a company that can read it, then download it again. AirDrop stops at the
edge of Apple. Taildrop is excellent and has no queue, no history, no browser,
and no way to pick the file up later from a different device. USB sticks are a
walk across the room.

**The approach.** Files are chunked, hashed and sealed **on the sending device**
before anything leaves it. The server stores ciphertext and a list of opaque
ids. It never receives the key, so it cannot read a filename, a size, a
thumbnail or a byte of content, and neither can anyone who takes the disk.

**What that buys you.**

| | |
| --- | --- |
| **No size limit** | Chunked and streamed at both ends. A 20 GB file costs the same memory as a 20 MB one. |
| **No accounts** | Tailscale already proved who each device is. There is nothing to sign up for. |
| **No public port** | The listener is bound to your tailnet addresses. It is not on the internet. |
| **Deduplicated** | Send the same file twice and the second send uploads nothing. |
| **Delta sync** | Edit one part of a large file and only the changed chunks move. |
| **Resumable** | A dropped connection resumes where it stopped, not at zero. |
| **Offline capable** | An installable web app on every platform, including a Home Screen app on iOS. |
| **One binary** | Two Go dependencies. No database, no Redis, no Docker required, no build step for the client. |

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📦 Install

### From a release

Prebuilt binaries for **Linux, macOS and Windows** on **amd64 and arm64** are
attached to every [release](https://github.com/ahnafnafee/airlock/releases),
with SHA-256 checksums.

```bash
# Linux or macOS. Replace the version and platform with the ones you want.
curl -LO https://github.com/ahnafnafee/airlock/releases/latest/download/airlock_v0.1.0_linux_amd64
curl -LO https://github.com/ahnafnafee/airlock/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
chmod +x airlock_v0.1.0_linux_amd64
./airlock_v0.1.0_linux_amd64 --version
```

### From source

Go 1.26 or newer. The web client is embedded into the binary, so there is no
separate build step and no bundler.

```bash
git clone https://github.com/ahnafnafee/airlock.git
cd airlock
go build -o airlock .
```

### Prerequisites

1. **Tailscale on every device you want to use.** [Install it](https://tailscale.com/download).
2. **HTTPS certificates enabled** for your tailnet, on the DNS page of the
   [admin console](https://login.tailscale.com/admin/dns). Airlock needs a real
   certificate because the browser needs a secure context: without one there is
   no Web Crypto and no service worker, and the client cannot work at all.
3. **MagicDNS on the devices that will open the app**, so the tailnet name
   resolves. On the machines running Tailscale this is `tailscale set
   --accept-dns=true`; in the mobile apps it is a switch in settings.

### Running as a service

<details>
<summary><kbd>systemd (Linux)</kbd></summary>

<br/>

Airlock reads the `tailscaled` local API socket, which needs no special grant,
and fetches its TLS certificate through the daemon, which does. This is the
supported way to give that to one non-root user:

```bash
sudo tailscale set --operator=$USER
```

Then:

```ini
# /etc/systemd/system/airlock.service
[Unit]
Description=Airlock
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=airlock
ExecStart=/usr/local/bin/airlock --data /var/lib/airlock
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now airlock
```

</details>

<details>
<summary><kbd>Windows</kbd></summary>

<br/>

Run it from a scheduled task set to start at logon, or from a terminal while you
need it. Airlock stores its data under `%LOCALAPPDATA%\Airlock` by default.

```powershell
.\airlock.exe --port 9443
```

</details>

A full walkthrough for a VPS plus a phone, including the parts that are easy to
get wrong, is in [docs/deployment.md](./docs/deployment.md).

### Options

| Flag | Default | What it does |
| --- | --- | --- |
| `--port` | `443` | HTTPS port on the tailnet address |
| `--data` | platform default | Where chunks, transfers and keys live |
| `--ttl-hours` | `24` | Hours of inactivity before a transfer is swept |
| `--max-total` | `200 GiB` | Ceiling on stored ciphertext |
| `--max-chunk` | `16 MiB` | Ceiling on one chunk |
| `--require-approval` | off | Hold new devices until an approved device admits them |
| `--allow-users` | node owner | Comma-separated tailnet logins allowed |
| `--allow-nodes` | any | Comma-separated device names allowed |
| `--tailscale-mode` | `host` | `host` uses the machine's daemon; `embedded` joins as its own node |
| `--auth` | `tailscale` | `tailscale` or `token` |
| `--version` | | Print the version and exit |

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🔧 How it works

### Sending

The sending device does all the work that matters.

1. **Chunk.** The file is cut with content-defined chunking, so boundaries
   follow the content rather than a fixed offset. Insert a byte near the start
   of a file and every later boundary stays where it was, which is what makes
   delta sync work.
2. **Identify.** Each chunk gets an id derived from its content *and* your
   master key. Two devices with the same passphrase agree on ids, so dedup and
   delta sync work across your devices. Nobody without the key can confirm a
   guess about what a chunk contains.
3. **Ask.** The server is asked which of those ids it already has. Its answer
   decides what gets uploaded, and that single question is dedup, delta sync and
   resume at once.
4. **Seal.** Only the missing chunks are encrypted with AES-256-GCM and
   uploaded, four in flight, with bounded retry.
5. **Announce.** The sealed name, size and thumbnail land last. That record is
   what tells the other device something has arrived.

### Receiving

The recipient reads the sealed chunk list, fetches what it needs, verifies every
chunk's tag, and decrypts into a single file on disk. A chunk that was
substituted or corrupted fails there rather than producing a plausible wrong
file.

Saving then walks a cascade and takes the best rung the browser actually
supports: a real save dialog where one exists, the share sheet on an iOS Home
Screen app, and a download as the floor.

### The chunk strip

The interface element Airlock is built around. One segment per chunk, positioned
where that chunk sits in the file and drawn at its real width. Green is a chunk
that is already here, amber is one in transit. Editing the middle of a large
file and sending it again shows a strip that is almost entirely green with a
band of amber where the change was, which is delta sync made visible rather than
claimed.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🔒 Security

| Layer | Protects against | Mechanism |
| --- | --- | --- |
| Reachability | The public internet | Tailnet node, MagicDNS name, no public port |
| Identity | An unauthorized tailnet device | Tailscale `WhoIs`, plus user and node allowlists |
| Approval | A device you have not admitted | Optional per-device approval, off by default |
| Revocation | A lost or stolen device | Registry read on every request, no restart needed |
| Content | The server, its disk, its backups | AES-256-GCM under a key derived on your devices |
| Names | Metadata leaking to the server | Filename, size and thumbnail are sealed records |
| Integrity | A substituted or corrupted chunk | Every chunk is tag-verified during assembly |
| Transport | Anyone on the path | Tailscale WireGuard, plus a real TLS certificate |

**The key never leaves your devices.** It is derived from your passphrase with
PBKDF2-SHA256 at 600,000 iterations against a per-server salt, and stored in
your browser's origin-private storage.

### What Airlock does not protect against

Stated plainly, because a security list that only lists wins is not a threat
model.

- **A compromised device.** If someone has your unlocked phone, they have your
  files. Nothing here changes that.
- **A forgotten passphrase.** There is no recovery. No account, no reset link,
  no escrow. That is the cost of the server never having your key.
- **Traffic analysis by the server operator.** If you do not control the server,
  it still learns which device sent how many bytes to which device and when.
- **A malicious tailnet member.** Airlock trusts your tailnet's ACLs. Use
  `--allow-users` and `--require-approval` on a shared tailnet.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## ❓ FAQ

<details>
<summary><kbd>How is this different from Taildrop?</kbd></summary>

<br/>

Taildrop is excellent and already installed on your devices. Reach for it first
for a quick one-off.

Airlock adds what Taildrop does not have: a queue that survives a device being
asleep, a transfer history, dedup and delta sync so a resend costs almost
nothing, an inbox you can open from any device including one that was not
present when the file was sent, thumbnails, and a browser interface on platforms
where the Tailscale client's share integration is limited.

</details>

<details>
<summary><kbd>Does the server see my files?</kbd></summary>

<br/>

No. Files are sealed on the sending device before anything is uploaded, with a
key derived from your passphrase that is never sent anywhere. The server stores
ciphertext and a list of opaque ids. Filenames, sizes and thumbnails are sealed
records, not plain fields.

This holds even if the server is a VPS you rent, and even if someone takes its
disk.

</details>

<details>
<summary><kbd>What if I lose my passphrase?</kbd></summary>

<br/>

Your transfers are unrecoverable. There is no reset, because there is nobody
holding a copy of the key to reset it with. Wipe the server's data directory and
start again with a new passphrase.

</details>

<details>
<summary><kbd>Do I need a VPS?</kbd></summary>

<br/>

No. Any machine on your tailnet that is usually on will do: a desktop, a home
server, a Raspberry Pi. A VPS helps only if none of your machines are reliably
awake when you want to send something.

</details>

<details>
<summary><kbd>Can I use it on iPhone or Android?</kbd></summary>

<br/>

Yes, through the browser, and it installs to the Home Screen as an app.

On iOS, install it to the Home Screen before setting your passphrase. A tab and
an installed app have separate storage, so a passphrase entered in the tab does
not exist in the app.

For notifications with the app closed, Chrome on Android is the more reliable
choice: it receives push through Google Play Services, which is a system process
that survives the browser being closed. Firefox for Android maintains its own
push connection, so notifications stop arriving if Firefox is not running.

</details>

<details>
<summary><kbd>Why is there no relay or peer-to-peer mode?</kbd></summary>

<br/>

There was one, over WebRTC, and it was removed after measurement. It moved
11 to 19 MB/s against 43 to 53 MB/s through the server, so the path kept for
speed was four times slower than the one it was an alternative to. It also
needed both devices awake at the same instant, needed WebRTC to be enabled at
all, which VPN clients and privacy extensions disable, and on a tailnet it
needed a STUN server to rediscover an address WireGuard had already assigned.

Tailscale is already the peer-to-peer layer. Running NAT traversal on top of an
established WireGuard tunnel is the same job done twice.

</details>

<details>
<summary><kbd>Is my data safe if the server is compromised?</kbd></summary>

<br/>

The content is. An attacker with full access to the server gets ciphertext,
chunk ids, device names, transfer sizes and timestamps. They cannot decrypt
anything without a passphrase that never reached the machine.

They can delete transfers and deny service, which is worth knowing.

</details>

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🏗 Architecture

```
┌──────────────┐        sealed chunks + sealed records        ┌──────────────┐
│  Sending     │ ──────────────────────────────────────────▶  │  Airlock     │
│  device      │                                              │  server      │
│              │  chunk · hash · seal · upload what is new    │              │
└──────────────┘                                              │  ciphertext  │
                                                              │  opaque ids  │
┌──────────────┐        fetch · verify · decrypt · save       │  no key      │
│  Receiving   │ ◀──────────────────────────────────────────  │              │
│  device      │                                              └──────────────┘
└──────────────┘                                                     ▲
                                                                     │
                                                   Tailscale WhoIs ──┘
                                                   proves every caller
```

| Piece | What it is |
| --- | --- |
| Server | One Go binary. Two dependencies: Tailscale and a Web Push library. |
| Storage | Content-addressed files on disk. No database. |
| Client | Vanilla ES modules and plain CSS, embedded with `//go:embed`. No framework, no bundler, no CDN. |
| Crypto | Web Crypto in the browser. AES-256-GCM, HKDF, PBKDF2. |
| Workers | Sealing, staging and assembly run off the page thread. |

More detail, including the wire protocol, is in the
[design spec](./docs/superpowers/specs/2026-08-15-airlock-design.md).

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📊 Measured

Full method, machine and caveats in [docs/benchmarks.md](./docs/benchmarks.md).

| Phase | Throughput |
| --- | --- |
| Sealing (AES-256-GCM) | ~304 MB/s |
| Chunking | ~1.09 GB/s |
| Server chunk store | ~550 MB/s |
| Upload, end to end | 43 to 53 MB/s |
| Download, end to end | 66 to 109 MB/s |
| Assembly | ~104 MB/s |

**Sealing is not the bottleneck.** It costs 0.572 ms per MiB more than the
plaintext control, and four chunks in flight hide almost all of it. There is no
option to turn encryption off, because measurement said it would buy nothing.

Numbers are from one desktop (i9-14900K). A phone is the thinner case and the
common sending device, and that measurement is still open.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## ⌨️ Development

```bash
go test ./...              # server
node --test web/*.test.mjs # client, no dependencies
go build -o airlock .      # the client is embedded, so this is the whole build
```

The client has **no build step and no package.json**. Tests run on Node's built
in test runner. Every CSS or JS edit needs `go build` to take effect, because
the client ships inside the binary.

CI runs the full suite on Linux, macOS and Windows for every push.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🗺 Status

**Working end to end:** sending, receiving, dedup, delta sync, resume across a
dropped connection, transfer history, thumbnails, device pairing and approval,
recipient picker, push notifications, background receive, save on arrival, and
the installable app on Windows and Android.

**Verified on real hardware:** Windows (Chrome, Edge, Firefox), Android 16
(Chrome, Firefox), and a two-device tailnet.

**Not yet verified:** iOS and macOS Safari, Linux, and any non-Chromium and
non-Gecko engine. Those paths are written and unit tested and have not been run
on the hardware.

**Known limits:** resume across a full page reload is deferred. A transfer
interrupted by closing the tab restarts from the last confirmed chunk rather
than the last byte.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📄 License

[MIT](./LICENSE). Do what you like with it.

## 🔗 Links

- [Design spec](./docs/superpowers/specs/2026-08-15-airlock-design.md) - architecture, security model, wire protocol
- [Visual design spec](./docs/superpowers/specs/2026-08-15-airlock-visual-design.md) - palette, type, and the two signal colors
- [Benchmarks](./docs/benchmarks.md) - what was measured, on what, and what is still open
- [Deployment guide](./docs/deployment.md) - a VPS and a phone, end to end
- [Tailscale HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) - the prerequisite everything depends on
- [Taildrop][taildrop-link] - the simpler tool, already on your devices

<div align="right">

[![][back-to-top]](#readme-top)

</div>

<!-- LINK GROUP -->

[back-to-top]: https://img.shields.io/badge/-BACK_TO_TOP-151515?style=flat-square
[client-link]: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps
[client-shield]: https://img.shields.io/badge/client-PWA-8A9A93?labelColor=black&style=flat-square
[crypto-link]: #-security
[crypto-shield]: https://img.shields.io/badge/at%20rest-AES--256--GCM-4FD1A5?labelColor=black&style=flat-square
[deps-link]: #-architecture
[deps-shield]: https://img.shields.io/badge/go%20deps-2-8A9A93?labelColor=black&style=flat-square
[go-link]: https://go.dev
[go-shield]: https://img.shields.io/badge/go-1.26-00ADD8?labelColor=black&logo=go&logoColor=white&style=flat-square
[license-link]: ./LICENSE
[license-shield]: https://img.shields.io/badge/license-MIT-4FD1A5?labelColor=black&style=flat-square
[taildrop-link]: https://tailscale.com/kb/1106/taildrop
[tailscale-link]: https://tailscale.com/kb/1244/tsnet
[tailscale-shield]: https://img.shields.io/badge/tailscale-tsnet-242424?labelColor=black&logo=tailscale&logoColor=white&style=flat-square
