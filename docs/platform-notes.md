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

## Not verified

Nothing below has been run. Do not state any of it as fact in another document.

- [ ] A transfer between **two** devices. Everything observed so far was one
      device sending to itself. The peer-to-peer path, resume across a network
      drop, and the recipient's view of a direct transfer are all unobserved.
- [ ] Web Push actually waking a device whose app is closed.
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
- [ ] iOS, on any version. The floor is 18.4 and the app must be installed to
      the Home Screen. Install before pairing: the storage partition changes.
- [ ] Android install, and whether the share sheet entry appears.
