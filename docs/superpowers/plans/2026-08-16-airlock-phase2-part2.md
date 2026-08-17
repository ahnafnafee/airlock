# Airlock Phase 2 Implementation Plan, part 2: reach

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-16-airlock-phase2.md`, tasks 13 through 17. Numbering is unbroken and that file's Global Constraints bind every task here.

**Specs:** `docs/superpowers/specs/2026-08-15-airlock-design.md` and `docs/superpowers/specs/2026-08-15-airlock-visual-design.md`.

---

### Task 18: PWA install, share target and file handlers

**Files:**
- Create: `web/manifest.webmanifest`
- Already present: `web/icon-192.png`, `web/icon-512.png`, `web/icon-maskable.png`, `web/icon-badge.png`
- Modify: `web/sw.js` (intercept the share POST)
- Modify: `web/app.js` (consume a stashed share, handle file launches)
- Modify: `main.go` (embed the manifest and icons)

**This is what makes the browser version not a compromise.** The Tailscale certificate already gave the page a real secure context; this task spends it. Android's share sheet becomes a send target, Windows Explorer gets an Open with entry, and the app installs with its own icon and window.

- [ ] **Step 1: Confirm the icons**

The icons are already generated and committed: `web/icon-192.png`, `web/icon-512.png`, `web/icon-maskable.png` and `web/icon-badge.png`. Do not write a new generator.

They come from `docs/assets/make-icons.py`, which is the single source for the mark and matches `docs/assets/logo.svg`. Regenerate only if the mark changes:

```bash
python docs/assets/make-icons.py
```

Two things that generator gets right and a naive one does not, so do not simplify it:

- **Supersampling.** Coverage is averaged over samples per pixel. Without it, rings come out visibly stair-stepped.
- **Real shapes.** The arrowhead is a triangle tested by barycentric sign, not a diagonal band approximated with an inequality. The band version produced a mangled chevron.

The bolt ring is derived from the gap between the two ring edges rather than from the midpoint of their centrelines, which are different points. Both rings carry the same stroke weight.


Open each one and confirm it reads as a hatch. If anything looks wrong, adjust the proportions in the generator and regenerate rather than editing a PNG by hand.

- [ ] **Step 2: Write `web/manifest.webmanifest`**

```json
{
  "name": "Airlock",
  "short_name": "Airlock",
  "description": "Encrypted file transfer between your own devices",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0E1614",
  "theme_color": "#0E1614",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "share_target": {
    "action": "/share",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url",
      "files": [{ "name": "files", "accept": ["*/*"] }]
    }
  },
  "file_handlers": [
    {
      "action": "/open",
      "accept": {
        "application/octet-stream": [".bin", ".iso", ".img"],
        "application/pdf": [".pdf"],
        "application/zip": [".zip"],
        "image/jpeg": [".jpg", ".jpeg"],
        "image/png": [".png"],
        "text/plain": [".txt", ".log", ".md"],
        "video/mp4": [".mp4"]
      }
    }
  ]
}
```

Chrome requires concrete MIME types in `file_handlers`, so this is an enumerated list rather than a wildcard. Drag and drop onto the window remains the path that covers every other type, and the README should say so rather than implying Open with works for everything.

- [ ] **Step 3: Intercept the share POST in the worker**

In `web/sw.js`, extend the existing `fetch` listener. The share POST must never reach the network, because the server cannot accept plaintext.

```js
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.method === 'GET' && url.pathname.startsWith('/dl/')) {
    event.respondWith(download(url.pathname.slice(4)));
    return;
  }
  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(stashShare(event.request));
  }
});

