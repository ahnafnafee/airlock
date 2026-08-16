# Platform notes

What has actually been observed, on what, and by whom. Everything here is a
record of a run, not a projection from documentation. An item that has not been
run says so.

Last updated: 2026-08-16.

## Verified

### Windows 11, host mode, real tailnet

Machine `axiom-pc`, Windows 11 Pro 22631, Go 1.x, Tailscale client installed and
logged in as `ahnafnafee@gmail.com`.

- A non-elevated process reaches the tailscaled LocalAPI over its named pipe.
  `Status` and `WhoIs` both answer. No administrator token is required.
- `hostListener` binds the tailnet address on a chosen port and serves the
  tailnet certificate for the node's MagicDNS name.
- `WhoIs` on a live connection returns the node and the user. Airlock renders
  them as `axiom-pc` and `ahnafnafee@gmail.com`.
- `whois.Node.Addresses` is populated on this path and carries both families,
  `100.86.123.42/32` and an `fd7a:...` address. The IPv4 one is what the device
  list shows.
- TLS refuses a connection that arrives without SNI, which is what a request to
  the bare IP is. This is correct and is worth knowing before debugging it
  twice: reach the server by name, not by address.

### Port conflicts on Windows

- Port 443 and port 8443 were both already held on this machine, 443 by
  `tailscale serve`. Airlock reports the conflict and names the likely cause
  rather than failing opaquely. `--port` moves it.

### MagicDNS resolution is a per-device setting

MagicDNS being enabled tailnet-wide is not enough. On `axiom-pc` the tailnet had
MagicDNS on and the device still could not resolve `axiom-pc.tailc577fe.ts.net`,
because the device itself had `accept-dns` disabled:

```
tailscale dns status
  Tailscale DNS: disabled.
```

`tailscale set --accept-dns=true` is the fix, and it is the owner's decision
because it changes DNS for everything on that machine, not just Airlock.

Two traps while diagnosing this:

- **`nslookup` is the wrong tool on Windows.** It queries the default server
  directly and does not honor the NRPT rule MagicDNS installs, so it reports
  `Non-existent domain` even when resolution works for real applications. Use
  `Resolve-DnsName`, or just open the address in a browser.
- `curl --resolve name:port:ip` reaches the server without DNS while still
  sending the right SNI. It is the way to test the server when resolution is the
  thing that is broken.

### The browser, on the same machine as the server

Chrome 1x on `axiom-pc`, against a local server. Observed directly, not inferred:

- The app loads, the passphrase is set on first run, and all four views render.
- A device awaiting approval gets the pairing screen and advances on its own
  when approved, with no reload.
- Staging, the recipient picker, the chunk strip, thumbnails and the inbox all
  work. A file with an unrecognized extension (`.weirdext`) stages and sends.
- Dedup is visible: a re-send of an identical file reports every chunk already
  held and the strip renders green rather than grey.
- **A 3 MB round trip is byte-identical.** Chunked, sealed, uploaded, fetched
  back, decrypted, assembled and downloaded; MD5 matches the source exactly.
- The layout holds at 360px and at 320px, where the rail becomes a bottom bar.
- Keyboard focus is visible on every control reached by Tab.

Four defects were found by doing this that the test suites could not see, and
are fixed: the cross-site gate refused top-level navigations, a module service
worker could never register because its script request carries no cookie, an
unapproved device met a bare error instead of the pairing screen, and the hash
router ignored the Back gesture.

### Two devices, peer to peer

Two genuinely distinct devices against one server, using the fact that token
mode names a device by its remote address: `127.0.0.1` and `[::1]` are
different hosts and, being different origins, hold separate browser storage.
Not a substitute for two machines on a real network, but it is two identities,
two stores, two event streams and a real WebRTC session between them.

- The second device met the pairing screen naming itself, and advanced to the
  passphrase prompt by itself when the first device approved it. No reload.
- The first device's recipient picker listed the new device although the picker
  had been built before that device existed.
- **A direct transfer, the product default, delivered device to device with the
  server holding none of its chunks.** The recipient's row named the file and
  offered Save, and the assembled bytes matched the sender's hash exactly.
- **96 MB in 51 chunks**, same conditions, byte-identical, assembled in 478 ms.
  The peer path was too fast on loopback to catch in a partial state, which is
  worth knowing before trying to observe one.
- **Resume across an outage.** An 8 MB transfer queued to an offline recipient,
  the server killed for twelve seconds and restarted, the recipient reopened.
  It completed within two seconds of the recipient returning, with the server
  still holding none of the five chunks, byte-identical.

That last one failed the first time it was run and is the reason
`web/app.js` now records a gap on every stream failure rather than only on the
ones it reopens from. Worth re-running after any change to the event stream or
the queue drain.

### Dedup, delta sync, history and background receive

All measured, not inferred.

- **Delta sync.** A 16 MB file, then the same file with a 256 KB slice replaced
  at its midpoint. The second send reported **7 of 8 chunks already here**, so
  content-defined chunking held its boundaries either side of the edit and one
  chunk moved. The strip renders the stored segment at the position of the edit.
  It did not before: it painted held chunks as a block from the start, so every
  delta looked like a change at the tail whatever had changed.
