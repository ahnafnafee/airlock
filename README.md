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

[Features](#-features) · [Installation](#-installation) · [VPS + Android guide](./docs/deployment.md) · [Architecture](#-architecture) · [Measured](#-measured) · [Threat model](#-threat-model) · [Status](#-status)

</div>

> \[!IMPORTANT]
>
> Airlock is under active construction, and this file distinguishes what runs from what is designed. Sending, receiving, assembling and saving work end to end through both the direct device-to-device path and the optional server-held path. Platform checks that require macOS, Linux, iOS, Android or two physical tailnet devices remain explicitly unverified. [Status](#-status) says which work is software-complete and which still needs hardware.

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
  - [Docker VPS and Android](#docker-vps-and-android)
  - [Where to run it](#where-to-run-it)
  - [Linux, systemd](#linux-systemd)
  - [macOS, launchd](#macos-launchd)
  - [Windows, a logon task](#windows-a-logon-task)
  - [Embedded mode](#embedded-mode)
  - [Flags](#flags)
  - [Per device](#per-device)
  - [Troubleshooting](#troubleshooting)
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

The honest cost is that some overlap must eventually happen. If the sender never opens the app again, a queued transfer never completes. One escape hatch answers that: **Hold on the server if I go offline**, a per-transfer checkbox on the Send view, off by default. Tick it and the sealed chunks are spooled to the server, so the transfer finishes without the sender ever being reachable again. It is the only path by which content reaches the server, and even then it is ciphertext under a key the server does not have.

Leave it alone, which is the default, and the sealed chunks are written to this device's own staging area instead. The server is told what the transfer is made of and is given the sealed records the recipient needs to read it, and not one byte of content.

A direct transfer has to name a device. It is offered to the devices in **To** and to nobody else, so **All my devices** is a choice only the held path can honor: there the transfer sits in the queue and every device sees it in its own inbox. Ask for both at once and the Send view refuses before anything is sealed, and says which of the two controls to change.

> **Where the code actually is.** Both halves of the direct channel are built: presence, opaque signalling, per-recipient progress bitmaps, local staging, the data channel, session orchestration, authenticated assembly into a disk-backed file, and the browser export cascade. **Hold on the server if I go offline** is now a delivery choice, not a requirement for receiving.

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
- `WhoIs()` on every API request that carries identity or state, returning the WireGuard-verified node and user behind the connection

That last one is the actual authorization primitive, and nothing outside your tailnet can forge it. The app shell and its embedded static assets are intentionally available to any caller that can reach the listener: an unapproved device needs them to render its pairing screen, and a module service worker fetches its script without the session cookie. Those files are identical for every caller and contain no device or transfer state. Every API that does carry state is identity-gated, and every API beyond the pairing status is also checked against the device registry on each request, so revoking a device takes effect on its next call with no restart and no cached decision to expire.

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

Resume here means a network drop while the transfer remains queued. Full-page-reload resume during file preparation is deliberately deferred: once a direct transfer is queued its stage survives a reload, but an interrupted preparation starts again when the file is picked again.

Boundaries come from a rolling hash rather than fixed offsets, because fixed offsets defeat delta sync entirely: inserting one byte at the front shifts every later boundary and invalidates every chunk.

Received chunks are authenticated and decrypted into one disk-backed file in the origin private file system. Export then uses the browser's save picker, a native download, the share sheet, or keeps the file ready for another tap. Assembly stays memory-flat with file size: only a bounded number of chunks are in memory, so a 20 GB file is not buffered as one object.

The honest cost is stated in full under [what this does not protect against](#what-this-does-not-protect-against): equality between chunks is visible to whoever holds them.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

### `5` Installs like an app

Because the Tailscale certificate makes the page a genuine secure context, the web client is not a compromise. It installs, it gets its own icon and window, and it does the things people actually want from a transfer app:

- **The Chromium share sheet.** On Chrome for Android and on ChromeOS, share a photo from Gallery, pick Airlock, and it is staged in the Send view with the recipient picker in reach. Sending stays an explicit action, because a share target that uploaded on arrival would let any page choose what you sent.
- **Web Push.** A file lands and your desktop notifies you with the real filename, decrypted locally, because the push itself carries no payload to leak.
- **Windows file handling.** Right-click any file and choose **Send with Airlock**. The app opens with the file staged, so you pick the destination before anything leaves the machine. **Open with** reaches Airlock too, for the types the manifest names.
- **A live inbox.** An open app is nudged by a server-sent event stream rather than by polling, so an arrival appears without a refresh.

Getting a file *in* is where browsers stop agreeing, so this is stated plainly rather than sold. Airlock accepts files everywhere through the in-app picker, plus drag and drop and paste on desktop browsers. "Share to Airlock" from the OS share sheet is a Chromium-only bonus, available on Chrome for Android and ChromeOS, and as "Open with Airlock" on installed Chrome or Edge desktop. It does not exist in Firefox or on iOS, where you open Airlock and pick the file.

None of those extras is offered on screen until this device has been seen doing it. Firefox for Android reads `share_target` out of the manifest and then ignores it, with no error and nothing a script can test for, so a screen that promised a share menu entry on the strength of the manifest would be lying and nothing would say so. Instead the drop zone appears on the first drag that carries a file, the paste hint on the first paste that carries one, and the share menu is claimed only after a share has actually arrived. Until then the install card says installing *may* add Airlock to the share menu.

The context-menu entry is installed once, on each Windows machine, after installing the app itself:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-context-menu.ps1
```

It writes one per-user registry key pointing at the launcher your browser already created, needs no administrator, and `uninstall-context-menu.ps1` removes it. Nothing is installed but that key: a shell helper that uploaded on its own would need the passphrase, and it would become a second implementation of the encryption. On Windows 11 the entry appears under **Show more options**, where the classic menu lives. Dragging a file onto the window works with no setup at all.

You pick a destination, or leave it at all your devices, which stays the default because it is the common case. Nothing uploads until you press Send, whichever way the file arrived. The recipient list is deliberately plaintext: the server has to route on it, and it reveals only which of your own devices talk to each other.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📦 Installation

Two things must be enabled on the **DNS** page of the Tailscale admin console:

- **MagicDNS**, or the server's hostname does not resolve.
- **HTTPS Certificates**, or there is no trusted certificate, therefore no secure context, therefore no install, push, share target, or download. Airlock does not work without this one.

### Docker VPS and Android

For a complete, copyable path from a fresh Ubuntu VPS through Docker Compose,
the one-time embedded Tailscale enrollment, first-device setup, Android
approval and pairing, direct and held transfer checks, backups, upgrades, and
troubleshooting, follow **[Deploy Airlock on a VPS and add an Android
device](./docs/deployment.md)**.

The container publishes no host port: Airlock joins the tailnet inside the
process and prints the private HTTPS URL to its log. The guide also explains
why a Tailscale sidecar, Serve, Funnel, or an ordinary reverse proxy is not a
drop-in replacement for that layout. Docker's embedded-tailnet path and the
physical Android acceptance checks remain explicitly marked until they are run
on the target VPS and phone.

### Where to run it

**A small VPS is the recommendation, for one reason: a queue is only useful while it is reachable.** A laptop that sleeps is a queue that stops, and the whole point of the server is to hold what one device owes another while that other device is asleep. CPU and memory are not the sizing question. The server moves ciphertext and never decrypts anything, so the smallest instance on offer is enough of both. Disk is the sizing question, because a queued transfer's sealed chunks sit on the server until the recipient collects them or `--ttl-hours` sweeps them. Set `--max-total` under whatever the volume actually holds, and size the volume for the largest thing you expect to have in flight at once.

Nothing in the design needs a VPS, though. **Any always-on machine works**, identically: a home server, a desktop that stays powered, a spare Mac, a small board on the same tailnet. It may even be a machine that is also one of the clients. Pick by uptime, not by hardware.

There is nothing to expose either way. The server joins your tailnet as a node and listens only on its tailnet addresses, so there is no public port to forward and no DNS record to publish. A host firewall that filters per interface still has to admit the tailnet interface, which is the one rule you may need.

```bash
go build -o airlock .

# Or cross-compile for the host from wherever you are. Note the .exe: with an
# explicit -o, the Go toolchain writes exactly the name you give it and does
# not add the suffix for you.
GOOS=linux   GOARCH=amd64 go build -o airlock .
GOOS=darwin  GOARCH=arm64 go build -o airlock .
GOOS=windows GOARCH=amd64 go build -o airlock.exe .
```

Then follow the section for the host's operating system.

### Linux, systemd

```bash
scp airlock your-server:/tmp/
scp deploy/airlock.service your-server:/tmp/
scp deploy/sysctl-airlock.conf your-server:/tmp/
```

On the server:

```bash
sudo useradd --system --home /var/lib/airlock --shell /usr/sbin/nologin airlock
sudo install -m 0755 /tmp/airlock /usr/local/bin/
sudo install -m 0644 /tmp/airlock.service /etc/systemd/system/
sudo install -m 0644 /tmp/sysctl-airlock.conf /etc/sysctl.d/

# Host mode reads the tailscaled local API socket. Reading it needs no grant at
# all. Fetching the TLS certificate does, and this is the supported way to hand
# that to one non-root user.
sudo tailscale set --operator=airlock

sudo sysctl --system          # UDP buffer sizes, see deploy/sysctl-airlock.conf
sudo systemctl daemon-reload
sudo systemctl enable --now airlock
journalctl -u airlock -f
```

The unit's `StateDirectory=` creates `/var/lib/airlock` at mode 0700 owned by that user, so there is no directory to make by hand. The startup line names the mode and the allowed tailnet users, which is worth reading once: it is the only place the server reports which mode answered.

A narrower grant than `--operator` exists. Certificate fetching is the single call that needs more than read access, and `TS_PERMIT_CERT_UID=airlock` in `/etc/default/tailscaled`, followed by `sudo systemctl restart tailscaled`, permits exactly that and nothing else. **Unverified:** that was read out of the daemon's source rather than run. Check it on your own machine with `sudo -u airlock tailscale cert <node>.<tailnet>.ts.net` before relying on it, and fall back to `--operator` if it is refused.

The unit carries `AmbientCapabilities=CAP_NET_BIND_SERVICE` only because port 443 is below 1024. Run with `--port 4443`, or any port above 1024, and both capability lines can be deleted.

In `host` mode Airlock answers on the server machine's own tailnet name, `https://<that-machine>.<your-tailnet>.ts.net`.

### macOS, launchd

`deploy/com.airlock.server.plist` is a LaunchDaemon: `RunAtLoad`, `KeepAlive`, an absolute data path, and no forking, because launchd supervises the process it starts and a program that daemonizes is a program launchd believes has died.

```bash
sudo mkdir -p /usr/local/bin /usr/local/var/airlock
sudo chmod 700 /usr/local/var/airlock
sudo install -m 0755 airlock /usr/local/bin/
sudo install -o root -g wheel -m 0600 deploy/com.airlock.server.plist /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/com.airlock.server.plist

tail -f /var/log/airlock.log /var/log/airlock.err.log
```

Remove it with `sudo launchctl bootout system/com.airlock.server`.

**Nothing in this section was run on macOS.** Two things are worth checking before you count on it, and both are stated as open questions rather than as instructions:

- **Whether your Tailscale build serves the certificate endpoint at all.** The App Store and Standalone variants may not. If they do not, host mode has no TLS on that Mac, therefore no secure context, therefore no installed app, push, share target or download. The check is one command, run as the user Airlock will run as: `tailscale cert <node>.<tailnet>.ts.net`. If it is refused, use a Tailscale package that does serve it, or run in embedded mode, which carries its own node and its own certificate.
- **Whether a specific-address bind on port 443 still needs root.** Mojave lifted the reserved-port restriction for wildcard binds, and Airlock binds the machine's own tailnet addresses on purpose so the listener is never reachable from the LAN. Do not switch to a wildcard bind to dodge this: that gives away the property the specific bind exists for. A LaunchDaemon runs as root, so the question does not arise for the shipped file, and `--port 4443` retires it entirely.

**App Store Tailscale needs a LaunchAgent instead of a daemon.** That build discovers its API token per GUI user, and root cannot see it, so a daemon cannot reach the local API at all. Put the same file in `~/Library/LaunchAgents`, point the data path somewhere the user owns, and load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.airlock.server.plist`. An agent runs only while that user is logged in, which is the price of the variant.

### Windows, a logon task

```powershell
go build -o airlock.exe .
.\deploy\windows\install-service.ps1            # add -Port 4443 if 443 is taken
```

The script looks for `airlock.exe` beside the repository root and refuses if it is not there. Pass `-ExePath` to run it from anywhere else, `-DataDir` to put the store somewhere other than `%LOCALAPPDATA%\Airlock`, and `-TaskName` to name the task something other than `Airlock`.

No elevation, and no Windows service. `Register-ScheduledTask -AtLogOn` succeeds from an ordinary prompt where `schtasks /sc onlogon` is refused, and a real service would need both elevation and the Service Control Manager protocol implemented inside the binary. A plain console program registered as a service starts, never reports back to the SCM, and is killed with error 1053. Airlock does not speak that protocol, so it is not offered as one.

The script bind-tests the port before it registers anything, and refuses with the port number and the reason if something already holds it. That check is a real bind rather than a look at `netsh`, because the failure that actually bites on Windows is a holder using exclusive addressing, which Winsock reports as access denied rather than as address in use, and the listener table does not distinguish them.

**The limitation to expect:** an Interactive principal is what lets the task register without elevation, and it ties Airlock to your logged-on session. It starts at logon, and it is not expected to survive logoff, so the queue would be unreachable while nobody is signed in. That behavior was not measured, so verify it on your own machine if uptime across logoff matters. Running before anyone logs in is a different install: one elevated registration against a service account, which the script deliberately does not do. This is the strongest argument for the VPS.

Remove it with `.\deploy\windows\uninstall-service.ps1`, which stops and unregisters the task and leaves the data directory alone.

### Embedded mode

The two modes do not share a URL. `host` answers on the machine's own tailnet name; `embedded` joins as its own node named by `--hostname`, so it answers on `https://airlock.<your-tailnet>.ts.net` instead.

`TS_AUTHKEY` belongs to embedded mode and to nothing else. Host mode never reads it, so setting it alongside the default `--tailscale-mode=host` does nothing at all. On systemd the two changes travel together:

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

The key is needed only the first time the node comes up. After that the node's own state lives under `<data>/tsnet`.

Open the URL on any device and choose a passphrase. Every other device enters the same one. It is never sent to the server: it derives a key that stays in that device's IndexedDB, and the server holds only a verifier sealed under it, so a wrong passphrase fails loudly on the next device instead of quietly filling an inbox with records nothing can open.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--auth` | `tailscale` | `tailscale` or `token` |
| `--data` | per platform | data directory. `%LOCALAPPDATA%\Airlock`, `~/Library/Application Support/Airlock`, or `$XDG_DATA_HOME/airlock` falling back to `~/.local/share/airlock` |
| `--tailscale-mode` | `host` | `host` serves through the machine's tailscaled, `embedded` joins as its own tsnet node |
| `--port` | `443` | HTTPS port on the tailnet address. Raise it when something else holds 443 |
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

Tailnet mode is chosen with `--tailscale-mode`, and the flag defaults to `host`, so a server started without it is a host-mode server. Every deploy file here passes an absolute `--data`, because a service manager hands the process no useful working directory: a scheduled task starts in System32 and a launch daemon starts in `/`, and a relative path there creates a fresh salt and an empty store, which reads as data loss rather than as a path mistake.

### Per device

**Windows and macOS, Chrome or Edge.** Open the URL and install from the address bar. It gets its own window and icon. Right-click any file and choose **Send with Airlock**, or drag it onto the window.

**Android, Chrome.** Add to Home screen, then verify that Airlock appears in the
share sheet. The manifest implements that integration, but the physical-device
check is still open. The [VPS and Android guide](./docs/deployment.md#6-add-and-register-an-android-phone)
walks through both Tailscale approval and Airlock's separate approval and
passphrase steps.

**Android, Firefox.** The implemented fallback is the in-app picker, and the
physical Android check is still open. Firefox for Android offers no install,
never puts Airlock in the share sheet however the manifest is written, and does
not hand a pasted file to a web page. Open Airlock and choose the file. This is
the weakest way in of any browser here, so if you would rather start from the
other app's share sheet, [Taildrop][taildrop-link] is already on the device with
Tailscale and does register there. It puts the file straight into your other
device's downloads rather than into Airlock, and it is not encrypted in
Airlock's sense, but it covers exactly this gap.

**iOS, Safari.** Open the URL, tap Share, tap **Add to Home Screen**. This is a Safari feature, not an App Store app: no Apple developer account, no signing, no review. It is the same tailnet page with an icon. The floor is iOS 18.4, below which the wake lock does not work in an installed app, Declarative Web Push is absent, and folder selection silently picks nothing.

Do it before setting your passphrase. A Home Screen web app gets its own private storage and cannot see anything set up in the Safari tab, so pairing first means pairing twice. Airlock does not leave that to memory: opened in a Safari tab on iOS it shows the three install steps and nothing else, and the passphrase field appears only in the installed app.

Safari withholds push notifications, the wake lock and durable storage from a plain tab and grants them to a Home Screen app, which is why Airlock asks for it. What it never grants is a rich notification: buttons, images and coalescing by tag are all ignored, so an arrival on iOS announces the filename, size and sender, and Accept and Decline live in the app the tap opens. The one rich affordance that does work is the count on the Home Screen icon, and that is used on every platform that has it rather than only here.

iOS also has no Web Share Target, so sending starts inside Airlock rather than from another app's share sheet: tap **Choose files** and pick from Files or Photos. [Taildrop][taildrop-link] is in that share sheet and covers the same gap here that it does on Firefox for Android, on the same terms.

**None of the iOS paragraphs above has been run on an iPhone.** [docs/platform-notes.md](./docs/platform-notes.md) lists the six things a device has to answer, receiving a large file in the installed app first among them, and it is the document to trust when the two disagree.

### Troubleshooting

The failures that have actually been hit, and what each one means.

| Symptom | Cause |
| --- | --- |
| Bind fails on 443 | Something else holds it, commonly `tailscale serve`. Use `--port 4443` |
| Bind fails with a permission error on a port that looks free | On Windows another process holds it with exclusive use, which Winsock reports as access denied. Bind-test rather than trusting `netsh` |
| The shell loads but reports `not authorized` | The identity-bearing API request arrived over loopback. Reach Airlock by its tailnet name, not through a local proxy |
| TLS fails on every connection | HTTPS Certificates is off in the admin console |
| The host cannot resolve its own name | `tailscale set --accept-dns=true` |

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
go test -bench='.' -run='^$' ./...
node --test "web/**/*.test.mjs"
```

To run against localhost without a tailnet:

```bash
AIRLOCK_TOKEN=devtoken go run . --auth=token --data ./devdata
```

Then open `http://localhost:8080/login?t=devtoken`. Localhost counts as a secure context even over plain HTTP, so Web Crypto and the service worker both work in development.

The three checks that matter most, because these are the ones whose failure looks like success:

1. `node --test web/crypto.test.mjs` must refuse a chunk opened under the wrong id, a corrupted chunk, a truncated hash list, and a record spliced in from another transfer or another domain. If any of those open, a transfer can be tampered with undetectably.
2. A chunk file under `data/chunks/` must be unreadable. If `cat` shows your file, encryption is not actually in the path.
3. An unauthenticated caller may load only the stateless shell and assets. It must get 403 from `/api/whoami` and every stateful API; an identified but unapproved device may additionally read only its own pairing status until another device approves it.

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
      +---- direct tailnet channel, staged and saved ----+

        data/chunks/<ab>/<cid>       sealed, content addressed
        data/transfers/<id>/         records and the sealed list
```

One Go process joined to the tailnet, with the static assets embedded in the binary. Deploy is one binary plus whichever of a systemd unit, a launchd plist or a Windows logon task the host uses. No database: records are JSON files and directory scans, with a `ponytail:` note naming SQLite as the upgrade if an inbox ever holds tens of thousands of rows.

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
| `web/upload.js` | Direct one-pass staging and held two-pass upload |
| `web/staging.js` | Sealed chunks on the device's own disk, between sessions |
| `web/peer.js`, `web/session.js` | The direct channel, and the queue that drives it |
| `web/thumb.js` | Sealed thumbnails from a canvas |
| `web/api.js`, `web/app.js`, `web/strip.js` | Typed API wrapper, shell and routing, the status strip |
| `web/ios.js` | The install gate, the storage preflight, and the Home Screen badge |
| `web/views/*.js` | One module per view: send, inbox, history, devices |
| `web/sw.js` | Push, share target, and the legacy download fallback |

Exactly two Go dependencies, `tailscale.com` and `webpush-go`. Everything else is the standard library. The frontend has zero dependencies and no build step.

The identity gate is a seam, `func(*http.Request) (Identity, bool)`. Production supplies a `WhoIs` implementation, tests supply a fake, and the whole HTTP surface is testable without a tailnet.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📊 Measured

Full method, machine and caveats in [docs/benchmarks.md](./docs/benchmarks.md). Two things it set out to settle:

**Does `host` beat `embedded`? Not measured.** The comparison needs a real tailnet and two devices, and it has not been run. The default rests on an argument: the daemon owns the kernel TUN path and the TSO, GRO, GSO and `mmsg()` work that got Tailscale's userspace WireGuard past 10 Gb/s, none of which the in-process netstack has, and [an open upstream issue](https://github.com/tailscale/tailscale/issues/9707) reports `tsnet` running roughly 8 to 9 times slower. That argument is why `host` is the default; it is not evidence, and the default should not be defended as though it were. The benchmark file carries the exact commands, the traps that would turn the run into a measurement of nothing, and the empty table waiting for it.

**Is disabling sealing worth anything? Measured, and no.** On a desktop i9-14900K, sealing costs 0.572 ms per MiB more than the internal plaintext benchmark control. Almost all of that is already hidden: the uploader runs four chunks in flight, so the AES-GCM overlaps the network and would only surface on a link past about 12 gigabits. What does not overlap is the first pass, which hashes the whole file before the transfer can be created, and hashing happens in both modes. Turning sealing off in the benchmark removes 0.106 ms per MiB from the critical path, about a tenth of a second per gigabyte, which is well under one percent of a transfer on any tailnet link.

The product therefore has no sealing toggle. Every transfer created by the Send view is sealed. Plaintext mode remains only as an internal benchmark and protocol-refusal fixture, where it measures the cost of the security boundary without offering a path around it.

Both crypto figures are floors rather than browser costs: they were taken under Node against the app's own unmodified `web/crypto.js`, so they include the real cipher work but not the page's overhead. Every one of them came off a desktop CPU, and a phone is both the thinnest case and the common sending device, which is the open question that file leaves behind.

The direct path now measures about 19 MB/s on this machine against a raw browser data-channel ceiling of about 20 MB/s. The local chunker delivers about 1.09 GB/s after removing its repeated 8 MiB window rebuild, and the server stores a target-sized 1 MiB chunk at roughly 550 MB/s. On the tested machine, neither chunking, sealing nor server storage limits the direct transfer; the browser's WebRTC transport does. Two-machine, mobile and non-Chromium results still require the hardware named in [the benchmark notes](./docs/benchmarks.md).

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
- **The internal plaintext fixture.** `MODE_PLAIN` remains in the crypto module for benchmarks and refusal tests, but the product UI never selects it. A forged unsealed transfer is labeled unsafe and cannot be saved by the Inbox.
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
| 16 | Devices view and allowlist approval | ✅ Done |
| 17 | History view | ✅ Done |
| 18 | PWA install, share target and file handlers | ✅ Done |
| 19 | Server-sent events and a live inbox | ✅ Done |
| 20 | Relays | ❌ Cancelled |
| 21 | Android shell | ❌ Cancelled |
| 22 | Throughput benchmark and the sealing decision | ✅ Done |
| 23 | Deployment and hardening | ✅ Done |
| 24 | Declining a transfer | ✅ Done |
| 25 | Rich notifications with accept and decline | ✅ Done |
| 26 | Staged send and the Windows context menu | ✅ Done |
| 27 | Presence and signalling | ✅ Done |
| 28 | The queue and the progress bitmap | ✅ Done |
| 29 | Local staging | ✅ Done |
| 30 | The direct channel | ✅ Done |
| 31 | Session orchestration | ✅ Done |
| 32 | Hold-for-me, the one server-storage path | ✅ Done |
| 33 | Keep the device awake during a transfer | ✅ Done |
| 34 | Parallel links, unordered channels and fragmentation | ✅ Done |
| 35 | Parallel sealing in one pass over the file | ✅ Done |
| 36 | Measure the transfer pipeline | ✅ Done |
| 37 | Run with platform defaults and no required flags | ✅ Done |
| 38 | Windows file sharing | ✅ Done |
| 39 | Install on Windows, Linux and macOS | ✅ Built, hardware checks remain |
| 40 | Verify platform-specific behavior | ⚠ Hardware checks remain |
| 41 | Accept files and folders | ✅ Superseded and completed by task 44 |
| 42 | iOS behavior and safeguards | ✅ Built, hardware checks remain |
| 43 | Assemble and export a directly received file | ✅ Done |
| 44 | Browser-specific inbound file handling | ✅ Done |

Two tasks were cancelled outright rather than deferred.

**Relays** were specified as mirroring whole transfers to a second instance. Content no longer rests on a server, so there is nothing to mirror, and presence plus signalling already let devices on different instances find each other and connect directly. Nothing is lost by dropping it.

**The Android shell** existed for one capability a web app cannot provide: writing a received file to disk with the app closed. Its price was a second implementation of the crypto, and drift between two implementations does not fail loudly, it produces files that download successfully and will not open. Notification then tap costs a second and buys exactly one place where encryption happens.

Tasks 33 through 44 are implemented, including direct receive and save, folder drops, zero-byte files, worker-based sealing and the measured transfer pipeline. Task 40 is a hardware checklist rather than missing application code.

**iOS is built and unverified.** The install gate, the storage preflight, the announcement-only notification and the Home Screen badge are all written, and not one line of it has been run on an iPhone. [docs/platform-notes.md](./docs/platform-notes.md) holds the six questions a real device has to answer before any of this is stated as fact.

**Key handoff between devices is still a product decision.** Device allowlisting and approval work, but a newly approved device still types the existing master passphrase. The documented replacement is ECDH with a six-digit comparison; implementation waits on the recovery choice for the case where every paired device is lost. See [the pairing requirement](./docs/superpowers/specs/2026-08-16-pairing-key-agreement-requirement.md).

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
- [Taildrop][taildrop-link] - already on every one of these devices, and in the share sheets Airlock cannot reach

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
[taildrop-link]: https://tailscale.com/kb/1106/taildrop
[tailscale-link]: https://tailscale.com/kb/1244/tsnet
[tailscale-shield]: https://img.shields.io/badge/tailscale-tsnet-242424?labelColor=black&logo=tailscale&logoColor=white&style=flat-square