// The share payload is plaintext and the server can never see it, so it is
// stashed locally and the page encrypts and uploads it.
async function stashShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f instanceof File);
    const text = [form.get('title'), form.get('text'), form.get('url')]
      .filter(Boolean).join('\n');
    await kvPut('pending-share', { files, text });
  } catch (err) {
    console.warn('share stash failed', err);
  }
  return Response.redirect('/?share=1', 303);
}
```

Add `kvPut` to the worker's imports from `./crypto.js`.

- [ ] **Step 4: Consume shares and file launches in the page**

Append to `web/app.js` and call `handleLaunch()` at the end of `enterApp()`:

```js
async function handleLaunch() {
  // Android share sheet: the worker stashed the payload before redirecting here.
  if (new URLSearchParams(location.search).has('share')) {
    const pending = await kvGet('pending-share');
    await kvPut('pending-share', null);
    history.replaceState(null, '', '/');
    if (pending) {
      showView('send');
      const { sendFiles, sendText } = await import('./views/send.js');
      if (pending.files?.length) await sendFiles(pending.files);
      else if (pending.text) await sendText(pending.text);
    }
  }
  // Windows Open with: Chrome hands the app the files it was launched on.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      showView('send');
      const { sendFiles } = await import('./views/send.js');
      await sendFiles(await Promise.all(params.files.map((h) => h.getFile())));
    });
  }
}
```

Add `kvGet, kvPut` to the imports from `./crypto.js`, and export `sendFiles` and `sendText` from `web/views/send.js` so the launch paths can reuse the exact code the drop zone uses rather than duplicating the upload loop.

- [ ] **Step 5: Embed the new assets**

Extend the `//go:embed` directive in `main.go` with `web/manifest.webmanifest web/icon-192.png web/icon-512.png web/icon-maskable.png`.

- [ ] **Step 6: Verify on real devices**

Requires the deployed tailnet server, since none of this works without a trusted certificate.

**Windows, Chrome or Edge:**
1. Install from the address bar. It opens in its own window with the hatch icon.
2. Right-click a PDF, Open with, Airlock. It launches and uploads that file.
3. Drag any file onto the window. It uploads.
4. App menu, App info, enable "Start app when you sign in", then sign out and back in.

**Android, Chrome:**
5. Add to Home screen, then open it and confirm there is no browser chrome.
6. Share a photo from Gallery and confirm Airlock is in the sheet. Pick it: the photo uploads and appears on the desktop.
7. Share a link from Chrome and confirm it arrives as a text transfer.

If install is not offered, check DevTools, Application, Manifest for errors and confirm the manifest is served as `application/manifest+json`.

- [ ] **Step 7: Commit**

```bash
git add web/manifest.webmanifest web/icon-*.png web/sw.js web/app.js web/views/send.js main.go
git commit -m "feat(pwa): install, android share target and windows file handlers"
```

---

### Task 19: Server-sent events and a live inbox

**Files:**
- Create: `events.go`
- Modify: `server.go` (add the route, publish on completion)
- Modify: `web/app.js` (subscribe, refresh views)
- Test: `events_test.go`

**Interfaces:**
- Produces:
  - `func NewEvents() *Events`
  - `func (e *Events) Subscribe(node string) (<-chan string, func())`
  - `func (e *Events) Publish(recipients []string, sender string)`
  - `func (e *Events) Count() int`
  - route `GET /api/events` streaming `text/event-stream`

**Why this and not just push.** Web Push works but is a round trip through a third-party service and needs a permission prompt. An open stream over the tailnet is immediate, needs no permission, and costs one idle connection. It also gives every client an immediate arrival signal without a push permission prompt or a third-party push service in the path.

Push stays for the case the stream cannot cover: an app that is not running at all.

- [ ] **Step 1: Write the failing tests**

Create `events_test.go`:

```go
package main

import (
	"testing"
	"time"
)

func recv(t *testing.T, ch <-chan string) (string, bool) {
	t.Helper()
	select {
	case v, ok := <-ch:
		return v, ok
	case <-time.After(time.Second):
		return "", false
	}
}

func TestPublishReachesRecipientsAndNotTheSender(t *testing.T) {
	e := NewEvents()
	pixel, closePixel := e.Subscribe("pixel")
	desktop, closeDesktop := e.Subscribe("desktop")
	defer closePixel()
	defer closeDesktop()

	e.Publish(nil, "pixel")

	if _, ok := recv(t, desktop); !ok {
		t.Fatal("an unaddressed publish should reach other devices")
	}
	select {
	case v := <-pixel:
		t.Fatalf("the sender was notified of its own upload: %q", v)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestPublishRespectsAddressing(t *testing.T) {
	e := NewEvents()
	desktop, closeDesktop := e.Subscribe("desktop")
	laptop, closeLaptop := e.Subscribe("laptop")
	defer closeDesktop()
	defer closeLaptop()

	e.Publish([]string{"desktop"}, "pixel")

	if _, ok := recv(t, desktop); !ok {
		t.Fatal("the addressee should be notified")
	}
	select {
	case <-laptop:
		t.Fatal("a device not addressed was notified")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestUnsubscribeIsIdempotentAndFrees(t *testing.T) {
	e := NewEvents()
	_, stop := e.Subscribe("pixel")
	if e.Count() != 1 {
		t.Fatalf("count = %d, want 1", e.Count())
	}
	stop()
	stop()
	if e.Count() != 0 {
		t.Fatalf("count after unsubscribe = %d, want 0", e.Count())
	}
}

func TestASlowSubscriberDoesNotBlockPublish(t *testing.T) {
	// A device that stops reading must never wedge an upload. Publish drops
	// rather than blocks, because the client re-fetches the inbox on any event
	// and a missed nudge costs nothing.
	e := NewEvents()
	_, stop := e.Subscribe("desktop")
	defer stop()

	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			e.Publish(nil, "pixel")
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked on a subscriber that was not reading")
	}
}
```