- **Dedup across devices.** Device A handed a 3 MB file to device B over the
  peer path. B assembled it and uploaded it to the server, a fresh store at
  **0 of 3**. A then offered the same bytes, sealed independently on its own
  hardware, and the server recognized all of them: **3 of 3 already here**. Two
  devices sealing one plaintext under one master key produce identical content
  ids, which is what makes dedup a property of the household rather than of a
  single device.
- **Transfer history.** Deleting a transfer leaves a tombstone that still names
  the file, because the sealed metadata travels with it. The row reads
  `doc-v2.bin / sent, cleared just now`.
- **Silent background receive.** With the receiving tab backgrounded
  (`document.hidden` true before, during and after), a 3 MB direct transfer
  arrived over the peer path with the server holding none of it, and the
  assembled bytes matched the sender's hash. The tab was never focused.


## How to take the remaining measurements

Everything left needs hardware this machine does not have. The setup is the same
for all of it and takes one command.

On the machine that will host, with Tailscale running and logged in:

```
go build -o airlock.exe .
./airlock.exe --port 8444
```

It prints the address to open. Every other device on the tailnet opens that same
URL. Two notes that cost time if you meet them cold, both recorded above: this
machine currently has `accept-dns` disabled, so the name will not resolve here
until `tailscale set --accept-dns=true`, and ports 443 and 8443 are already
taken, which is why the line above uses 8444.

For a phone, install to the Home Screen BEFORE setting the passphrase. An
installed app has its own storage partition and cannot see anything set up in a
browser tab, so doing it the other way round means doing it twice.

Each unchecked box below is a single question with a single answer to write
beside it. None of them needs the code read.

## Not verified

Nothing below has been run. Do not state any of it as fact in another document.

- [ ] Web Push actually waking a device whose app is closed.
- [ ] A browser on the same machine as the server opens Airlock by its tailnet
      name and completes a transfer to a second physical device.
- [ ] `tailscale cert <name>` on macOS, for whichever Tailscale variant is
      installed. If it fails, host mode on macOS is not viable and the docs must
      say so.
- [ ] A specific-IP bind on macOS port 443 as a non-root user: does it need
      root?
- [ ] On Linux, whether a non-root non-operator user gets `Status` and `WhoIs`,
      and whether `TS_PERMIT_CERT_UID` really unlocks `GetCertificate`.
- [ ] `AmbientCapabilities=CAP_NET_BIND_SERVICE` actually binding 443 in the
      systemd unit.
- [ ] A Windows scheduled task with an Interactive principal: what happens at
      logoff, and before the first logon.
- [ ] `Register-ScheduledTask -AtLogOn` on a **genuine standard account**. Every
      Windows result so far was proven on an unelevated administrator token, and
      Task Scheduler applies different ACL logic to the two.
- [ ] Embedded mode once, on any platform, with no `TS_AUTHKEY`. If it blocks
      printing an interactive login URL, it is unusable as a service and the
      docs must not recommend it.
- [ ] An installed Windows Chrome or Edge PWA opens from **Open with Airlock**,
      stages the chosen file, completes a send after the owner chooses a device,
      and starts at sign-in when that option is enabled.
- [ ] Android Chrome installs without browser chrome, appears in the share sheet,
      stages a shared photo, and stages a shared link as a text transfer.

## iOS, not run on any device

The code is written and none of it has been run on an iPhone or an iPad. The
floor is 18.4 and the app must be added to the Home Screen: install before
pairing, because the storage partition changes and a passphrase set in a Safari
tab does not exist in the installed app.

Six questions, in the order they matter. Record the device and the exact iOS
version beside each answer, and correct every document that assumed otherwise.

- [ ] **V1, the blocker. Receive a 200 MB file in the installed app and save
      it.** Service-worker-synthesized downloads have regressed twice in a year
      and the standalone-mode case traces to a WebKit bug closed to a private
      radar. The export cascade has three rungs under that one, so a failure
      here is not automatically send-only any more, but it is the difference
      between saving with one tap and saving through the share sheet. There is
      no fallback through Safari either way: the tab is a different partition.
- [ ] **V2. Start a transfer, lock the screen for two minutes, unlock.** Does it
      continue, resume, or die? If it dies, the wake lock and a visible "keep
      this screen on" state become required UI rather than polish.
- [ ] **V3. Whether Declarative Web Push renders action buttons on 18.4 or
      later.** Assume no until seen. The code assumes no and feature-detects
      `actions` on `Notification.prototype`, so a yes only widens what renders.
- [ ] **V4. Send a 2 GB file from an iPhone** and watch for an iOS-only memory
      crash, which would point at buffer retention on worker-to-main transfer
      rather than at the transfer itself.
- [ ] **V5. Confirm the file picker reaches Photos, Files and iCloud Drive,**
      and that a file with no extension survives it.
- [ ] **V6. Whether the save streams to disk or buffers in memory.** If it
      buffers, iOS gains a hard file-size cap the other platforms do not have.
      The storage preflight already reserves 2.15 times the plaintext size for
      the sealed stage, assembled output and headroom; buffering would require a
      separate size limit or export fallback rather than another disk estimate.

Two more that cost nothing to check while the device is in hand:

- [ ] The install gate itself: a Safari tab shows the Add to Home Screen screen
      and no passphrase field, and the installed app shows the passphrase field
      and not the gate.
- [ ] `navigator.storage.persist()` returning true in the installed app. WebKit
      shows no prompt and grants it heuristically, and being installed is
      supposed to be the heuristic.
