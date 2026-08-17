# Airlock Phase 2 Implementation Plan, part 3: measurement and deployment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-16-airlock-phase2-part2.md`, tasks 18 through 20. Numbering is unbroken and the Phase 2 Global Constraints bind every task here.

---

### Task 21: Android shell, CUT

**Not built.** This task existed to serve exactly one capability that a service
worker cannot provide: writing a received file to the filesystem with the app
closed. Everything else on the Android side, the share sheet, notifications,
install, and file handlers, the PWA already does.

The owner chose notification-then-tap instead, and that is the right call. The
module's cost was a second implementation of the crypto in Kotlin, and drift
between two implementations produces files that download successfully and cannot
be opened, which is the worst failure mode available in this project. Generated
test vectors would have contained that risk rather than removing it.

Airlock is a browser-only product. If silent background receive is ever wanted
literally, this task is recoverable from git history along with its vector
generator, and nothing built since depends on its absence.

---

### Task 22: Throughput benchmark and the plaintext toggle

**Files:**
- Create: `bench_test.go`
- Create: `docs/benchmarks.md`
- Modify: `web/views/send.js` (the sealing toggle)
- Modify: `web/app.js` (carry the mode)

**Two decisions are waiting on numbers.** Whether `host` really beats `embedded` for the Tailscale mode default, and whether turning off encryption is worth anything at all. Both get measured here, and the answers get written down whichever way they come out.

**My prediction, recorded before running it, so the result can contradict me:** encryption will not be measurable against network time, because AES-GCM and SHA-256 reach native code through Web Crypto at gigabytes per second while a tailnet moves tens of megabytes per second. If that prediction is wrong the toggle earns its place; if it is right, the toggle stays but the documentation says plainly that it buys nothing.

- [ ] **Step 1: Write the local pipeline benchmark**

Create `bench_test.go`:

```go
package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// BenchmarkChunkStorePut measures the server side of an upload in isolation, so
// a slow end-to-end number can be attributed to the network rather than guessed
// at.
func BenchmarkChunkStorePut(b *testing.B) {
	for _, size := range []int{64 << 10, 1 << 20, 8 << 20} {
		b.Run(fmt.Sprintf("%dKiB", size>>10), func(b *testing.B) {
			dir := b.TempDir()
			store, err := NewChunkStore(dir, int64(size)+1024, 1<<40)
			if err != nil {
				b.Fatal(err)
			}
			body := make([]byte, size)
			rand.Read(body)

			b.SetBytes(int64(size))
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				id := fmt.Sprintf("%064x", i)
				if err := store.Put(id, strings.NewReader(string(body))); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkSweep measures mark-and-sweep against a realistic chunk count, which
// is the one operation whose cost grows with the store rather than the transfer.
func BenchmarkSweep(b *testing.B) {
	dir := b.TempDir()
	store, _ := NewChunkStore(dir, 4096, 1<<40)
	transfers, _ := NewTransfers(dir, store, time.Hour, 100000, 4096)

	cids := make([]string, 5000)
	for i := range cids {
		cids[i] = fmt.Sprintf("%064x", i)
		store.Put(cids[i], strings.NewReader("x"))
	}
	transfers.Create("bench", nil, cids)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		referenced, err := transfers.Referenced()
		if err != nil {
			b.Fatal(err)
		}
		if _, err := store.Sweep(referenced); err != nil {
			b.Fatal(err)
		}
	}
	_ = os.Remove
}
```

Run: `go test -bench=. -benchmem -run=^$ ./...`

- [ ] **Step 2: Measure the two Tailscale modes**

The comparison that decides the default. On the server, in each mode in turn, with the client on another tailnet device:

```bash
head -c 8388608 /dev/urandom > /tmp/chunk8m
time for i in $(seq 1 128); do
  id=$(printf '%064x' $i)
  curl -s -o /dev/null -X PUT --data-binary @/tmp/chunk8m \
    "https://<node>.<tailnet>.ts.net/api/chunk/$id"
done
```

1 GiB per run. Record MB/s for `--tailscale-mode=host` and for `--tailscale-mode=embedded`.

- [ ] **Step 3: Measure sealed against plaintext**

In the browser, with the same file and a warm cache, upload once with sealing on and once off. Use the Performance panel to separate time spent in `chunkIdentity` and `sealChunk` from time spent in `fetch`. Record all three: total wall clock, crypto time, network time.