- [ ] **Step 2: Write `events.go`**

```go
package main

import "sync"

// Events is a fan-out of "something arrived for you" nudges. It carries no
// detail: a client that receives one re-fetches its inbox, which keeps every
// filename behind the encryption boundary and makes a dropped event harmless.
type Events struct {
	mu   sync.Mutex
	next int
	subs map[int]subscriber
}

type subscriber struct {
	node string
	ch   chan string
}

func NewEvents() *Events {
	return &Events{subs: map[int]subscriber{}}
}

// Subscribe returns a channel and the function that releases it. The caller must
// call the returned function, normally with defer, or the subscription leaks for
// the lifetime of the process.
func (e *Events) Subscribe(node string) (<-chan string, func()) {
	e.mu.Lock()
	defer e.mu.Unlock()

	id := e.next
	e.next++
	// Buffered by one: a nudge already waiting makes a second one redundant,
	// since the client re-reads the whole inbox either way.
	ch := make(chan string, 1)
	e.subs[id] = subscriber{node: node, ch: ch}

	var once sync.Once
	return ch, func() {
		once.Do(func() {
			e.mu.Lock()
			defer e.mu.Unlock()
			if s, ok := e.subs[id]; ok {
				delete(e.subs, id)
				close(s.ch)
			}
		})
	}
}

func (e *Events) Count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.subs)
}

// Publish nudges every device that should care, never the sender. It drops
// rather than blocks when a subscriber is not reading, because a device that
// has stopped reading must not be able to wedge somebody else's upload.
func (e *Events) Publish(recipients []string, sender string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, s := range e.subs {
		if s.node == sender {
			continue
		}
		if len(recipients) > 0 && !addressedTo(recipients, s.node) {
			continue
		}
		select {
		case s.ch <- "inbox":
		default:
		}
	}
}
```

- [ ] **Step 3: Add the route**

In `server.go`, add `Events *Events` to `ServerConfig`, register the route in `routes()`:

```go
	s.mux.HandleFunc("GET /api/events", g(s.events))
```

and append the handler:

```go
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Without this, a proxy that buffers would hold every nudge until the
	// connection closed, which is exactly never.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch, stop := s.cfg.Events.Subscribe(who(r).Node)
	defer stop()

	// A periodic comment keeps intermediaries from reaping an idle stream and
	// tells the client the connection is still alive.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case _, open := <-ch:
			if !open {
				return
			}
			fmt.Fprint(w, "event: inbox\ndata: 1\n\n")
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}
```

Add `"fmt"` and `"time"` to `server.go`'s imports. In `notifyIfComplete`, publish alongside the push:

```go
	s.cfg.Events.Publish(info.To, sender)
	go s.cfg.Push.Notify(info.To, sender)
```

In `main.go`, construct `NewEvents()` and pass it in `ServerConfig`.

- [ ] **Step 4: Subscribe from the page**

Append to `web/app.js` and call `listen()` at the end of `enterApp()`:

```js
const listeners = new Set();

// A view calls this to be told when something arrives. The event carries no
// detail, so the handler re-reads whatever it needs.
export function onInbox(fn) { listeners.add(fn); }

function listen() {
  const source = new EventSource('/api/events');
  source.addEventListener('inbox', () => {
    for (const fn of listeners) fn();
  });
  // EventSource reconnects on its own after a drop, so there is nothing to
  // schedule here. This only reports a stream the browser gave up on.
  source.addEventListener('error', () => {
    if (source.readyState === EventSource.CLOSED) {
      console.warn('event stream closed');
    }
  });
}
```

In `web/views/inbox.js`, register the refresh: `onInbox(() => refresh());`. Do the same for the history view.

- [ ] **Step 5: Verify**

