# Airlock Phase 2 Implementation Plan, part 1: server features

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the Phase 1 foundation deliberately left out: correct authorization scoping, push notification, thumbnails, device pairing, and transfer history.

**Prerequisite:** Phase 1 tasks 1 through 12 complete. Task numbering continues from there.

**Specs:** `docs/superpowers/specs/2026-08-15-airlock-design.md` for behavior, `docs/superpowers/specs/2026-08-15-airlock-visual-design.md` for every color, type, spacing and copy decision. The visual spec is binding: no color, typeface or phrase that is not in it.

## Global Constraints

Identical to Phase 1, in `docs/superpowers/plans/2026-08-15-airlock.md`. In summary: Go module `airlock`, package `main`; exactly two Go dependencies (`tailscale.com`, `webpush-go`); zero frontend dependencies and no build step; chunk ids `^[0-9a-f]{64}$` and transfer ids `^[0-9a-f]{32}$` validated before any path is built; permissions `0o700` and `0o600`; US English with **no em dashes or en dashes anywhere including comments**; `ponytail:` comments on deliberate simplifications; Conventional Commits with **no AI attribution trailer**.

---

### Task 13: Scope inbox, history and deletion to the caller

**Files:**
- Modify: `transfers.go`
- Modify: `server.go`
- Test: `transfers_test.go`, `server_test.go`

**Interfaces:**
- Changed: `func (t *Transfers) History(node string) ([]Tombstone, error)`
- Changed: `func (t *Transfers) Delete(id, node string) error`
- New unexported: `func (t *Transfers) remove(info *TransferInfo) error`, `func visibleTo(sender string, to []string, node string) bool`

**Why this exists.** An automated security review found that `GET /api/history` returned every tombstone while `GET /api/inbox` filtered by recipient, and that `DELETE` performed no ownership check at all. Both are real. The filenames stay sealed either way, so no content leaks, but which devices talk to each other does, and that is exactly the metadata the sealed records were designed to withhold.

An earlier design ruling permitted any allowlisted device to delete anything, reasoning that a device holding the passphrase can already read everything. That reasoning was incomplete twice over: disclosure and destruction are different harms and only one is recoverable, and once transfers carry a recipient list, letting an unrelated device delete an addressed transfer is surprising rather than permissive.

One predicate now serves all three endpoints: a device may see and delete exactly the transfers it sent, plus those addressed to it or to everyone.

- [ ] **Step 1: Write the failing tests**

Append to `transfers_test.go`:

```go
func TestHistoryIsScopedToTheCaller(t *testing.T) {
	tr, _ := newTransfers(t)
	mine, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	sent, _, _ := tr.Create("desktop", nil, []string{cid(1)})
	theirs, _, _ := tr.Create("pixel", []string{"laptop"}, []string{cid(1)})

	for _, id := range []string{mine.ID, sent.ID, theirs.ID} {
		if err := tr.Delete(id, "pixel"); err != nil && id != theirs.ID {
			t.Fatal(err)
		}
	}
	// Clean up the one pixel may not touch, as the server would on expiry.
	tr.Delete(theirs.ID, "pixel")

	hist, err := tr.History("desktop")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, h := range hist {
		seen[h.ID] = true
	}
	if !seen[mine.ID] {
		t.Fatal("a tombstone addressed to this node is missing")
	}
	if !seen[sent.ID] {
		t.Fatal("a tombstone this node sent is missing")
	}
	if seen[theirs.ID] {
		t.Fatal("a tombstone for another device's transfer leaked into this history")
	}
}

func TestDeleteRequiresSenderOrRecipient(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})

	// A node that is neither sender nor addressee gets ErrNotFound rather than a
	// distinct error, so the endpoint never confirms that a transfer it has no
	// business knowing about exists.
	if err := tr.Delete(rec.ID, "laptop"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if _, err := tr.Get(rec.ID); err != nil {
		t.Fatal("the refused delete must not have removed anything")
	}
	if err := tr.Delete(rec.ID, "desktop"); err != nil {
		t.Fatalf("the addressee should be able to delete: %v", err)
	}
}

func TestSenderCanDeleteTheirOwnTransfer(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	if err := tr.Delete(rec.ID, "pixel"); err != nil {
		t.Fatalf("the sender should be able to delete: %v", err)
	}
}

func TestUnaddressedTransfersAreDeletableByAnyone(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	if err := tr.Delete(rec.ID, "laptop"); err != nil {
		t.Fatalf("an unaddressed transfer is everyone's: %v", err)
	}
}

func TestSweepIgnoresAddressingWhenExpiring(t *testing.T) {
	dir := t.TempDir()
	c, _ := NewChunkStore(dir, 64, 1<<20)
	tr, _ := NewTransfers(dir, c, time.Millisecond, 100, 4096)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	time.Sleep(10 * time.Millisecond)

	// Expiry is the server's own action, not one performed on behalf of a
	// device, so the visibility rule must not block it.
	n, err := tr.Sweep(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("swept %d, want 1", n)
	}
	if _, err := tr.Get(rec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("an addressed transfer survived expiry")
	}
}
```

