# Airlock Phase 2 Implementation Plan, part 7: run it anywhere

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-16-airlock-phase2-part6.md`, tasks 33 through 36.

**Spec:** `docs/superpowers/specs/2026-08-15-airlock-design.md`, section 3, "Where the server runs".

## Why

The server assumed a Linux VPS with systemd. Since file content moves peer to peer, it is now an identity gate, a queue, a presence table and a signalling postbox: almost no disk, almost no bandwidth. Any machine on the tailnet should host it, including one that is also a client. A VPS stays the recommendation because a queue is only useful when reachable, not because anything requires it.

## What was established, and how

The facts below were verified on this Windows machine with a Go probe built against the repository's own `go.mod`, or read from the `tailscale.com v1.102.2` source this repository compiles against. Where something was not run, this plan says so, and those items are not to be written into documentation as fact.

**Verified on Windows, non-elevated:**

- The local API is a named pipe, `\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`. The `Administrators` element gates pipe *creation*, not connection.
- `Status`, `WhoIs` and `GetCertificate` all succeed from a medium-integrity process. Windows grants read and write to any caller permitted to connect; there is no operator concept and no elevation check.
- `&local.Client{}` needs no Windows-specific code. An empty `Socket` falls through to `paths.DefaultTailscaledSocket()` and dials the pipe through `go-winio`, already an indirect dependency.
- There is no privileged-port restriction. `127.0.0.1:443` and `0.0.0.0:80` both bound non-elevated.

**Verified blockers on this machine:**

- `tailscaled` already listens on `100.86.123.42:443`, serving an existing `tailscale serve` config that proxies to `127.0.0.1:2283`. Ports 8443 and 10000 are taken by the same config. Airlock cannot bind 443 here.
- `hostListener()` hardcodes 443 and `--addr` is read only in the token branch, so there is no way to move it.
- The earlier 8080 smoke-test failure was not a reserved port range. It is a Spring Boot service holding `:::8080` with `SO_EXCLUSIVEADDRUSE`, which Winsock reports as `WSAEACCES` rather than `WSAEADDRINUSE`. **Rule: bind-test, never trust the `netsh` exclusion table.**

**Not run anywhere, and load-bearing.** Nothing was executed on macOS or Linux. The single most important unknown is whether the App Store and Standalone macOS Tailscale builds serve `/localapi/v0/cert` at all; without it, host mode on a Mac has no TLS and the client design collapses. Embedded mode has never been run on any platform, including whether it blocks on an interactive login URL with no `TS_AUTHKEY`, which would be fatal for a service.

---

### Task 37: Run with no flags, anywhere

**Files:**
- Modify: `main.go`, `tailscale.go`
- Test: `main_test.go`

**Interfaces:**
- New flag: `--port`, default `443`
- New: `func defaultDataDir() string`
- Changed: `hostListener()` and `embeddedListener()` take the port; `hostListener()` binds every tailnet address

**The bar: a person downloads the binary, runs it with no arguments, and opens the URL it prints.** Anything that requires reading documentation before the first successful run is a defect in the defaults, not a documentation gap.

- [ ] **Step 1: Write the failing tests**

Create `main_test.go`:

```go
package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDefaultDataDirIsAbsoluteAndPlatformCorrect(t *testing.T) {
	got := defaultDataDir()
	if !filepath.IsAbs(got) {
		// A relative default is what makes a scheduled task write to
		// System32\data and a launch agent write to /data. Worse, starting from
		// a different working directory creates a fresh salt and an empty
		// check.bin, which presents as data loss or a wrong passphrase rather
		// than as a path problem.
		t.Fatalf("defaultDataDir() = %q, want an absolute path", got)
	}

	switch runtime.GOOS {
	case "windows":
		// LOCALAPPDATA on purpose, not the Roaming profile: a roaming profile
		// would try to sync the whole store.
		base, err := os.UserCacheDir()
		if err != nil {
			t.Skip("no user cache dir on this machine")
		}
		if !strings.HasPrefix(got, base) {
			t.Fatalf("defaultDataDir() = %q, want it under %q", got, base)
		}
	case "darwin":
		base, err := os.UserConfigDir()
		if err != nil {
			t.Skip("no user config dir on this machine")
		}
		if !strings.HasPrefix(got, base) {
			t.Fatalf("defaultDataDir() = %q, want it under %q", got, base)
		}
	default:
		// Not ~/.config: this is bulk data, not configuration.
		if strings.Contains(got, string(filepath.Separator)+".config"+string(filepath.Separator)) {
			t.Fatalf("defaultDataDir() = %q, want a data dir rather than a config dir", got)
		}
	}
}

func TestDefaultDataDirHonoursXDGOnUnix(t *testing.T) {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		t.Skip("XDG does not apply here")
	}
	t.Setenv("XDG_DATA_HOME", "/tmp/xdg-example")
	if got := defaultDataDir(); !strings.HasPrefix(got, "/tmp/xdg-example") {
		t.Fatalf("defaultDataDir() = %q, want it under XDG_DATA_HOME", got)
	}
}