```bash
go vet ./... && go test ./... -v
```

Then with two browser windows open on different devices: send from one and confirm the other's inbox updates within a second with no reload and no notification permission. Leave a window idle for two minutes and confirm the stream stays up, then stop the server and confirm the client reconnects when it returns.

- [ ] **Step 6: Commit**

```bash
git add events.go events_test.go server.go main.go web/app.js web/views/inbox.js web/views/history.js
git commit -m "feat(events): server-sent nudges and a live inbox"
```

---

### Task 20: Relays

**Files:**
- Create: `relay.go`
- Modify: `server.go` (add the offer route)
- Modify: `main.go` (add the peer flags, start the relay worker)
- Test: `relay_test.go`

**Interfaces:**
- Produces:
  - `func NewRelay(peers []string, transfers *Transfers, chunks *ChunkStore, client *http.Client) *Relay`
  - `func (r *Relay) Offer(id string) error` pushing one transfer to every peer
  - `func (r *Relay) Accept(offer RelayOffer) ([]string, error)` returning the chunk ids this instance lacks
  - `type RelayOffer struct { ID, Sender string; To, Cids []string; Meta, ChunkList, Thumb string; CreatedAt time.Time }`

**What a relay is here.** Another Airlock instance, reachable on a tailnet, that a transfer is mirrored to so it reaches devices talking to a different server. Relay links authenticate exactly like clients do: the peer is a tailnet node verified by `WhoIs` and present in the relay allowlist, so relaying does not weaken the reachability property.

Ciphertext moves unchanged and relays hold no keys. A relay can read nothing, which is the same guarantee the origin server already offers.

**Chunks move by the same dedup negotiation clients use.** The offer carries ids; the peer answers with what it lacks; only those are pushed. A relay never re-sends a chunk the peer already holds.

- [ ] **Step 1: Write the failing tests**

Create `relay_test.go`:

```go
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAcceptReportsOnlyMissingChunks(t *testing.T) {
	dir := t.TempDir()
	chunks, _ := NewChunkStore(dir, 64, 1<<20)
	transfers, _ := NewTransfers(dir, chunks, time.Hour, 100, 4096)
	chunks.Put(cid(1), strings.NewReader("already here"))

	r := NewRelay(nil, transfers, chunks, http.DefaultClient)
	missing, err := r.Accept(RelayOffer{
		ID: strings.Repeat("a", 32), Sender: "pixel",
		Cids: []string{cid(1), cid(2)}, CreatedAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 1 || missing[0] != cid(2) {
		t.Fatalf("missing = %v, want only the absent chunk", missing)
	}
}

func TestAcceptRefusesMalformedIds(t *testing.T) {
	dir := t.TempDir()
	chunks, _ := NewChunkStore(dir, 64, 1<<20)
	transfers, _ := NewTransfers(dir, chunks, time.Hour, 100, 4096)
	r := NewRelay(nil, transfers, chunks, http.DefaultClient)

	if _, err := r.Accept(RelayOffer{ID: "../../etc", Cids: []string{cid(1)}}); err == nil {
		t.Fatal("a malformed transfer id should be refused")
	}
	if _, err := r.Accept(RelayOffer{
		ID: strings.Repeat("a", 32), Cids: []string{"../../etc/passwd"},
	}); err == nil {
		t.Fatal("a malformed chunk id should be refused")
	}
}

func TestAcceptIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	chunks, _ := NewChunkStore(dir, 64, 1<<20)
	transfers, _ := NewTransfers(dir, chunks, time.Hour, 100, 4096)
	r := NewRelay(nil, transfers, chunks, http.DefaultClient)

	offer := RelayOffer{
		ID: strings.Repeat("b", 32), Sender: "pixel",
		Cids: []string{cid(1)}, CreatedAt: time.Now(),
	}
	// A peer may retry an offer after a network failure, and the second attempt
	// must not error or duplicate anything.
	for i := 0; i < 3; i++ {
		if _, err := r.Accept(offer); err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	info, err := transfers.Get(offer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if info.Sender != "pixel" || len(info.Cids) != 1 {
		t.Fatalf("transfer = %+v", info)
	}
}

func TestOfferSkipsChunksThePeerAlreadyHas(t *testing.T) {
	dir := t.TempDir()
	chunks, _ := NewChunkStore(dir, 64, 1<<20)
	transfers, _ := NewTransfers(dir, chunks, time.Hour, 100, 4096)
	chunks.Put(cid(1), strings.NewReader("one"))
	chunks.Put(cid(2), strings.NewReader("two"))
	rec, _, _ := transfers.Create("pixel", nil, []string{cid(1), cid(2)})
	transfers.PutRecord(rec.ID, "meta", strings.NewReader("m"))
	transfers.PutRecord(rec.ID, "chunklist", strings.NewReader("l"))

	pushed := []string{}
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch {
		case req.URL.Path == "/api/relay/offer":
			writeJSON(w, http.StatusOK, map[string]any{"missing": []string{cid(2)}})
		case strings.HasPrefix(req.URL.Path, "/api/chunk/"):
			pushed = append(pushed, strings.TrimPrefix(req.URL.Path, "/api/chunk/"))
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer peer.Close()

	r := NewRelay([]string{peer.URL}, transfers, chunks, peer.Client())
	if err := r.Offer(rec.ID); err != nil {
		t.Fatal(err)
	}
	if len(pushed) != 1 || pushed[0] != cid(2) {
		t.Fatalf("pushed %v, want only the chunk the peer lacked", pushed)
	}
}
```