Append to `server_test.go`:

```go
func TestHistoryEndpointIsScoped(t *testing.T) {
	s, _ := newTestServer(t, true) // identity is always node "pixel"
	mine, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["pixel"]}`)
	theirs, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["laptop"]}`)
	do(t, s, "DELETE", "/api/transfer/"+mine, "")

	var hist []map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/history", "").Body.Bytes(), &hist)
	for _, h := range hist {
		if h["id"] == theirs {
			t.Fatal("another device's tombstone leaked into this history")
		}
	}
}

func TestDeleteOfAnotherDevicesTransferIs404(t *testing.T) {
	s, _ := newTestServer(t, true)
	theirs, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["laptop"]}`)
	if code := do(t, s, "DELETE", "/api/transfer/"+theirs, "").Code; code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", code)
	}
	if code := do(t, s, "GET", "/api/transfer/"+theirs, "").Code; code != http.StatusOK {
		t.Fatal("the refused delete removed the transfer anyway")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./...`
Expected: FAIL, `History` and `Delete` take the wrong number of arguments.

- [ ] **Step 3: Change `transfers.go`**

Add the predicate and split deletion into a scoped and an unscoped path:

```go
// visibleTo reports whether a node may see and act on a transfer. One predicate
// serves the inbox, the history and deletion, because the device that can see a
// transfer is exactly the device that may remove it.
func visibleTo(sender string, to []string, node string) bool {
	return sender == node || addressedTo(to, node)
}

// Delete removes a transfer on behalf of a device. A caller that cannot see the
// transfer gets ErrNotFound rather than a distinct error, so the endpoint never
// confirms the existence of a transfer the caller has no business knowing about.
func (t *Transfers) Delete(id, node string) error {
	info, err := t.Get(id)
	if err != nil {
		return err
	}
	if !visibleTo(info.Sender, info.To, node) {
		return ErrNotFound
	}
	return t.remove(info)
}

// remove is the unscoped deletion. Expiry is the server's own action rather than
// one performed for a device, so the sweep goes through here and the visibility
// rule does not block it.
func (t *Transfers) remove(info *TransferInfo) error {
	if err := t.appendTombstone(info); err != nil {
		return err
	}
	dir, err := t.transferDir(info.ID)
	if err != nil {
		return err
	}
	return os.RemoveAll(dir)
}
```

Change `Inbox` to use the shared predicate:

```go
		if visibleTo(info.Sender, info.To, node) {
			out = append(out, info)
		}
```

Change `History` to take and apply the node:

```go
func (t *Transfers) History(node string) ([]Tombstone, error) {
	t.histMu.Lock()
	defer t.histMu.Unlock()
	all, err := t.historyLocked()
	if err != nil {
		return nil, err
	}
	hist := make([]Tombstone, 0, len(all))
	for _, tomb := range all {
		if visibleTo(tomb.Sender, tomb.To, node) {
			hist = append(hist, tomb)
		}
	}
	sort.Slice(hist, func(i, j int) bool { return hist[i].EndedAt.After(hist[j].EndedAt) })
	return hist, nil
}
```

In `Sweep`, replace the `t.Delete(e.Name())` call with a `Get` followed by `t.remove(info)`.

- [ ] **Step 4: Thread the identity through `server.go`**

```go
func (s *Server) deleteTransfer(w http.ResponseWriter, r *http.Request) {
	if fail(w, s.cfg.Transfers.Delete(r.PathValue("id"), who(r).Node)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	hist, err := s.cfg.Transfers.History(who(r).Node)
	if fail(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, hist)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go vet ./... && go test ./... -v`

- [ ] **Step 6: Commit**

```bash
git add transfers.go server.go transfers_test.go server_test.go
git commit -m "fix(server): scope inbox, history and delete to the caller's own transfers"
```

---

### Task 14: Web Push

**Files:**
- Modify: `push.go` (replace the stub)
- Modify: `server.go` (add the subscribe route)
- Modify: `web/sw.js` (push and notificationclick handlers)
- Modify: `web/app.js` (subscribe after unlock)
- Test: `push_test.go`

**Interfaces:**
- Consumes: the `Pusher` call sites already present from Phase 1, which call `PublicKey()` and `Notify(recipients []string, sender string)`.
- Produces: `func NewPusher(dir, subject string) (*Pusher, error)`, `func (p *Pusher) Subscribe(node string, raw []byte) error`, `func (p *Pusher) Count() int`, unchanged signatures for `PublicKey` and `Notify`.

**Pushes carry no payload.** A payload would put the filename on the other side of the encryption boundary, in a message routed through Google's or Mozilla's servers. The worker wakes, fetches the inbox, decrypts the newest transfer's metadata locally, and shows a notification with the real name. The push itself says nothing.

- [ ] **Step 1: Add the dependency**

```bash
go get github.com/SherClockHolmes/webpush-go@latest
```

- [ ] **Step 2: Write the failing tests**

Create `push_test.go`:

```go
package main

import "testing"

func TestVapidKeysPersistAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	p, err := NewPusher(dir, "mailto:test@invalid")
	if err != nil {
		t.Fatal(err)
	}
	if p.PublicKey() == "" {
		t.Fatal("a VAPID public key should be generated on first run")
	}

	again, err := NewPusher(dir, "mailto:test@invalid")
	if err != nil {
		t.Fatal(err)
	}
	// Regenerating would silently invalidate every existing subscription, which
	// looks exactly like push being broken.
	if again.PublicKey() != p.PublicKey() {
		t.Fatal("VAPID keys must survive a restart")
	}
}

func TestSubscribeIsIdempotentPerEndpoint(t *testing.T) {
	dir := t.TempDir()
	p, _ := NewPusher(dir, "mailto:test@invalid")
	raw := []byte(`{"endpoint":"https://push.example/abc","keys":{"p256dh":"k","auth":"a"}}`)

	for i := 0; i < 3; i++ {
		if err := p.Subscribe("pixel", raw); err != nil {
			t.Fatal(err)
		}
	}
	if p.Count() != 1 {
		t.Fatalf("count = %d, want 1 for a repeated endpoint", p.Count())
	}

	reloaded, _ := NewPusher(dir, "mailto:test@invalid")
	if reloaded.Count() != 1 {
		t.Fatalf("count after reload = %d, want 1", reloaded.Count())
	}
}

func TestSubscribeRejectsMissingEndpoint(t *testing.T) {
	p, _ := NewPusher(t.TempDir(), "mailto:test@invalid")
	if err := p.Subscribe("pixel", []byte(`{"keys":{"p256dh":"k","auth":"a"}}`)); err == nil {
		t.Fatal("a subscription with no endpoint should be refused")
	}
	if err := p.Subscribe("pixel", []byte("not json")); err == nil {
		t.Fatal("malformed json should be refused")
	}
}

func TestTargetsExcludeTheSenderAndRespectAddressing(t *testing.T) {
	p, _ := NewPusher(t.TempDir(), "mailto:test@invalid")
	for _, node := range []string{"pixel", "desktop", "laptop"} {
		raw := []byte(`{"endpoint":"https://push.example/` + node + `","keys":{"p256dh":"k","auth":"a"}}`)
		if err := p.Subscribe(node, raw); err != nil {
			t.Fatal(err)
		}
	}

	// Addressed to desktop, sent by pixel: only desktop should be woken.
	got := nodesOf(p.targets([]string{"desktop"}, "pixel"))
	if len(got) != 1 || got[0] != "desktop" {
		t.Fatalf("targets = %v, want [desktop]", got)
	}

	// Unaddressed: everyone except the sender.
	got = nodesOf(p.targets(nil, "pixel"))
	if len(got) != 2 {
		t.Fatalf("targets = %v, want two devices", got)
	}
	for _, n := range got {
		if n == "pixel" {
			t.Fatal("the sender must never be notified of its own upload")
		}
	}
}

func nodesOf(subs []subscription) []string {
	out := make([]string, 0, len(subs))
	for _, s := range subs {
		out = append(out, s.Node)
	}
	return out
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./...`
Expected: FAIL, undefined `NewPusher`, `Subscribe`, `Count`, `targets`, `subscription`.

- [ ] **Step 4: Replace `push.go`**

```go
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	webpush "github.com/SherClockHolmes/webpush-go"
)

type subscription struct {
	Node string               `json:"node"`
	Sub  webpush.Subscription `json:"sub"`
}

type vapidKeys struct {
	Private string `json:"private"`
	Public  string `json:"public"`
}

// Pusher owns the VAPID identity and the device subscription list. Both persist
// in the data directory, because regenerating the keys would silently invalidate
// every existing subscription and look exactly like push being broken.
type Pusher struct {
	dir     string
	subject string
	keys    vapidKeys

	mu   sync.Mutex
	subs []subscription
}

func NewPusher(dir, subject string) (*Pusher, error) {
	p := &Pusher{dir: dir, subject: subject}

	keyPath := filepath.Join(dir, "vapid.json")
	if b, err := os.ReadFile(keyPath); err == nil {
		if err := json.Unmarshal(b, &p.keys); err != nil {
			return nil, err
		}
	} else {
		priv, pub, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			return nil, err
		}
		p.keys = vapidKeys{Private: priv, Public: pub}
		out, err := json.Marshal(p.keys)
		if err != nil {
			return nil, err
		}
		if err := atomicWrite(keyPath, out); err != nil {
			return nil, err
		}
	}

	if b, err := os.ReadFile(filepath.Join(dir, "subs.json")); err == nil {
		if err := json.Unmarshal(b, &p.subs); err != nil {
			return nil, err
		}
	}
	return p, nil
}

func (p *Pusher) PublicKey() string { return p.keys.Public }

func (p *Pusher) Count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.subs)
}

