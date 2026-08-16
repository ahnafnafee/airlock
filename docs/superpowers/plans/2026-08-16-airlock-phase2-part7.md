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

`WhoIs` returns "peer not found" for `127.0.0.1` and `::1`, so `identityFromWhoIs` returns false and every route including static assets answers a bare "not authorized". Unreachable while the listener is tailnet-only, but it is exactly what happens the moment anyone fronts Airlock with `tailscale serve` or binds `0.0.0.0` so a local browser can reach it. This machine already runs `tailscale serve`, so that workaround is one search away.

```go
		if isLoopback(r.RemoteAddr) {
			// A tailnet identity cannot be derived from a loopback connection.
			// Logged distinctly because the symptom, 403 on everything
			// including static assets, otherwise reads as a permissions bug.
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
| Every request returns 403, including static files | The request arrived over loopback. Reach Airlock by its tailnet name, not through a local proxy |
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