- [ ] **Step 2: Write `relay.go`**

```go
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// RelayOffer is one transfer described to a peer. The sealed records travel
// base64 encoded inside it; the chunks follow separately and only if the peer
// says it lacks them.
type RelayOffer struct {
	ID        string    `json:"id"`
	Sender    string    `json:"sender"`
	To        []string  `json:"to"`
	Cids      []string  `json:"cids"`
	Meta      string    `json:"meta"`
	ChunkList string    `json:"chunklist"`
	Thumb     string    `json:"thumb"`
	CreatedAt time.Time `json:"createdAt"`
}

type Relay struct {
	peers     []string
	transfers *Transfers
	chunks    *ChunkStore
	client    *http.Client
}

func NewRelay(peers []string, transfers *Transfers, chunks *ChunkStore, client *http.Client) *Relay {
	return &Relay{peers: peers, transfers: transfers, chunks: chunks, client: client}
}

// Accept takes a peer's offer, materializes the transfer locally, and reports
// which chunks this instance still needs. Ciphertext only: a relay holds no keys
// and can read nothing it forwards.
func (r *Relay) Accept(offer RelayOffer) ([]string, error) {
	if !tidRe.MatchString(offer.ID) {
		return nil, ErrBadID
	}
	for _, id := range offer.Cids {
		if !cidRe.MatchString(id) {
			return nil, ErrBadID
		}
	}

	// A peer may retry after a network failure, so an offer for a transfer we
	// already hold updates nothing and simply reports what is still missing.
	if _, err := r.transfers.Get(offer.ID); err != nil {
		if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if err := r.transfers.Adopt(offer.ID, offer.Sender, offer.To, offer.Cids, offer.CreatedAt); err != nil {
			return nil, err
		}
	}

	for kind, encoded := range map[string]string{
		"meta": offer.Meta, "chunklist": offer.ChunkList, "thumb": offer.Thumb,
	} {
		if encoded == "" {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, fmt.Errorf("%s record: %w", kind, err)
		}
		if err := r.transfers.PutRecord(offer.ID, kind, bytes.NewReader(raw)); err != nil {
			return nil, err
		}
	}

	return r.chunks.Missing(offer.Cids), nil
}

// Offer mirrors one transfer to every configured peer. A peer that fails is
// logged and skipped: relaying is best effort, and the transfer is already safe
// on this instance.
func (r *Relay) Offer(id string) error {
	if len(r.peers) == 0 {
		return nil
	}
	info, err := r.transfers.Get(id)
	if err != nil {
		return err
	}
	chunkList, err := r.recordB64(id, "chunklist")
	if err != nil {
		return err
	}
	offer := RelayOffer{
		ID: info.ID, Sender: info.Sender, To: info.To, Cids: info.Cids,
		Meta: info.Meta, ChunkList: chunkList, Thumb: info.Thumb,
		CreatedAt: info.CreatedAt,
	}

	for _, peer := range r.peers {
		if err := r.offerTo(peer, offer); err != nil {
			log.Printf("relay to %s: %v", peer, err)
		}
	}
	return nil
}

func (r *Relay) recordB64(id, kind string) (string, error) {
	f, err := r.transfers.OpenRecord(id, kind)
	if errors.Is(err, ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	b, err := io.ReadAll(f)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

func (r *Relay) offerTo(peer string, offer RelayOffer) error {
	body, err := json.Marshal(offer)
	if err != nil {
		return err
	}
	res, err := r.client.Post(strings.TrimSuffix(peer, "/")+"/api/relay/offer",
		"application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("offer rejected: %s", res.Status)
	}
	var reply struct {
		Missing []string `json:"missing"`
	}
	if err := json.NewDecoder(res.Body).Decode(&reply); err != nil {
		return err
	}

	// The same dedup negotiation clients use, so a relay never re-sends a chunk
	// the peer already holds.
	for _, id := range reply.Missing {
		if err := r.pushChunk(peer, id); err != nil {
			return err
		}
	}
	return nil
}

func (r *Relay) pushChunk(peer, id string) error {
	f, err := r.chunks.Open(id)
	if err != nil {
		return err
	}
	defer f.Close()
	req, err := http.NewRequest(http.MethodPut,
		strings.TrimSuffix(peer, "/")+"/api/chunk/"+id, f)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("chunk %s rejected: %s", id[:8], res.Status)
	}
	return nil
}
```