func (p *Pusher) Subscribe(node string, raw []byte) error {
	var sub webpush.Subscription
	if err := json.Unmarshal(raw, &sub); err != nil {
		return err
	}
	if sub.Endpoint == "" {
		return errors.New("subscription has no endpoint")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.subs {
		if p.subs[i].Sub.Endpoint == sub.Endpoint {
			p.subs[i] = subscription{Node: node, Sub: sub}
			return p.saveLocked()
		}
	}
	p.subs = append(p.subs, subscription{Node: node, Sub: sub})
	return p.saveLocked()
}

// targets picks the devices to wake. The sender is never one of them, and an
// addressed transfer wakes only its recipients.
func (p *Pusher) targets(recipients []string, sender string) []subscription {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]subscription, 0, len(p.subs))
	for _, s := range p.subs {
		if s.Node == sender {
			continue
		}
		if len(recipients) > 0 && !addressedTo(recipients, s.Node) {
			continue
		}
		out = append(out, s)
	}
	return out
}

// Notify wakes the relevant devices. The push deliberately carries no useful
// payload: the filename lives behind the encryption boundary and this message
// travels through a third-party push service, so the worker fetches and
// decrypts the name locally instead.
func (p *Pusher) Notify(recipients []string, sender string) {
	var dead []string
	for _, s := range p.targets(recipients, sender) {
		sub := s.Sub
		res, err := webpush.SendNotification([]byte("{}"), &sub, &webpush.Options{
			Subscriber:      p.subject,
			VAPIDPublicKey:  p.keys.Public,
			VAPIDPrivateKey: p.keys.Private,
			TTL:             3600,
		})
		if err != nil {
			log.Printf("push to %s: %v", s.Node, err)
			continue
		}
		res.Body.Close()
		if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone {
			dead = append(dead, sub.Endpoint)
		}
	}
	if len(dead) > 0 {
		p.prune(dead)
	}
}