- [ ] **Step 4: Write down what happened**

Create `docs/benchmarks.md` with a table for each measurement, the hardware and network it was taken on, the date, and a short conclusion for each of the two open decisions. If a measurement contradicts the design's stated reasoning, say so in that file and open the question rather than burying it.

- [ ] **Step 5: Add the sealing toggle**

In `web/views/send.js`, above the recipient picker:

```js
  const sealed = el('input', { type: 'checkbox', id: 'sealed', checked: true });
  const sealNote = el('span', { class: 'data sealed' }, 'Sealed on this device');
  sealed.addEventListener('change', () => {
    state.mode = sealed.checked ? MODE_SEALED : MODE_PLAIN;
    sealNote.textContent = sealed.checked
      ? 'Sealed on this device'
      : 'Not sealed. Anyone with access to the server can read this.';
    sealNote.className = sealed.checked ? 'data sealed' : 'data bad';
  });
```

Import `MODE_SEALED` and `MODE_PLAIN` from `../crypto.js`. The copy is fixed by the visual design spec: the off state states the consequence plainly rather than softening it, and the warning color is `--breach`, which is used for nothing else.

Uploads read `state.mode`, so nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add bench_test.go docs/benchmarks.md web/views/send.js web/app.js
git commit -m "feat(bench): pipeline benchmarks, measured mode comparison and the sealing toggle"
```

---

### Task 23: Deployment and hardening

**Files:**
- Create: `deploy/airlock.service`, `deploy/sysctl-airlock.conf`
- Modify: `README.md`

- [ ] **Step 1: Write the systemd unit**

`deploy/airlock.service`:

```ini
[Unit]
Description=Airlock encrypted transfer
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=airlock
Group=airlock
ExecStart=/usr/local/bin/airlock --data /var/lib/airlock
Restart=on-failure
RestartSec=5

StateDirectory=airlock
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
ReadWritePaths=/var/lib/airlock

# Host mode reaches the tailscaled local API socket, which is root-owned on most
# installs. Grant the group rather than running the whole service as root.
SupplementaryGroups=tailscale

# Binding 443 without privilege.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the tuning notes**

`deploy/sysctl-airlock.conf`:

```conf
# Larger UDP buffers let the kernel batch WireGuard datagrams, which is where
# Tailscale's GSO and GRO throughput work pays off. Without these the receive
# path drops under load and throughput collapses well before the link does.
net.core.rmem_max = 7500000
net.core.wmem_max = 7500000
```

Apply with `sudo cp deploy/sysctl-airlock.conf /etc/sysctl.d/ && sudo sysctl --system`, then confirm `tailscale netcheck` no longer reports a UDP receive buffer warning.

- [ ] **Step 3: Bring the README up to date**

Rewrite the Status section to reflect what actually shipped, replace the flag table with the real flags, and add three things it currently lacks: the `--tailscale-mode` measurement result from `docs/benchmarks.md`, an Android install section, and a short "what this does not protect against" list naming chunk-equality leakage under dedup and the fact that a device holding the passphrase can read everything.

Re-read the whole README against the code before committing. Every enumerated claim in it, counts, file lists, flag names, is a claim that rots, so verify each one rather than patching the ones that look wrong.

- [ ] **Step 4: Full verification pass**

```bash
go vet ./... && go test ./... && go test -bench=. -run=^$ ./...
node --test web/*.test.mjs
cd android && ./gradlew :app:testDebugUnitTest
```

Then end to end on real hardware, with a phone and two desktops on the tailnet:

1. Send a 2 GB file desktop to desktop. `cmp` the result.
2. Send the same file again and confirm nothing uploads.
3. Append to it and send; confirm only the tail uploads.
4. Share a photo from the phone's gallery.
5. Close the Android app entirely and confirm the next send lands in Downloads on its own.
6. Pull the network mid-upload and confirm it resumes.
7. Reload mid-upload and confirm it resumes with no stored client state.
8. Revoke a device and confirm 403 on its next request.
9. `cat` a chunk on the server and confirm it is unreadable.
10. Corrupt a chunk on the server and confirm the download fails rather than producing a damaged file.

- [ ] **Step 5: Commit**

```bash
git add deploy README.md
git commit -m "docs: deployment unit, kernel tuning and a verified readme"
```