- [ ] **Step 3: Add `Transfers.Adopt`**

A relayed transfer keeps the originating instance's id and timestamp, so it cannot go through `Create`, which mints both. Append to `transfers.go`:

```go
// Adopt materializes a transfer that originated on a peer, preserving its id and
// creation time so the same transfer is one transfer across every relay. Create
// mints both, which is why relaying cannot reuse it.
func (t *Transfers) Adopt(id, sender string, to, cids []string, createdAt time.Time) error {
	if !tidRe.MatchString(id) || len(cids) < 1 || len(cids) > t.maxChunks {
		return ErrBadID
	}
	for _, c := range cids {
		if !cidRe.MatchString(c) {
			return ErrBadID
		}
	}
	dir, err := t.transferDir(id)
	if err != nil {
		return err
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			return nil // already adopted, and offers are retried
		}
		return err
	}
	if err := t.writeJSON(dir, "cids.json", cids); err != nil {
		os.RemoveAll(dir)
		return err
	}
	rec := &Transfer{ID: id, Sender: sender, To: to, CreatedAt: createdAt, ChunkCount: len(cids)}
	if err := t.writeJSON(dir, "meta.json", rec); err != nil {
		os.RemoveAll(dir)
		return err
	}
	return nil
}
```

- [ ] **Step 4: Add the route and wire it up**

In `server.go`, add `Relay *Relay` to `ServerConfig`, register:

```go
	s.mux.HandleFunc("POST /api/relay/offer", g(s.relayOffer))
```

and append:

```go
func (s *Server) relayOffer(w http.ResponseWriter, r *http.Request) {
	// Relay peers are allowlisted separately from devices: a peer is a server,
	// not somebody's phone, and being on the tailnet is not enough.
	if !s.cfg.RelayPeers[who(r).Node] {
		http.Error(w, "not a relay peer", http.StatusForbidden)
		return
	}
	var offer RelayOffer
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&offer); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	missing, err := s.cfg.Relay.Accept(offer)
	if fail(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"missing": missing})
}
```

Add `RelayPeers map[string]bool` to `ServerConfig`. In `main.go` add:

```go
	relayPeers = flag.String("relay-peers", "",
		"comma-separated peer base URLs to mirror completed transfers to")
	relayFrom = flag.String("relay-from", "",
		"comma-separated node names permitted to offer transfers to this instance")
```

build the `Relay` and the `RelayPeers` set from `splitSet(*relayFrom)`, and in `notifyIfComplete` fire the mirror without blocking the response:

```go
	go func() {
		if err := s.cfg.Relay.Offer(id); err != nil {
			log.Printf("relay offer: %v", err)
		}
	}()
```

- [ ] **Step 5: Verify**

```bash
go vet ./... && go test ./... -v
```

Then run two instances against different data directories, each naming the other, and confirm a transfer sent to the first appears on the second, that the second's chunk directory grows by only the chunks it lacked, and that a node not in `--relay-from` gets 403 on `/api/relay/offer`.

- [ ] **Step 6: Commit**

```bash
git add relay.go relay_test.go transfers.go server.go main.go
git commit -m "feat(relay): mirror completed transfers to peer instances by dedup negotiation"
```

---

Tasks 22 and 23, covering the throughput benchmark and deployment, are in
`docs/superpowers/plans/2026-08-16-airlock-phase2-part3.md`.