func (p *Pusher) prune(endpoints []string) {
	gone := make(map[string]bool, len(endpoints))
	for _, e := range endpoints {
		gone[e] = true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	kept := p.subs[:0]
	for _, s := range p.subs {
		if !gone[s.Sub.Endpoint] {
			kept = append(kept, s)
		}
	}
	p.subs = kept
	if err := p.saveLocked(); err != nil {
		log.Printf("prune: %v", err)
	}
}

func (p *Pusher) saveLocked() error {
	b, err := json.Marshal(p.subs)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(p.dir, "subs.json"), b)
}
```

- [ ] **Step 5: Add the route and build the real Pusher**

In `server.go`, add to `routes()`:

```go
	s.mux.HandleFunc("POST /api/push/subscribe", g(s.subscribe))
```

and append:

```go
func (s *Server) subscribe(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	if err := s.cfg.Push.Subscribe(who(r).Node, raw); err != nil {
		http.Error(w, "bad subscription", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

In `main.go`, replace `pusher := &Pusher{}` with:

```go
	pusher, err := NewPusher(*dataDir, *vapidSubject)
	if err != nil {
		return err
	}
```

- [ ] **Step 6: Handle push in the worker**

Append to `web/sw.js`, adding `openRecord` and `DOMAIN` to its existing imports if absent:

```js
self.addEventListener('push', (event) => {
  event.waitUntil(announce());
});

// The push itself says nothing. Everything shown here is decrypted on this
// device, which is the only place the filename exists in the clear.
async function announce() {
  let body = 'A file is waiting';
  try {
    const mk = await loadMaster();
    const [newest] = await (await fetch('/api/inbox')).json();
    if (mk && newest && newest.complete) {
      const meta = JSON.parse(new TextDecoder().decode(
        await openRecord(mk, DOMAIN.META, newest.id, b64decode(newest.meta))));
      body = meta.name;
    }
  } catch {
    // Locked device, or a fetch that failed because Tailscale is down. The
    // generic line still tells the owner something arrived.
  }
  return self.registration.showNotification('Airlock', {
    body, tag: 'inbox', icon: '/icon-192.png',
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      if (client.url.startsWith(self.location.origin)) return client.focus();
    }
    return self.clients.openWindow('/');
  })());
});
```

- [ ] **Step 7: Subscribe from the page**

Append to `web/app.js` and call `subscribePush()` at the end of `enterApp()`:

```js
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscribePush() {
  if (!state.config.vapidKey || !('Notification' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (await Notification.requestPermission() !== 'granted') return;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.config.vapidKey),
      });
    await api.subscribePush(sub);
  } catch (err) {
    console.warn('push subscription failed', err);
  }
}
```

Add to `web/api.js`:

```js
  subscribePush: (sub) => sendJSON('/api/push/subscribe', sub),
```

- [ ] **Step 8: Verify**

Run `go vet ./... && go test ./...`. Push itself needs a real HTTPS origin, so the on-device checks happen against the deployed tailnet server:

1. Open the app on two devices and accept the notification prompt on both.
2. Confirm `data/subs.json` on the server holds one entry per device.
3. Send from device A. Device B notifies with the real filename; device A does not notify itself.
4. Lock device B's screen and send again. The notification arrives with the screen off.
5. Send addressed to device C only, and confirm device B does not notify.
6. Tap a notification and confirm the app opens rather than a second window appearing.

- [ ] **Step 9: Commit**

```bash
git add push.go push_test.go server.go main.go web/sw.js web/app.js web/api.js go.mod go.sum
git commit -m "feat(push): payload-free web push with client-side name decryption"
```

---

### Task 15: Thumbnails

**Files:**
- Create: `web/thumb.js`
- Modify: `web/upload.js` (attach a thumbnail when one can be made)
- Modify: `web/views/inbox.js` (render it)
- Modify: `web/app.css`
- Test: `web/thumb.test.mjs`

**Interfaces:**
- Produces: `export async function makeThumbnail(file) -> Uint8Array | null`, `export const THUMB_MAX = 256`

**The server cannot make these.** It has never seen the image. Thumbnails are generated on the sending device, sealed under the record key with the `THUMB` domain, and stored as a small per-transfer record like any other. A transfer with no thumbnail simply has no `thumb` record, which is the common case for anything that is not an image or a video.

- [ ] **Step 1: Write the failing tests**

Create `web/thumb.test.mjs`. Node has no canvas, so the tests cover the decision logic and the guard rails rather than the pixels.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { thumbnailable, THUMB_MAX } from './thumb.js';

test('only images and videos are thumbnailed', () => {
  assert.equal(thumbnailable('image/jpeg'), true);
  assert.equal(thumbnailable('image/png'), true);
  assert.equal(thumbnailable('video/mp4'), true);
  assert.equal(thumbnailable('application/pdf'), false);
  assert.equal(thumbnailable('text/plain'), false);
  assert.equal(thumbnailable(''), false);
  assert.equal(thumbnailable(undefined), false);
});

test('image/svg+xml is refused', () => {
  // An SVG is a document that can reference remote content and run script when
  // rendered. Drawing an untrusted one to a canvas to make a thumbnail is not
  // worth the surface for a format that is already tiny.
  assert.equal(thumbnailable('image/svg+xml'), false);
});

test('the long edge cap is small enough to stay inside a record', () => {
  // Thumbnails ride in the inbox listing, so one per transfer must stay well
  // under the server's record cap.
  assert.ok(THUMB_MAX <= 256);
});
```

- [ ] **Step 2: Write `web/thumb.js`**

```js
export const THUMB_MAX = 256;
const QUALITY = 0.7;

// SVG is deliberately excluded: it is a document that can reference remote
// content and run script when rendered, and drawing an untrusted one to a canvas
// is not a surface worth opening for a format that is already small.
export function thumbnailable(mime) {
  if (!mime) return false;
  if (mime === 'image/svg+xml') return false;
  return mime.startsWith('image/') || mime.startsWith('video/');
}

function fit(width, height) {
  const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

async function draw(source, width, height) {
  const [w, h] = fit(width, height);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
  return new Uint8Array(await blob.arrayBuffer());
}

// makeThumbnail returns null rather than throwing for anything it cannot handle.
// A missing thumbnail is normal and must never fail a transfer.
export async function makeThumbnail(file) {
  if (!thumbnailable(file.type)) return null;
  try {
    if (file.type.startsWith('image/')) {
      const bitmap = await createImageBitmap(file);
      try {
        return await draw(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    }
    return await videoFrame(file);
  } catch {
    return null;
  }
}

function videoFrame(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (value) => { URL.revokeObjectURL(url); resolve(value); };

    video.muted = true;
    video.preload = 'metadata';
    video.addEventListener('error', () => done(null));
    video.addEventListener('loadeddata', async () => {
      try {
        done(await draw(video, video.videoWidth, video.videoHeight));
      } catch {
        done(null);
      }
    });
    // Seek slightly in: the first frame of a video is very often black.
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(1, (video.duration || 0) / 10);
    });
    video.src = url;
  });
}
```

- [ ] **Step 3: Attach it during upload**

In `web/upload.js`, import `makeThumbnail` and extend `uploadRecords` to send one when it exists:

```js
  const thumb = await makeThumbnail(file);
  if (thumb) {
    const sealed = await sealRecord(mk, mode, DOMAIN.THUMB, id, thumb);
    // A thumbnail is a nicety. Losing it must never fail the transfer.
    await withRetry(() => api.putRecord(id, 'thumb', sealed)).catch(() => {});
  }
```

- [ ] **Step 4: Render it in the inbox**

In `web/views/inbox.js`, inside the `t.complete` branch after the metadata opens:

```js
        if (t.thumb) {
          try {
            const bytes = await openRecord(state.mk, DOMAIN.THUMB, t.id, b64decode(t.thumb));
            const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
            thumbEl = el('img', { class: 'thumb', src: url, alt: '', loading: 'lazy' });
          } catch {
            // A thumbnail that will not open is not worth reporting: the row is
            // still useful without it.
          }
        }
```

Prepend `thumbEl` to the row when it exists, and add to `web/app.css`:

```css
.thumb {
  width: 44px;
  height: 44px;
  object-fit: cover;
  border-radius: var(--radius);
  background: var(--hull-raised);
  flex: none;
}
```

- [ ] **Step 5: Verify**

```bash
node --test web/thumb.test.mjs
```

Then in the browser: send a JPEG, a PNG, an MP4, and a PDF. The first three show a thumbnail in the inbox and the PDF does not. Confirm with `ls devdata/transfers/*/` that a `thumb` record exists only for the first three, and that `file devdata/transfers/*/thumb` reports data rather than a JPEG, since it is sealed.

- [ ] **Step 6: Commit**

```bash
git add web/thumb.js web/thumb.test.mjs web/upload.js web/views/inbox.js web/app.css
git commit -m "feat(web): client-generated sealed thumbnails"
```

---

### Task 16: Devices view and pairing

**Files:**
- Create: `web/views/devices.js`
- Modify: `web/app.js` (import it)
- Modify: `main.go` (nothing, the embed already covers `web/views`)

**Interfaces:**
- Consumes: `api.devices`, `api.allow`, `api.revoke` from `api.js`; `registerView`, `state`, `el` from `app.js`.

**What pairing means here.** Tailscale already proves a device is on your tailnet and owned by you. The registry adds two things on top: an explicit approval step when `--require-approval` is on, and a record of which devices have completed passphrase setup. A device that is on the tailnet but has not entered the passphrase can reach the API and see that transfers exist, but cannot read a single filename.

- [ ] **Step 1: Write `web/views/devices.js`**

```js
import { registerView, state, el } from '../app.js';
import { api } from '../api.js';

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

registerView('devices', 'Devices', (panel) => {
  const list = el('ul', { class: 'rows' });
  panel.append(
    el('h2', {}, 'Devices'),
    el('p', { class: 'muted' },
      'Every device that has reached this server. Tailscale proves they are yours; '
      + 'the passphrase is what lets them read anything.'),
    list);
  refresh();

  async function refresh() {
    const devices = await api.devices();
    list.replaceChildren();
    for (const d of devices) {
      list.append(row(d));
    }
  }

  function row(d) {
    const isMe = d.node === state.me.node;

    // Two facts, two words. Approval is about reaching the server; pairing is
    // about being able to read what is on it.
    const status = !d.allowed ? 'Blocked'
      : d.paired ? 'Sealed'
        : 'Waiting for the passphrase';
    const statusClass = !d.allowed ? 'data bad'
      : d.paired ? 'data sealed'
        : 'data muted';

    const actions = el('div', { class: 'actions' });
    if (!isMe) {
      actions.append(el('button', {
        class: 'ghost',
        type: 'button',
        onclick: async () => {
          await (d.allowed ? api.revoke(d.node) : api.allow(d.node));
          await refresh();
        },
      }, d.allowed ? 'Revoke' : 'Approve'));
    }

    return el('li', {},
      el('div', {},
        el('div', { class: 'name data' }, d.node, isMe ? ' (this device)' : ''),
        el('div', { class: statusClass }, status),
        el('div', { class: 'data muted' }, `${d.user} · seen ${ago(d.lastSeen)}`)),
      actions);
  }
});
```

Add to `web/app.css`:

```css
.sealed { color: var(--seal); }
```

Add the import to `web/app.js` alongside the others:

```js
await import('./views/devices.js');
```

- [ ] **Step 2: Verify**

Start the server with `--require-approval` and a fresh data directory, then:

1. The first device is admitted and appears as "this device". Confirm it has no Revoke button, because revoking the device you are using would lock you out of the only interface that could undo it.
2. Reach the server from a second device. It gets 403 with a message about approval.
3. From the first device, the second appears with an Approve button. Approve it and confirm the second device works on its next request with no restart.
4. Before the second device enters the passphrase, its status reads "Waiting for the passphrase". After it does, "Sealed".
5. Revoke the second device and confirm it gets 403 immediately.

- [ ] **Step 3: Commit**

```bash
git add web/views/devices.js web/app.js web/app.css
git commit -m "feat(web): devices view with approval, revocation and pairing state"
```

---

### Task 17: History view

**Files:**
- Create: `web/views/history.js`
- Modify: `web/app.js` (import it)

- [ ] **Step 1: Write `web/views/history.js`**

```js
import { registerView, state, el } from '../app.js';
import { api } from '../api.js';
import { DOMAIN, openRecord, b64decode } from '../crypto.js';

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

registerView('history', 'History', (panel) => {
  const list = el('ul', { class: 'rows' });
  panel.append(el('h2', {}, 'History'), list);
  load();

  async function load() {
    const tombstones = await api.history();
    list.replaceChildren();

    if (tombstones.length === 0) {
      list.append(el('li', { class: 'muted' }, 'Nothing has expired yet.'));
      return;
    }

    for (const t of tombstones) {
      // The filename is still sealed in the tombstone, so history reads as a
      // list of names only this device can produce.
      let name = 'Unnamed transfer';
      try {
        const meta = JSON.parse(new TextDecoder().decode(
          await openRecord(state.mk, DOMAIN.META, t.id, b64decode(t.meta))));
        name = meta.name;
      } catch {
        name = 'Sealed with a different passphrase';
      }
      const direction = t.sender === state.me.node ? 'sent' : `from ${t.sender}`;
      list.append(el('li', {},
        el('div', {},
          el('div', { class: 'name' }, name),
          el('div', { class: 'data muted' }, `${direction} · cleared ${ago(t.endedAt)}`))));
    }
  }
});
```

Add the import to `web/app.js`:

```js
await import('./views/history.js');
```

Nav order after all four imports is Send, Inbox, History, Devices.

- [ ] **Step 2: Verify**

Send a file, delete it from the inbox, and confirm it appears in History with its real filename and a "cleared" timestamp. Then run the server with `--ttl-hours 0` briefly and confirm expired transfers land in History too.

- [ ] **Step 3: Commit**

```bash
git add web/views/history.js web/app.js
git commit -m "feat(web): history view over sealed tombstones"
```

---

Tasks 18 through 22, covering PWA integration, relays, the Android shell, the
throughput benchmark and deployment, are in
`docs/superpowers/plans/2026-08-16-airlock-phase2-part2.md`.