func TestListenAddrsCoversEveryTailnetAddress(t *testing.T) {
	// Using only the first address leaves the tailnet IPv6 address dark, so a
	// client that resolves to it fails with no diagnosis.
	got := listenAddrs([]string{"100.86.123.42", "fd7a:115c:a1e0::2e01:7b2d"}, 4443)
	want := []string{"100.86.123.42:4443", "[fd7a:115c:a1e0::2e01:7b2d]:4443"}
	if len(got) != len(want) {
		t.Fatalf("listenAddrs = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("listenAddrs[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}
```

- [ ] **Step 2: Add `defaultDataDir` and `listenAddrs` to `main.go`**

```go
// defaultDataDir picks a per-platform location so the binary works with no
// flags. A relative default breaks the moment something other than a shell
// starts it: a scheduled task inherits System32, a launch agent inherits /. The
// quiet failure is worse than the loud one, because a different working
// directory creates a fresh salt and an empty check.bin, which looks like data
// loss or a wrong passphrase rather than a path mistake.
func defaultDataDir() string {
	switch runtime.GOOS {
	case "windows":
		// LOCALAPPDATA rather than the Roaming profile that UserConfigDir
		// returns. A roaming profile would try to sync the whole store.
		if base, err := os.UserCacheDir(); err == nil {
			return filepath.Join(base, "Airlock")
		}
	case "darwin":
		if base, err := os.UserConfigDir(); err == nil {
			return filepath.Join(base, "Airlock")
		}
	default:
		if base := os.Getenv("XDG_DATA_HOME"); base != "" {
			return filepath.Join(base, "airlock")
		}
		if home, err := os.UserHomeDir(); err == nil {
			// Not ~/.config: this is bulk data, not configuration.
			return filepath.Join(home, ".local", "share", "airlock")
		}
	}
	return "data"
}

func listenAddrs(ips []string, port int) []string {
	out := make([]string, 0, len(ips))
	for _, ip := range ips {
		out = append(out, net.JoinHostPort(ip, strconv.Itoa(port)))
	}
	return out
}
```

Change the `--data` default to `defaultDataDir()` and add:

```go
	port = flag.Int("port", 443, "HTTPS port on the tailnet address")
```

Add `"runtime"` and `"strconv"` to the imports.

- [ ] **Step 3: Use the port and every address in `tailscale.go`**

`hostListener()` currently joins `st.TailscaleIPs[0]` with a literal `"443"`. Replace with `listenAddrs(...)` over every entry, open a listener per address, and serve them together. Wrap each in `tls.NewListener` with the same `GetCertificate`.

Serving several listeners from one `http.Serve` call is not possible, so return a listener that multiplexes them: accept on each in its own goroutine and feed one channel. Keep it small; a dozen lines.

`embeddedListener()` passes the port to `ts.ListenTLS`.

- [ ] **Step 4: Preflight and print the URL**

The current startup log prints the auth mode and the bind address, which is why both of this machine's real problems were invisible. After `Status` succeeds in `hostListener()`:

```go
	// HTTPS Certificates off in the admin console is the failure that otherwise
	// starts cleanly and then fails every single TLS handshake, which reads as a
	// broken browser rather than a missing setting.
	if len(st.CertDomains) == 0 {
		return nil, nil, errors.New(
			"this tailnet has no HTTPS certificate domains. Enable HTTPS Certificates " +
				"in the Tailscale admin console under Settings, Features, then restart")
	}
	name := strings.TrimSuffix(st.CertDomains[0], ".")
	log.Printf("open https://%s:%d/ on any device on your tailnet", name, *port)
```

Also fail with an actionable message when a bind fails, naming the port and suggesting `--port`, because "address already in use" on 443 is exactly this machine's situation and the fix is one flag.

- [ ] **Step 5: Make the loopback refusal legible**

`WhoIs` returns "peer not found" for `127.0.0.1` and `::1`, so `identityFromWhoIs` returns false and `/api/whoami` answers a bare "not authorized". The stateless shell and assets still load, but boot cannot identify the device and surfaces that API refusal. Unreachable while the listener is tailnet-only, but it is exactly what happens the moment anyone fronts Airlock with `tailscale serve` or binds `0.0.0.0` so a local browser can reach it. This machine already runs `tailscale serve`, so that workaround is one search away.

```go
		if isLoopback(r.RemoteAddr) {
			// A tailnet identity cannot be derived from a loopback connection.
			// Logged distinctly because a shell that loads and then reports a
			// 403 from whoami otherwise reads as a permissions bug.
			log.Printf("refusing a loopback request from %s: reach Airlock by its "+
				"tailnet name rather than through a local proxy", r.RemoteAddr)
			return Identity{}, false
		}
```

- [ ] **Step 6: Verify**

```bash
go vet ./... && go test ./... -v
go build -o airlock.exe .
./airlock.exe --port 4443
```

On this machine, 443 is held by `tailscale serve`, so `--port 4443` is the working invocation and 4443 was verified free. Check in order:

1. It prints `open https://axiom-pc.<tailnet>.ts.net:4443/`.
2. That URL loads in a browser **on this same machine**, with no certificate warning. This is the owner's main use case and has never been observed live.
3. `https://100.86.123.42:4443/` fails during the handshake. Expected: `GetCertificate` rejects an IP-literal SNI. The MagicDNS name is the only working URL.
4. Another tailnet device loads the same URL.
5. Stop it, delete nothing, start it again from a **different working directory**, and confirm it finds the same data rather than creating a second store.
6. Temporarily point `--port` at 443 and confirm the failure message names the port and suggests the flag, rather than printing a bare bind error.

If step 2 fails with a DNS error, check `tailscale set --accept-dns=true`. A host cannot resolve its own MagicDNS name without it, and nothing in the binary detects that.

- [ ] **Step 7: Commit**

```bash
git add main.go tailscale.go main_test.go
git commit -m "feat(cmd): per-platform data dir, a port flag, and a startup preflight"
```

---

### Task 38: Windows file sharing

**Files:**
- Create: `sharing_windows.go`, `sharing_other.go`
- Modify: `chunkstore.go`, `transfers.go`
- Test: `chunkstore_test.go`

**A real bug, not a portability nicety.** On Windows an open file handle blocks rename and delete unless the handle was opened with `FILE_SHARE_DELETE`. `ChunkStore.Open` and `Transfers.OpenRecord` hand out ordinary handles, so any concurrent read breaks:

- `os.Rename` in `writeStream`, which is how every chunk lands
- `os.Remove` in `ChunkStore.Sweep`
- `os.RemoveAll` in `removeTree`

The last is the worst, because `Delete` writes the tombstone *before* removing the directory. A delete during a read returns 500 with history already saying the transfer ended, while the directory and the inbox entry survive. The inbox then shows a transfer that history says is gone.

- [ ] **Step 1: Write the failing test**

Append to `chunkstore_test.go`:

```go
func TestAnOpenChunkDoesNotBlockItsOwnReplacementOrRemoval(t *testing.T) {
	c := newChunks(t)
	if err := c.Put(cid(1), strings.NewReader("first")); err != nil {
		t.Fatal(err)
	}
	f, err := c.Open(cid(1))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	// Sweeping while a reader holds the file must still remove it. On Windows a
	// handle without FILE_SHARE_DELETE blocks this, and the sweep silently stops
	// reclaiming space.
	if _, err := c.Sweep(map[string]bool{}); err != nil {
		t.Fatalf("sweep with an open reader: %v", err)
	}
	if c.Has(cid(1)) {
		t.Fatal("an open reader prevented the sweep from removing the chunk")
	}
}
```

- [ ] **Step 2: Write the platform files**

`sharing_windows.go`:

```go
//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// openShared opens a file for reading in a way that still allows another
// process, or this one, to rename or delete it while the handle is open.
// Without FILE_SHARE_DELETE, Windows blocks the rename in writeStream, the
// remove in Sweep, and the RemoveAll behind a transfer deletion.
func openShared(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(
		p,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}
```

`sharing_other.go`:

```go
//go:build !windows

package main

import "os"

// Unix removes a directory entry independently of open handles, so nothing
// special is needed here.
func openShared(path string) (*os.File, error) { return os.Open(path) }
```

Replace `os.Open` with `openShared` in `ChunkStore.Open` and `Transfers.OpenRecord`.

**On the dependency rule:** `golang.org/x/sys` is a third dependency and the Global Constraints permit two. Check `go.mod` first: `tailscale.com` already requires it, so it is present and this adds no new module to the build. If `go mod tidy` would promote it from indirect to direct, that is acceptable and should be noted in your report. If it is somehow absent, use `syscall.CreateFile` from the standard library instead rather than adding a module.

- [ ] **Step 3: Verify and commit**

```bash
go vet ./... && go test ./... -v
```

The new test passes trivially on Unix and is the real check on Windows.

```bash
git add sharing_windows.go sharing_other.go chunkstore.go transfers.go chunkstore_test.go
git commit -m "fix(store): open files with delete sharing so windows can rename and sweep"
```

---

### Task 39: Install it anywhere

**Files:**
- Create: `deploy/airlock.service`, `deploy/com.airlock.server.plist`, `deploy/windows/install-service.ps1`, `deploy/windows/uninstall-service.ps1`
- Modify: `README.md`

**Note:** `deploy/airlock.service` is referenced by the README and does not exist in the repository. Task 23 was to write it and has not run. Write it here if it is still missing.

- [ ] **Step 1: Windows, a scheduled task**

`Register-ScheduledTask -AtLogOn` succeeds **without elevation**, while `schtasks /sc onlogon` is refused. Use the cmdlet. Do not ship a Windows service: that needs elevation *and* the Service Control Manager protocol implemented in the binary, which would otherwise fail with error 1053.

`deploy/windows/install-service.ps1` registers a logon task running `airlock.exe --port <port>` as the current user, with an absolute `--data`. It bind-tests the chosen port first and refuses with a clear message if it is occupied, since that is exactly the situation on a machine already running `tailscale serve`.

Known limitation to state in the script's output rather than hide: an Interactive principal runs only inside the logged-on session, so the server is down when nobody is logged in. Running before logon needs one elevated registration. **Whether an Interactive task really stops at logoff was not tested**, so the script should describe the limitation as expected behavior rather than as a measured fact.

- [ ] **Step 2: Linux, systemd**

The unit needs `AmbientCapabilities=CAP_NET_BIND_SERVICE` with `CapabilityBoundingSet=` only when binding a port below 1024. With `--port 4443` neither is needed.

**Delete the `SupplementaryGroups=tailscale` line** from any draft. The Tailscale local API socket is mode 0666 and `PermitRead` is unconditional for any local uid, and Tailscale's Linux packaging defines no such group, so that line is a no-op that implies a requirement which does not exist.

`GetCertificate` is the one call needing more than read: it requires `PermitWrite`, which means root, the daemon uid, or the configured operator. The narrow grant is `TS_PERMIT_CERT_UID=<user>` in `/etc/default/tailscaled` followed by a daemon restart. Document that, and mark it **unverified**: it was read from source, not run.

- [ ] **Step 3: macOS, launchd**

A `LaunchDaemon` in `/Library/LaunchDaemons`, root:wheel, mode 0600, with `RunAtLoad` and `KeepAlive`, installed by `sudo launchctl bootstrap system`. Set `WorkingDirectory` or pass an absolute `--data`, and never fork.

Two things must be marked unverified rather than documented as fact:

- **Whether the App Store and Standalone Tailscale builds serve the certificate endpoint at all.** If they do not, host mode has no TLS on a Mac. The check is `tailscale cert <node>.<tailnet>.ts.net` run as the user Airlock will run as.
- **Whether a specific-IP bind on 443 still needs root on macOS.** Mojave lifted the restriction only for wildcard binds, and Airlock binds a specific address on purpose so it is never reachable from the LAN. Do not switch to a wildcard bind to dodge this; that throws away the property. With `--port` above 1024 the question does not arise.

App Store Tailscale users need a `LaunchAgent` rather than a daemon, because that variant's API token is discovered per GUI user and root cannot see it.

- [ ] **Step 4: Rewrite the README hosting section**

State plainly: a VPS is recommended because a queue is only useful when reachable, and any always-on machine works. Give a per-OS section. Fix the current quickstart, which passes `TS_AUTHKEY` while `--tailscale-mode` defaults to `host`, where that variable is never read.

Add a short troubleshooting list for the failures actually observed:

| Symptom | Cause |
| --- | --- |
| Bind fails on 443 | Something else holds it, commonly `tailscale serve`. Use `--port 4443` |
| Bind fails with a permission error on a port that looks free | On Windows another process holds it with exclusive use, which Winsock reports as access denied. Bind-test rather than trusting `netsh` |
| The shell loads but reports `not authorized` | The identity-bearing API request arrived over loopback. Reach Airlock by its tailnet name, not through a local proxy |
| TLS fails on every connection | HTTPS Certificates is off in the admin console |
| The host cannot resolve its own name | `tailscale set --accept-dns=true` |

- [ ] **Step 5: Commit**

```bash
git add deploy README.md
git commit -m "docs: host on windows, macos or linux, with a vps as the recommendation"
```

---

### Task 40: Verify the unverified

**Not code.** The investigations that produced this plan ran nothing on macOS or Linux, and never observed a live same-machine browser request on any platform. This task is a checklist for a human with the hardware, and its output is edits to the documents above.

- [ ] A browser on the **same machine** as the server loads the app over the tailnet name and completes a transfer to another device. High confidence from three separately verified pieces, but never observed end to end.
- [ ] `tailscale cert <name>` succeeds on a Mac, for whichever Tailscale variant is installed. If it fails, host mode on macOS is not viable and the docs must say so.
- [ ] A specific-IP bind on macOS port 443 as a non-root user: does it need root?
- [ ] On Linux, a non-root non-operator user gets `Status` and `WhoIs`, and `TS_PERMIT_CERT_UID` actually unlocks `GetCertificate`.
- [ ] `AmbientCapabilities=CAP_NET_BIND_SERVICE` actually binds 443 in the systemd unit.
- [ ] A Windows scheduled task with an Interactive principal: confirm what happens at logoff and before first logon.
- [ ] Re-check `Register-ScheduledTask -AtLogOn` on a **genuine standard account**. Every Windows result so far was proven on an unelevated administrator token, and Task Scheduler applies different ACL logic to the two.
- [ ] Run embedded mode once, on any platform, with no `TS_AUTHKEY`. If it blocks printing an interactive login URL, it is unusable as a service and the docs must not recommend it.

Record each result in `docs/benchmarks.md` or a sibling `docs/platform-notes.md`, and correct any document that stated an unverified item as fact.

---

### Task 41: Anything is a file

**Superseded in part by task 44**, which covers dropped folders and the whole inbound chain with receipt-based detection. Keep this task's round-trip tests for unusual names and types; take the folder walking from task 44 rather than implementing it twice.

**Files:**
- Modify: `web/views/send.js`
- Test: `web/upload.test.mjs`, `web/naming.test.mjs`

**Nothing in the transfer path restricts a file type, and nothing should.** Chunks are bytes, `upload.js` falls back to `application/octet-stream` when the browser cannot identify a file, and the share target accepts `*/*`. The enumerated list in `file_handlers` is not a restriction: Chrome requires concrete MIME types there, and it only decides which types get an Open with entry. Drag and drop and the Windows context menu cover every other type.

This task closes the two places where an unusual input is still handled badly, and adds the tests that say so.

**A dropped folder currently yields nothing useful.** `dataTransfer.files` does not contain a directory's contents. Depending on the browser it is either empty, in which case the drop silently does nothing, or it contains the folder itself as a zero-byte entry, which stages a bogus transfer named after the folder. Both are bad, and the second is worse because it looks like it worked.

- [ ] **Step 1: Walk dropped directories**

Use `DataTransferItem.webkitGetAsEntry()`, which is what actually exposes directory contents, and fall back to `dataTransfer.files` when it is unavailable.

```js
// A dropped folder is not in dataTransfer.files. Without walking the entries,
// dropping one either does nothing or stages the folder as a zero-byte file
// named after itself, which looks like it worked.
async function filesFromDrop(dataTransfer) {
  const entries = [...(dataTransfer.items || [])]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length === 0) return [...dataTransfer.files];

  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      // Keep the folder structure in the name, since a transfer is a flat list
      // of files and the path is the only thing carrying that information.
      out.push(prefix ? new File([file], prefix + file.name, { type: file.type }) : file);
      return;
    }
    const reader = entry.createReader();
    // readEntries returns at most 100 per call and signals the end with an
    // empty batch, so a folder of 500 files needs five calls.
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}
```

Wire the drop handler to `await filesFromDrop(e.dataTransfer)`. Add `webkitdirectory` as a second picker button labelled `or a folder`, so the same capability exists without a mouse.

- [ ] **Step 2: Add the round-trip tests**

Append to `web/upload.test.mjs`, using the existing fake file and api helpers:

```js
test('a file with no extension and no detected type transfers', async () => {
  // Common for archives, disk images, and anything from a unix machine. The
  // browser reports an empty type and there is nothing to infer from the name.
  const api = fakeApi();
  const file = fakeFile(pseudoRandom(9000, 31), 'Makefile', '');
  const r = await upload(file, { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api });
  assert.equal(r.sent, r.total);
  assert.ok(r.total > 0);
});

test('unusual names and types reach the sealed metadata unchanged', async () => {
  for (const [name, type] of [
    ['日本語のファイル.txt', 'text/plain'],
    ['🎉 party.gif', 'image/gif'],
    ['a.b.c.d.tar.zst', 'application/zstd'],
    ["it's a file, isn't it.bin", ''],
    ['.hidden', ''],
    ['CON', ''],
    ['x'.repeat(200) + '.dat', 'application/octet-stream'],
  ]) {
    const api = fakeApi();
    const r = await upload(fakeFile(pseudoRandom(3000, 7), name, type), {
      mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
    });
    assert.ok(r.total > 0, `no chunks for ${name}`);
    assert.equal(r.sent, r.total, `not everything sent for ${name}`);
  }
});
```

- [ ] **Step 3: Verify by hand**

1. Drop a folder containing nested subfolders. Every file inside appears staged, with its path in the name, and no zero-byte entry named after the folder.
2. Drop a file with no extension. It transfers and downloads with the same name.
3. Send a file named with emoji and a space. It arrives with the name intact, not percent-encoded.
4. Send a 0-byte file. It arrives as a 0-byte file.
5. Send a `.exe`, a `.dmg` and a file with a made-up extension. Nothing refuses any of them.

- [ ] **Step 4: Commit**

```bash
git add web/views/send.js web/upload.test.mjs
git commit -m "feat(send): accept dropped folders and cover unusual names and types"
```

---

### Task 42: iOS

**Files:**
- Create: `web/ios.js`, `web/ios.test.mjs`
- Modify: `web/app.js`, `web/index.html`, `web/sw.js`, `web/session.js`, `web/manifest.webmanifest`
- Modify: `README.md`

**iOS is a supported platform with a narrower shape: added to the Home Screen only, floor iOS 18.4.** This is Safari's Add to Home Screen, not an App Store app: no Apple developer account, no signing, no review. Say so in any copy you write, because "installed" reads as a native app to most people and this is the same tailnet page with an icon. Read section 8 of the design spec for the reasoning before starting. The short version is that three things are broken below 18.4 and two capabilities are cut outright.

**Nothing here is a second code path where one shape can serve everywhere.** Two of the iOS constraints are already global in the plan, deliberately: OPFS writes go through a worker's sync access handle because Safari had no alternative before 26.0, and the service worker constructs its own download stream because no Safari can transfer one. Do not add an iOS branch for either.

- [ ] **Step 1: Detection, and the install gate**

`web/ios.js`:

```js
// Airlock runs on iOS only as a Home Screen web app. A Safari tab cannot request
// push at all, its wake lock does not work, and its staged transfers can be
// evicted after seven days without interaction.
//
// The reason this is a hard gate rather than a nudge: a Home Screen web app has
// its own storage partition. It shares no IndexedDB, OPFS or service worker
// registration with the same origin in a tab, so a passphrase set up in Safari
// simply does not exist in the installed app. Letting someone pair in a tab
// would silently waste that setup.
export function isIOS(nav = navigator) {
  const ua = nav.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua)
    || (ua.includes('Macintosh') && nav.maxTouchPoints > 1);
}

export function isStandalone(win = window) {
  return win.matchMedia?.('(display-mode: standalone)').matches
    || win.navigator.standalone === true;
}

// iOS has no beforeinstallprompt, so the app cannot offer to install itself and
// has to explain the manual steps instead.
export function needsInstallGate(nav = navigator, win = window) {
  return isIOS(nav) && !isStandalone(win);
}
```

Tests in `web/ios.test.mjs` cover: an iPhone user agent in a tab needs the gate; the same in standalone does not; an iPad reporting as Macintosh with touch points is detected; a desktop is never gated.

In `web/app.js`, check `needsInstallGate()` before the unlock flow and show the install screen instead. **This has to come before pairing**, not after, or the passphrase lands in the wrong storage partition.

- [ ] **Step 2: The install screen**

A panel in `index.html`, hidden by default, using the existing tokens and no new ones:

> **Add Airlock to your Home Screen**
>
> iOS only lets a web app receive notifications and hold storage reliably once it is installed.
>
> 1. Tap the Share button in Safari's toolbar
> 2. Scroll down and tap **Add to Home Screen**
> 3. Open Airlock from your Home Screen and come back to this step
>
> Set your passphrase after installing, not before: an installed app has its own private storage and cannot see anything set up in the browser tab.

- [ ] **Step 3: Storage preflight**

Before accepting a queued transfer, on every platform but load-bearing here:

```js
// The quota is not the constraint on iOS, free disk is. Since iOS 17 the
// per-origin ceiling is up to 60% of total disk, so estimate() on a 128 GB phone
// reports something like 76 GB while 12 GB is actually free. That number is a
// policy ceiling, not a reservation, and a write still fails when the disk is
// full, with no prompt and no way for the user to grant more.
export async function hasRoomFor(bytes, factor = 1.15) {
  if (!navigator.storage?.estimate) return true;
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  return quota - usage > bytes * factor;
}
```

Refuse up front with a clear message naming the shortfall, rather than failing at 90 percent. Catch `QuotaExceededError` on every staged write, fail the transfer cleanly, and delete the partial stage so nothing half-written looks complete.

Call `navigator.storage.persist()` at startup and branch on the boolean. WebKit shows no prompt and grants it heuristically, with installed apps being the heuristic.

- [ ] **Step 4: Notifications degrade to an announcement**

`actions`, `image`, `icon`, `badge`, `renotify`, `requireInteraction` and `vibrate` are all ignored on iOS, and `tag` does not coalesce. So on iOS the notification announces and the decision happens in the app:

- Body carries the filename, size and sender. No image, no buttons.
- The tap opens the app on the transfer, where Accept and Decline live alongside the thumbnail.
- Set the Home Screen badge to the pending inbound count with `navigator.setAppBadge`. It is the one rich affordance that works, and it should be used on every platform that has it, not only here.

Keep the rich notification from task 25 for platforms that honour it. Feature-detect rather than sniffing: read `Notification.prototype` for `actions` support and fall back.

- [ ] **Step 5: Reduce the link count**

Use `linkCountFor()` from task 34. WebKit publishes no per-page connection limit and iOS is reported as less reliable with several at once, so it opens one. A phone's link cannot use four anyway.

- [ ] **Step 6: Verify on a real device, and write down what happens**

Six of these are unverified and two are load-bearing. Do not document iOS receive as working until V1 passes.

- [ ] **V1, the blocker.** Receive a 200 MB file in the installed app and save it. Service-worker-synthesized downloads have regressed twice in a year and the standalone-mode case traces to a WebKit bug closed to a private radar. **If this fails, iOS is send-only**, and there is no fallback through Safari because of the storage partition. Record the exact iOS version.
- [ ] **V2.** Start a transfer, lock the screen for two minutes, unlock. Does it continue, resume, or die? If it dies, the wake lock and a visible "keep this screen on" state become required UI rather than polish.
- [ ] **V3.** Whether Declarative Web Push renders action buttons on 18.4 or later. Assume no until seen.
- [ ] **V4.** Send a 2 GB file from an iPhone and watch for an iOS-only memory crash, which would point at buffer retention on worker-to-main transfer rather than at the transfer itself.
- [ ] **V5.** Confirm the file picker reaches Photos, Files and iCloud Drive, and that a file with no extension survives it.
- [ ] **V6.** Whether the save streams to disk or buffers in memory. If it buffers, iOS gains a hard file-size cap the other platforms do not have, and the preflight factor must rise to 2.15.

Record each in `docs/platform-notes.md` with the device and iOS version, and correct any document that stated an unverified item as fact.

- [ ] **Step 7: Commit**

```bash
git add web/ios.js web/ios.test.mjs web/app.js web/index.html web/sw.js web/session.js web/manifest.webmanifest README.md docs/platform-notes.md
git commit -m "feat(ios): install gate, storage preflight and announcement-only notifications"
```

---

### Task 43: Assemble, then export

**Files:**
- Create: `web/assemble.js`, `web/export.js`, `web/export.test.mjs`
- Modify: `web/session.js`, `web/views/inbox.js`, `web/sw.js`

**Interfaces:**
- `export async function assemble(transferId, meta, opts)` writing one decrypted output file into OPFS and returning its `File`
- `export async function exportFile(file, opts)` running the cascade and returning which rung succeeded
- `export function exportRungs(nav)` reporting which rungs this browser has

**This removes the last way iOS could have been send-only.**

The earlier design had one save path: a service worker synthesizing a streaming `Response`. That path has regressed twice in a year on WebKit and its behavior inside a Home Screen web app traces to a bug closed to a private radar. Betting the platform on it was the mistake.

**Receiving is two steps and only the second was ever uncertain.** Chunks arrive and land in OPFS. That always works. Turning them into a file the operating system holds is a separate action, it can be retried, and it has several independent implementations.

**The property that makes this cheap: an OPFS `File` is disk-backed.** `getFile()` on a handle returns a `File` referencing bytes on disk rather than in memory, and both `URL.createObjectURL()` and `navigator.share()` accept it without materializing it. So a 20 GB export costs no more memory than a 20 MB one, with no streaming trick at all.

- [ ] **Step 1: Assemble into one file**

```js
// Decrypt the staged chunks into a single output file. The result is a
// disk-backed File, which is what lets every export rung below stay
// memory-flat: createObjectURL and navigator.share both take a reference to
// disk rather than a copy in memory.
//
// Staged chunks are deleted as they are consumed, so peak disk is roughly the
// file size plus one chunk rather than twice the file size.
export async function assemble(transferId, meta, { mk, mode, hashes, cids, stage }) {
  const root = await navigator.storage.getDirectory();
  const out = await root.getDirectoryHandle('assembled', { create: true });
  const handle = await out.getFileHandle(transferId, { create: true });

  // One handle held for the whole write. The spec allows a single open sync
  // access handle per file, and reopening per chunk would be both slower and a
  // race against itself.
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    let at = 0;
    for (let i = 0; i < hashes.length; i++) {
      const sealed = await stage.get(i);
      // Throws if the chunk was substituted or corrupted, so a damaged transfer
      // fails here rather than producing a plausible wrong file.
      const plain = await openChunk(mk, mode, hashes[i], cids[i], sealed);
      access.write(plain, { at });
      at += plain.length;
      await stage.remove(i);
    }
    access.flush();
    if (at !== meta.size) {
      throw new Error(`assembled ${at} bytes, expected ${meta.size}`);
    }
  } finally {
    access.close();
  }
  return handle.getFile();
}
```

`assemble` runs in the staging worker, because `createSyncAccessHandle` is worker-only and on iOS before 26.0 there is no other way to write into OPFS.

- [ ] **Step 2: The export cascade**

```js
// Four rungs, tried in order. Each is independently supported somewhere, so a
// browser that fails one still saves the file.
//
// Rung four is the reason no platform can be receive-broken: the bytes are
// already on the device and their tags have verified. Export is a separate,
// retryable action, and the file waits in the app until one of the rungs works.
export const RUNG = {
  // Chromium desktop only, and the best rung where it exists: the browser
  // writes straight to a location the person chose, streaming, with no object
  // URL and no second copy anywhere.
  SAVE_PICKER: 'file-system-access',
  STREAM: 'service-worker-stream',
  DOWNLOAD: 'anchor-download',
  SHARE: 'share-sheet',
  KEEP: 'kept-in-app',
};

export function exportRungs(nav = navigator, win = globalThis) {
  return {
    [RUNG.SAVE_PICKER]: 'showSaveFilePicker' in win,
    [RUNG.STREAM]: 'serviceWorker' in nav,
    [RUNG.DOWNLOAD]: typeof URL.createObjectURL === 'function',
    [RUNG.SHARE]: typeof nav.canShare === 'function',
    [RUNG.KEEP]: true,
  };
}

export async function exportFile(file, { preferShare = false, nav = navigator, doc = document } = {}) {
  // On iOS the share sheet is the rung most likely to reach the Files app, and
  // it needs a user gesture, so the caller passes preferShare from a click
  // handler rather than this module guessing.
  if (preferShare && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return RUNG.SHARE;
    } catch (err) {
      // A cancelled share is a decision, not a failure. Falling through to a
      // download would save a file the person just declined to save.
      if (err && err.name === 'AbortError') return RUNG.KEEP;
    }
  }

  try {
    const url = URL.createObjectURL(file);
    const a = doc.createElement('a');
    a.href = url;
    a.download = file.name;
    a.rel = 'noopener';
    doc.body.append(a);
    a.click();
    a.remove();
    // Revoked on a timer rather than immediately: revoking while the browser is
    // still fetching the URL cancels the download on some engines.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return RUNG.DOWNLOAD;
  } catch {
    // Nothing is lost. The file is in the app and can be exported later.
    return RUNG.KEEP;
  }
}
```

- [ ] **Step 3: Tests**

`web/export.test.mjs`, with fakes for `navigator.share` and the DOM:

- a cancelled share reports `KEEP` and does **not** fall through to a download, because saving a file somebody just declined to save is worse than not saving it
- a share that throws for any other reason does fall through to the download rung
- `preferShare` false never calls `share`
- `exportRungs` reports `KEEP` true unconditionally, on any navigator
- the object URL is revoked, and not before the click

Add to the staging tests: assembling a three-chunk transfer produces the concatenation in order; a chunk that fails its tag aborts assembly rather than writing a short file; assembly checks the total length against the metadata's size.

- [ ] **Step 4: Wire it into the inbox**

A received transfer shows **Save**. Where the stream rung works, that is one tap and the browser's own download UI appears. Where it does not, the same tap assembles and runs the cascade, and the row reports what happened: `Saved`, `Shared`, or `Ready to save` when it stayed in the app.

A transfer whose export stopped at `KEEP` keeps its Save button and is never shown as failed. Its bytes are on the device and verified; only the export is outstanding.

Assembly is idempotent: a second Save reuses the assembled file if it is still present rather than decrypting again.

- [ ] **Step 5: Verify**

```bash
node --test web/export.test.mjs
```

Then on real devices:

1. Desktop: save a 2 GB transfer, confirm the download completes and memory stays flat.
2. iPhone, Home Screen app: save a 200 MB transfer. Whichever rung runs, the file must reach Files. Record which rung.
3. iPhone: cancel the share sheet. The row must still offer Save, and nothing should have been written elsewhere.
4. iPhone: save a 2 GB transfer and watch memory. Flat is the requirement; a spike means something materialized the file rather than referencing it.
5. Corrupt a staged chunk before saving. Assembly must fail rather than write a short or wrong file.
6. Confirm peak disk during assembly is about the file size plus one chunk, not twice.

- [ ] **Step 6: Commit**

```bash
git add web/assemble.js web/export.js web/export.test.mjs web/session.js web/views/inbox.js web/sw.js
git commit -m "feat(web): assemble into one file and export through a cascade"
```

---

### Task 44: Getting a file in, on every browser

**Files:**
- Create: `web/inbound.js`, `web/inbound.test.mjs`
- Modify: `web/views/send.js`, `web/app.js`, `web/sw.js`, `README.md`

**Interfaces:**
- `export function observeCapabilities(opts)` starting receipt-based detection
- `export async function markCapability(name)` / `export async function capabilities()`
- `export async function filesFromDrop(dataTransfer)` walking dropped folders

**The share sheet is a Chromium bonus, not the path.** `share_target` is implemented only by Chromium, and `file_handlers` is narrower still: Chromium **desktop only**, explicitly absent from Chrome on Android. So on the one platform where a share sheet is the natural gesture, file handling contributes nothing.

Waiting for the other engines is not a plan. Mozilla's standards position is positive but its meta bug is P3, unassigned, and has had no patches in seven years. WebKit's position is neutral with named security and integration concerns, on a bug open since 2019 assigned to nobody, whose only recent comments are third-party developers asking. Nothing in Interop 2026 touches share targets, the manifest, install, or file handling.

**So the file picker is the product's real inbound path, and everything else is an optimization over it.** Firefox Android and Safari iOS live on the picker permanently.

- [ ] **Step 1: Understand what actually works where**

| Mechanism | Chromium desktop | Chromium Android | Firefox desktop | Firefox Android | Safari macOS | Safari iOS |
|---|---|---|---|---|---|---|
| File picker, no `accept` | yes | yes | yes | yes | yes | yes |
| Drag and drop | yes | no | yes | no | yes | iPad only |
| Paste files | yes | assume no | 116+ | **no** | yes | assume no |
| `share_target` | Windows and ChromeOS only | yes, needs WebAPK | no | parses, does nothing | no | no |
| `file_handlers` | yes, install required | **no** | no | no | no | no |

Two entries deserve emphasis because they invert an obvious assumption:

- **Paste is a desktop mechanism, not a universal one.** Firefox Android does not implement `clipboardData.files` at all, and it is unattested on Chromium Android and iOS. Treating paste as the mobile fallback would leave the two weakest platforms with nothing.
- **`navigator.clipboard.read()` cannot read files.** Its format set is text, HTML and PNG. It is not a more modern version of `clipboardData.files`; it is a different and less capable thing. Do not conflate them.

- [ ] **Step 2: Detect by receipt, not by capability**

The rule: **advertise nothing until it is feature-detected or receipt-confirmed.** Every rung above the picker reveals itself.

This exists because Firefox Android *parses* `share_target` and silently ignores it. There is no error and nothing to detect, so an app that promises a share menu entry on the strength of its own manifest lies on that browser. The only honest evidence a share target works is a share arriving.

```js
// Receipt-confirmed capabilities. A promise the browser does not keep is worse
// than an affordance we never offered, so nothing here is set from a manifest
// member or a user agent string: each flag is written the first time the thing
// actually happens.
const FLAGS = 'capabilities';

export async function capabilities() {
  return (await kvGet(FLAGS)) || {};
}

export async function markCapability(name) {
  const current = await capabilities();
  if (current[name]) return;
  await kvPut(FLAGS, { ...current, [name]: true });
}

export function observeCapabilities({ doc = document, win = window } = {}) {
  // Paste: attach unconditionally and let a real delivery prove it. Firefox
  // Android never fires with files, which is exactly why it never gets the hint.
  doc.addEventListener('paste', (e) => {
    if (e.clipboardData?.files?.length) markCapability('paste');
  });

  // Drag: the zone is drawn on a real dragenter carrying files rather than from
  // a capability check, so it simply never appears on a phone.
  doc.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) markCapability('drop');
  });

  // The only honest install signal. It fires in Chromium and never in Firefox
  // or Safari, so an install card cannot appear where installing buys nothing.
  win.addEventListener('beforeinstallprompt', () => markCapability('installable'));

  if ('launchQueue' in win) markCapability('fileHandlerApi');
}
```

The service worker calls `markCapability('shareTarget')` the first time a share POST lands. Until then the install card says installing **may** add Airlock to the share menu, never that it will.

- [ ] **Step 3: Make the picker excellent, since most browsers live on it**

```js
// No accept attribute. iOS variously ignores it or over-filters, and the files
// it breaks on are exactly the ones this product is for: .bin, .enc, anything
// without a recognized extension. A picker that silently refuses to show a file
// is worse than one that shows everything.
<input type="file" multiple>
```

Add a folder picker behind detection, and verify the result rather than the attribute: Firefox Android accepts `webkitdirectory` but returns an empty `webkitRelativePath`, silently flattening the hierarchy. After a pick, if no file has a relative path, treat the selection as flat and say so rather than reconstructing a structure that was not delivered.

Bind `Ctrl+O` to `showPicker()` where `typeof HTMLInputElement.prototype.showPicker === 'function'`.

- [ ] **Step 4: Folder drops, and the traps in them**

```js
export async function filesFromDrop(dataTransfer) {
  const entries = [...(dataTransfer.items || [])]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length === 0) return [...dataTransfer.files];

  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push(prefix ? new File([file], prefix + file.name, { type: file.type }) : file);
      return;
    }
    const reader = entry.createReader();
    // readEntries yields at most 100 per call and signals the end with an empty
    // batch. Calling it once silently truncates any folder of 101 files or more.
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}
```

Call `preventDefault()` on **both** `dragover` and `drop`. Missing either makes the browser navigate away and open the file instead, losing whatever was staged.

- [ ] **Step 5: Two traps in the pipeline, not the UI**

- **Hold a `Blob`, not the `File` handle**, once a file enters the chunking pipeline. A `File` is a live reference to something on disk; if the source is moved or deleted mid-transfer, `arrayBuffer()` rejects with `NotReadableError` partway through. Take `file.slice()` up front, which snapshots.
- **`file.name` is not trustworthy.** A clipboard screenshot arrives as `image.png`, and an iOS Photos pick may arrive as `image.jpg` with EXIF stripped and a name the user has never seen. Show the name, let it be edited before sending, and never key anything on it.

- [ ] **Step 6: What each browser shows**

No user-agent sniffing anywhere. Each affordance suppresses itself through the detection above.

- **Chromium desktop:** picker, drop zone, paste hint, and an install card whose copy promises only "Open with Airlock", which is true on every desktop OS. Promote to a share-menu claim only after a share is received.
- **Chromium Android:** picker and install card. Drop and paste hide themselves because their events never fire.
- **Firefox desktop:** picker, drop zone, paste hint on 116+. No install card ever, since `beforeinstallprompt` never fires. **Nothing mentions a share sheet.**
- **Firefox Android:** the picker, as the whole screen: one large Choose file button. This is the weakest inbound story of any engine and the UI should not pretend otherwise.
- **Safari macOS:** picker, drop zone, paste hint. No install card.
- **Safari iOS:** picker only. Do not ship a paste affordance until a real `File` has been observed arriving from the Files app, and do not advertise iPad drag and drop until a file with an unrecognized extension has been dropped successfully.

- [ ] **Step 7: Tests**

`web/inbound.test.mjs` with fake document, window and storage:

- a `paste` with no files does not set the flag; one with files does
- a `dragenter` without `Files` in `types` does not set the flag
- `beforeinstallprompt` sets `installable`; never firing leaves it unset, and the install card is therefore never shown on a Firefox-shaped fake
- `filesFromDrop` walks a nested folder fake and returns paths in the names
- `filesFromDrop` keeps reading past a 100-entry batch, using a fake reader that returns 100 then 50 then empty; asserting 150 files is the regression test for the truncation trap
- with no `items`, it falls back to `dataTransfer.files`
- `markCapability` is idempotent and never clears a flag

- [ ] **Step 8: One honest sentence in the README**

> Airlock accepts files everywhere through the in-app picker, plus drag and drop and paste on desktop browsers. "Share to Airlock" from the OS share sheet is a Chromium-only bonus, available on Chrome for Android and ChromeOS, and as "Open with Airlock" on installed Chrome or Edge desktop. It does not exist in Firefox or on iOS, where you open Airlock and pick the file.

Also worth a link rather than a build: **Taildrop** already ships with Tailscale on every one of these devices and does register in the iOS and Android share sheets. It does not put the file in Airlock and it is not encrypted in Airlock's sense, but for "get this file to my other device" it covers exactly the gap where Airlock's inbound story is weakest. Point at it in the Firefox Android and iOS sections rather than pretending the gap is not there.

- [ ] **Step 9: Commit**

```bash
git add web/inbound.js web/inbound.test.mjs web/views/send.js web/app.js web/sw.js README.md
git commit -m "feat(web): receipt-detected inbound affordances with the picker as the floor"
```
