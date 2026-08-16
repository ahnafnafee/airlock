# Airlock Phase 2 Implementation Plan, part 5: peer-to-peer transfer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-16-airlock-phase2-part4.md`. Numbering is unbroken and the Phase 2 Global Constraints bind every task here.

**Spec:** `docs/superpowers/specs/2026-08-15-airlock-design.md`, sections 1, 5 and 6.

## What these tasks change

File content stops passing through the server. The sending device chunks, seals and holds the file on its own disk; the server records a pending transfer and a progress bitmap; the two devices connect directly over the tailnet and move bytes in one hop.

**Resumability is what makes this work rather than a compromise.** The devices do not have to overlap for a whole transfer, only repeatedly. A 20 GB file can cross in five separate ten-minute windows because the progress bitmap says exactly what is still missing and both ends stage their partial work in the Origin Private File System, which survives a reload and a reboot.

**Nothing about the crypto or the chunking changes.** Chunks are sealed before they touch any transport, so a data channel carries the same bytes an HTTP body did. The negotiation is the same question, asked of a peer instead of a server.

**What the server may hold:** transfer records, the plaintext chunk id list, the progress bitmap, and the sealed metadata, chunk list and thumbnail. **What it may never hold:** one byte of file content, unless the sender explicitly ticks the hold-for-me box on that transfer.

**Task 20, relays, was deferred and is replanned as task 33 here,** because a relay was defined as mirroring files and there are no files on a server to mirror.

---

### Task 27: Presence and signalling

**Files:**
- Modify: `events.go`, `server.go`
- Test: `events_test.go`, `server_test.go`

**Interfaces:**
- New: `func (e *Events) Online() []string`
- New: `func (e *Events) Send(to, payload string) bool`
- New routes: `GET /api/presence`, `POST /api/signal`
- The SSE stream gains a second event type, `signal`

**The server is a postbox here.** It relays opaque strings between two nodes and never parses them. Session descriptions and ICE candidates are the peers' business, and treating them as data the server understands would be the first step toward the server needing to.

- [ ] **Step 1: Write the failing tests**

Append to `events_test.go`:

```go
func TestOnlineListsSubscribedNodesOnce(t *testing.T) {
	e := NewEvents()
	_, stopA := e.Subscribe("pixel")
	_, stopB := e.Subscribe("desktop")
	// A device with two tabs open is still one device.
	_, stopC := e.Subscribe("desktop")
	defer stopA()
	defer stopB()
	defer stopC()

	got := e.Online()
	sort.Strings(got)
	if len(got) != 2 || got[0] != "desktop" || got[1] != "pixel" {
		t.Fatalf("Online = %v, want [desktop pixel]", got)
	}

	stopB()
	stopC()
	if got := e.Online(); len(got) != 1 || got[0] != "pixel" {
		t.Fatalf("after both desktop streams closed, Online = %v", got)
	}
}

func TestSendReachesEveryStreamForANode(t *testing.T) {
	e := NewEvents()
	first, stop1 := e.Subscribe("desktop")
	second, stop2 := e.Subscribe("desktop")
	other, stop3 := e.Subscribe("laptop")
	defer stop1()
	defer stop2()
	defer stop3()

	if !e.Send("desktop", "sdp-blob") {
		t.Fatal("Send should report delivery when the node has a stream")
	}
	for i, ch := range []<-chan string{first, second} {
		got, ok := recv(t, ch)
		if !ok || got != "signal:sdp-blob" {
			t.Fatalf("stream %d got %q, ok=%v", i, got, ok)
		}
	}
	select {
	case v := <-other:
		t.Fatalf("an unrelated node received a signal: %q", v)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestSendToAnAbsentNodeReportsFailure(t *testing.T) {
	e := NewEvents()
	// The sender needs this answer so it can leave the transfer queued instead
	// of waiting for a reply that will never come.
	if e.Send("nobody", "sdp-blob") {
		t.Fatal("Send should report false when the node has no stream")
	}
}

func TestSignallingIsNotDroppedUnderLoad(t *testing.T) {
	// A nudge may be dropped, because the client re-reads the inbox anyway. A
	// signalling message may not: losing an answer stalls a handshake that has
	// no other way to recover.
	e := NewEvents()
	ch, stop := e.Subscribe("desktop")
	defer stop()

	for i := 0; i < 8; i++ {
		if !e.Send("desktop", "candidate") {
			t.Fatalf("send %d was dropped", i)
		}
	}
	for i := 0; i < 8; i++ {
		if _, ok := recv(t, ch); !ok {
			t.Fatalf("message %d never arrived", i)
		}
	}
}
```

Add `"sort"` to that file's imports.

Append to `server_test.go`:

```go
func TestPresenceAndSignalRoutes(t *testing.T) {
	s, _ := newTestServer(t, true)

	var online []string
	json.Unmarshal(do(t, s, "GET", "/api/presence", "").Body.Bytes(), &online)
	if len(online) != 0 {
		t.Fatalf("presence = %v with no streams open", online)
	}

	// No stream for the target, so the sender is told to leave it queued.
	if code := do(t, s, "POST", "/api/signal", `{"to":"desktop","payload":"x"}`).Code; code != http.StatusServiceUnavailable {
		t.Fatalf("signal to an absent node = %d, want 503", code)
	}
}

func TestSignalRejectsAnOversizePayload(t *testing.T) {
	s, _ := newTestServer(t, true)
	huge := `{"to":"desktop","payload":"` + strings.Repeat("x", 200000) + `"}`
	if code := do(t, s, "POST", "/api/signal", huge).Code; code != http.StatusRequestEntityTooLarge {
		t.Fatalf("code = %d, want 413", code)
	}
}
```

- [ ] **Step 2: Extend `events.go`**

```go
// Online reports which nodes hold at least one open stream. A device with
// several tabs open is still one device.
func (e *Events) Online() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	seen := map[string]bool{}
	out := []string{}
	for _, s := range e.subs {
		if !seen[s.node] {
			seen[s.node] = true
			out = append(out, s.node)
		}
	}
	return out
}

// Send delivers one opaque signalling payload to every stream a node holds and
// reports whether anything received it. The caller needs that answer: a sender
// whose offer went nowhere leaves the transfer queued rather than waiting for a
// reply that will never arrive.
//
// The payload is a string this server never parses.
func (e *Events) Send(to, payload string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	delivered := false
	for _, s := range e.subs {
		if s.node != to {
			continue
		}
		select {
		case s.ch <- "signal:" + payload:
			delivered = true
		default:
			// This stream is not draining. Another tab may still take it, so
			// keep going rather than declaring failure here.
		}
	}
	return delivered
}
```

Widen the channel in `Subscribe`:

```go
	// Nudges collapse, so one slot would do for them. Signalling messages do
	// not: dropping an answer or a candidate stalls a handshake that has no
	// other way to recover.
	ch := make(chan string, 16)
```

- [ ] **Step 3: Emit the event type in the SSE handler**

The channel now carries two kinds of message. In `server.go`'s `events` handler:

```go
		case msg, open := <-ch:
			if !open {
				return
			}
			if payload, ok := strings.CutPrefix(msg, "signal:"); ok {
				// A session description is full of newlines and an SSE data
				// field ends at the first one, so signalling payloads travel
				// base64 encoded and the client decodes them.
				fmt.Fprintf(w, "event: signal\ndata: %s\n\n", payload)
			} else {
				fmt.Fprint(w, "event: inbox\ndata: 1\n\n")
			}
			flusher.Flush()
```

Add `"strings"` to the imports.

- [ ] **Step 4: Add the routes**

```go
	s.mux.HandleFunc("GET /api/presence", g(s.presence))
	s.mux.HandleFunc("POST /api/signal", g(s.signal))
```

```go
func (s *Server) presence(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.cfg.Events.Online())
}

func (s *Server) signal(w http.ResponseWriter, r *http.Request) {
	var req struct {
		To      string `json:"to"`
		Payload string `json:"payload"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&req); err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			http.Error(w, "signal too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.To == "" || len(req.To) > 128 {
		http.Error(w, "bad target", http.StatusBadRequest)
		return
	}
	// Only a device this server already knows may be signalled, so the relay
	// cannot be used to reach anything the caller could not reach anyway.
	if !s.cfg.Devices.Allowed(req.To) {
		http.Error(w, "unknown device", http.StatusNotFound)
		return
	}
	if !s.cfg.Events.Send(req.To, req.Payload) {
		// Not an error. The sender uses this to decide to stay queued.
		http.Error(w, "device is not connected", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 5: Verify and commit**

```bash
go vet ./... && go test ./... -v
git add events.go server.go events_test.go server_test.go
git commit -m "feat(events): presence and an opaque signalling relay"
```

---

### Task 28: The queue and the progress bitmap

**Files:**
- Modify: `transfers.go`, `server.go`
- Test: `transfers_test.go`, `server_test.go`

**Interfaces:**
- New: `func (t *Transfers) SetProgress(id, node string, bitmap []byte) error`
- New: `func (t *Transfers) Progress(id, node string) ([]byte, error)`
- New: `func (t *Transfers) Queue(sender string) ([]*TransferInfo, error)`
- New routes: `PUT /api/transfer/{id}/progress`, `GET /api/transfer/{id}/progress`, `GET /api/queue`

**A bitmap, not a list.** One bit per chunk, indexed by position in the transfer's own `cids` array. For a 20 GB file that is about 600 bytes, where a list of 64-character ids would be 320 KB and would be re-sent on every update.

**Progress is per recipient.** A transfer addressed to two devices has two independent bitmaps, because one device having a chunk says nothing about the other.

**The server never infers progress.** The receiver writes it after staging chunks. A server that guessed would be wrong exactly when it mattered, after a crash.

- [ ] **Step 1: Write the failing tests**

Append to `transfers_test.go`:

```go
func TestProgressIsPerRecipient(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop", "laptop"}, []string{cid(1), cid(2)})

	if err := tr.SetProgress(rec.ID, "desktop", []byte{0b01}); err != nil {
		t.Fatal(err)
	}
	desktop, err := tr.Progress(rec.ID, "desktop")
	if err != nil {
		t.Fatal(err)
	}
	if len(desktop) != 1 || desktop[0] != 0b01 {
		t.Fatalf("desktop progress = %v", desktop)
	}
	// One device holding a chunk says nothing about another.
	laptop, err := tr.Progress(rec.ID, "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if len(laptop) != 0 {
		t.Fatalf("laptop progress = %v, want empty", laptop)
	}
}

func TestProgressRejectsAWrongSizedBitmap(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1), cid(2)})
	// Two chunks need one byte. Anything else is a client bug, and accepting it
	// would leave a bitmap whose bits do not line up with the chunk list.
	if err := tr.SetProgress(rec.ID, "desktop", []byte{0, 0, 0}); !errors.Is(err, ErrBadID) {
		t.Fatalf("err = %v, want ErrBadID", err)
	}
}

func TestProgressRequiresVisibility(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	if err := tr.SetProgress(rec.ID, "laptop", []byte{1}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestQueueListsWhatThisNodeStillOwes(t *testing.T) {
	tr, _ := newTransfers(t)
	mine, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	theirs, _, _ := tr.Create("laptop", []string{"desktop"}, []string{cid(1)})

	queue, err := tr.Queue("pixel")
	if err != nil {
		t.Fatal(err)
	}
	if len(queue) != 1 || queue[0].ID != mine.ID {
		t.Fatalf("queue = %v, want only what pixel sent", queue)
	}
	_ = theirs
}

func TestAFullyDeliveredTransferLeavesTheQueue(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1), cid(2)})

	// Both bits set: the only recipient has everything.
	if err := tr.SetProgress(rec.ID, "desktop", []byte{0b11}); err != nil {
		t.Fatal(err)
	}
	queue, _ := tr.Queue("pixel")
	if len(queue) != 0 {
		t.Fatalf("queue = %v, want empty once every recipient has every chunk", queue)
	}
}
```

- [ ] **Step 2: Implement in `transfers.go`**

```go
// progressName keeps a recipient's bitmap in its own file, so two recipients
// writing at the same time never contend and a partial write cannot corrupt
// somebody else's record. The node name is hashed rather than used directly,
// because it comes from WhoIs and has no format guarantee that makes it safe as
// a filename.
func progressName(node string) string {
	sum := sha256.Sum256([]byte(node))
	return "progress-" + hex.EncodeToString(sum[:8])
}

func bitmapLen(chunks int) int { return (chunks + 7) / 8 }

func (t *Transfers) SetProgress(id, node string, bitmap []byte) error {
	info, err := t.Get(id)
	if err != nil {
		return err
	}
	if !visibleTo(info.Sender, info.To, node) {
		return ErrNotFound
	}
	if len(bitmap) != bitmapLen(len(info.Cids)) {
		// A bitmap of the wrong length has bits that do not line up with the
		// chunk list, which would silently mark the wrong chunks delivered.
		return ErrBadID
	}
	dir, err := t.transferDir(id)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(dir, progressName(node)), bitmap)
}

func (t *Transfers) Progress(id, node string) ([]byte, error) {
	dir, err := t.transferDir(id)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(dir, progressName(node)))
	if errors.Is(err, os.ErrNotExist) {
		return []byte{}, nil
	}
	return b, err
}

// Queue is what this node still owes: transfers it sent where some recipient is
// missing at least one chunk. Opening the app and draining this is how a
// transfer completes without the sender having to sit and wait.
func (t *Transfers) Queue(sender string) ([]*TransferInfo, error) {
	all, err := t.list()
	if err != nil {
		return nil, err
	}
	out := []*TransferInfo{}
	for _, info := range all {
		if info.Sender != sender {
			continue
		}
		if t.fullyDelivered(info) {
			continue
		}
		out = append(out, info)
	}
	return out, nil
}

func (t *Transfers) fullyDelivered(info *TransferInfo) bool {
	// An unaddressed transfer has no fixed recipient set, so there is no point
	// at which it is provably delivered to everyone. It leaves the queue on its
	// TTL like anything else.
	if len(info.To) == 0 {
		return false
	}
	want := bitmapLen(len(info.Cids))
	for _, node := range info.To {
		if contains(info.Declined, node) {
			continue
		}
		bitmap, err := t.Progress(info.ID, node)
		if err != nil || len(bitmap) != want {
			return false
		}
		for i := range info.Cids {
			if bitmap[i/8]&(1<<(i%8)) == 0 {
				return false
			}
		}
	}
	return true
}
```

Add `"crypto/sha256"` and `"encoding/hex"` to the imports if absent.

- [ ] **Step 3: Add the routes**

```go
	s.mux.HandleFunc("PUT /api/transfer/{id}/progress", g(s.putProgress))
	s.mux.HandleFunc("GET /api/transfer/{id}/progress", g(s.getProgress))
	s.mux.HandleFunc("GET /api/queue", g(s.queue))
```

Register these above the `{id}/{kind}` patterns so the literal path wins.

```go
func (s *Server) putProgress(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		http.Error(w, "bad body", http.StatusRequestEntityTooLarge)
		return
	}
	if fail(w, s.cfg.Transfers.SetProgress(r.PathValue("id"), who(r).Node, body)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getProgress(w http.ResponseWriter, r *http.Request) {
	// A sender asks for a recipient's progress, so the node is a parameter here
	// rather than the caller.
	node := r.URL.Query().Get("node")
	if node == "" {
		node = who(r).Node
	}
	bitmap, err := s.cfg.Transfers.Progress(r.PathValue("id"), node)
	if fail(w, err) {
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(bitmap)
}

func (s *Server) queue(w http.ResponseWriter, r *http.Request) {
	list, err := s.cfg.Transfers.Queue(who(r).Node)
	if fail(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}
```

- [ ] **Step 4: Verify and commit**

```bash
go vet ./... && go test ./... -v
git add transfers.go server.go transfers_test.go server_test.go
git commit -m "feat(transfers): per-recipient progress bitmaps and a sender queue"
```

---

### Task 29: Local staging

**Files:**
- Create: `web/staging.js`
- Test: `web/staging.test.mjs`

**Interfaces:**
- Produces: `openStage(transferId)` returning `{put(index, bytes), get(index), has(index), bitmap(count), clear()}`

**Why the Origin Private File System.** A browser loses its `File` handle when the page closes, so a queued transfer would have nothing left to send and a half-received one nothing to resume from. OPFS is real persistent storage on the device's own disk, readable across sessions, and it is what turns "both devices must be online at once" into "both devices must be online at some point".

The cost is a local copy on the sender until the transfer completes, and partial chunks on the receiver until it does. That is the owner's disk, not rented disk, and it is transient.

- [ ] **Step 1: Write the failing tests**

Node 22 has no OPFS, so `web/staging.test.mjs` tests the bitmap arithmetic, which is where an off-by-one would silently mark the wrong chunk delivered, against an injectable backing store.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { bitmapOf, indexesFrom } from './staging.js';

test('a bitmap sets exactly the bits it is given', () => {
  assert.deepEqual([...bitmapOf(new Set([0]), 1)], [0b1]);
  assert.deepEqual([...bitmapOf(new Set([0, 1, 2]), 3)], [0b111]);
  assert.deepEqual([...bitmapOf(new Set([7]), 8)], [0b10000000]);
  assert.deepEqual([...bitmapOf(new Set([8]), 9)], [0, 0b1]);
  assert.deepEqual([...bitmapOf(new Set(), 9)], [0, 0]);
});

test('a bitmap is exactly as long as the chunk count needs', () => {
  assert.equal(bitmapOf(new Set(), 1).length, 1);
  assert.equal(bitmapOf(new Set(), 8).length, 1);
  assert.equal(bitmapOf(new Set(), 9).length, 2);
  assert.equal(bitmapOf(new Set(), 5000).length, 625);
});

test('bitmap and index list round trip', () => {
  const held = new Set([0, 3, 9, 4999]);
  assert.deepEqual(new Set(indexesFrom(bitmapOf(held, 5000), 5000)), held);
});

test('bits past the chunk count are ignored', () => {
  // The last byte of a 9-chunk bitmap has seven spare bits. A peer that sets
  // them must not make us believe in chunks that do not exist.
  const bitmap = new Uint8Array([0xff, 0xff]);
  assert.deepEqual(indexesFrom(bitmap, 9), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});
```

- [ ] **Step 2: Write `web/staging.js`**

```js
// Sealed chunks wait here between sessions. A browser loses its File handle when
// the page closes, so without persistent local storage a queued transfer would
// have nothing left to send and a half-received one nothing to resume from.
//
// This is the owner's own disk. It is what turns "both devices must be online at
// once" into "both devices must be online at some point".

export function bitmapOf(indexes, count) {
  const out = new Uint8Array((count + 7) >> 3);
  for (const i of indexes) {
    if (i >= 0 && i < count) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

export function indexesFrom(bitmap, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    // Bounded by count, not by the bitmap's length: the final byte has spare
    // bits and a peer setting them must not invent chunks.
    if (bitmap[i >> 3] & (1 << (i & 7))) out.push(i);
  }
  return out;
}

async function stageDir(transferId) {
  const root = await navigator.storage.getDirectory();
  const staging = await root.getDirectoryHandle('staging', { create: true });
  return staging.getDirectoryHandle(transferId, { create: true });
}

export async function openStage(transferId) {
  const dir = await stageDir(transferId);

  const put = async (index, bytes) => {
    const handle = await dir.getFileHandle(String(index), { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  };

  const get = async (index) => {
    const handle = await dir.getFileHandle(String(index));
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  };

  const has = async (index) => {
    try {
      await dir.getFileHandle(String(index));
      return true;
    } catch {
      return false;
    }
  };

  const held = async () => {
    const out = new Set();
    for await (const name of dir.keys()) {
      const i = Number(name);
      if (Number.isInteger(i) && i >= 0) out.add(i);
    }
    return out;
  };

  return {
    put,
    get,
    has,
    held,
    bitmap: async (count) => bitmapOf(await held(), count),
    clear: async () => {
      const root = await navigator.storage.getDirectory();
      const staging = await root.getDirectoryHandle('staging', { create: true });
      await staging.removeEntry(transferId, { recursive: true });
    },
  };
}

// Ask the browser to keep this data rather than evicting it under pressure. A
// queued transfer whose staged chunks were evicted would be undeliverable with
// no way to tell the owner why.
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
```

- [ ] **Step 3: Run the tests and commit**

```bash
node --test web/staging.test.mjs
git add web/staging.js web/staging.test.mjs
git commit -m "feat(web): persistent local staging for queued and partial transfers"
```

---

### Task 30: The direct channel

**Files:**
- Create: `web/peer.js`
- Test: `web/peer.test.mjs`

**Interfaces:**
- Produces: `WIRE`, `negotiate(channel, manifest, readChunk)`, `receive(channel, handlers)`, `newConnection()`

**The wire protocol**, JSON control frames with binary chunk bodies:

```
sender   -> OFFER   {name, size, mime, cids: [...]}
receiver -> DECLINE {reason}                          ends here
receiver -> NEED    {indexes: [...]}                  the dedup question, asked of a peer
sender   -> CHUNK   {index}    followed by one binary frame
sender   -> DONE
```

`NEED` carries indexes rather than ids, because the receiver already has the ordered `cids` array and indexes are what the progress bitmap is keyed on. Sending ids again would be 64 bytes per chunk to say what one number says.

**Chunks arrive sealed.** This module moves opaque bytes and never touches a key.

**Backpressure is not optional.** A data channel's send buffer is finite; pushing a multi-megabyte chunk into a full one throws or drops it.

- [ ] **Step 1: Write the failing tests**

Create `web/peer.test.mjs`. `RTCPeerConnection` does not exist in Node, so these test the framing and the negotiation against a pair of fake channels, which is where the bugs live.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { WIRE, negotiate, receive } from './peer.js';

function pipePair() {
  const a = { sent: [], onmessage: null, bufferedAmount: 0, readyState: 'open' };
  const b = { sent: [], onmessage: null, bufferedAmount: 0, readyState: 'open' };
  a.send = (d) => { a.sent.push(d); queueMicrotask(() => b.onmessage?.({ data: d })); };
  b.send = (d) => { b.sent.push(d); queueMicrotask(() => a.onmessage?.({ data: d })); };
  a.addEventListener = () => {};
  b.addEventListener = () => {};
  return [a, b];
}

const MANIFEST = {
  name: 'holiday.jpg', size: 9, mime: 'image/jpeg',
  cids: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
};
const bodies = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([7, 8, 9])];
const readChunk = (i) => bodies[i];

test('the receiver asks only for what it lacks', async () => {
  const [send, recv] = pipePair();
  const got = [];
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async (i) => i === 1, // already holds the middle chunk, as on a resend
    onChunk: async (i, bytes) => got.push([i, bytes]),
  });
  const result = await negotiate(send, MANIFEST, readChunk);
  await receiving;

  assert.equal(result.accepted, true);
  assert.equal(result.sent, 2);
  assert.equal(result.held, 1);
  assert.deepEqual(got.map(([i]) => i), [0, 2]);
  assert.deepEqual(got[0][1], bodies[0]);
});

test('a declined offer sends nothing', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: false, reason: 'not now' }),
    has: async () => false,
    onChunk: async () => assert.fail('a declined transfer must send nothing'),
  });
  const result = await negotiate(send, MANIFEST, readChunk);
  await receiving;

  assert.equal(result.accepted, false);
  assert.equal(result.sent, 0);
  assert.equal(result.reason, 'not now');
});

test('a receiver holding everything accepts and receives nothing', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => true,
    onChunk: async () => assert.fail('nothing should be sent'),
  });
  const result = await negotiate(send, MANIFEST, readChunk);
  await receiving;
  assert.equal(result.sent, 0);
  assert.equal(result.held, 3);
});

test('the offer carries no key material', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: false }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, MANIFEST, readChunk);
  await receiving;

  const offer = JSON.parse(send.sent[0]);
  assert.equal(offer.type, WIRE.OFFER);
  // Chunk hashes are the per-chunk key material. They travel only inside the
  // sealed chunk list, never in a control frame.
  assert.ok(!JSON.stringify(offer).includes('hash'));
});

test('each chunk frame is followed by exactly its body', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, MANIFEST, readChunk);
  await receiving;

  const kinds = send.sent.map((d) => (typeof d === 'string' ? JSON.parse(d).type : 'binary'));
  assert.deepEqual(kinds, [
    WIRE.OFFER,
    WIRE.CHUNK, 'binary',
    WIRE.CHUNK, 'binary',
    WIRE.CHUNK, 'binary',
    WIRE.DONE,
  ]);
});

test('a body arriving with no header is ignored', async () => {
  // A peer that sends a stray binary frame must not have it written under
  // whatever index happened to be pending.
  const [send, recv] = pipePair();
  let written = 0;
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => true,
    onChunk: async () => { written++; },
  });
  recv.onmessage?.({ data: new Uint8Array([9, 9, 9]) });
  await negotiate(send, MANIFEST, readChunk);
  await receiving;
  assert.equal(written, 0);
});
```

- [ ] **Step 2: Write `web/peer.js`**

```js
// Direct transfer over a WebRTC data channel. Chunks arrive here already sealed,
// so this module moves opaque bytes and never touches a key.
//
// The negotiation is deliberately the same question the server is asked: which
// of these chunks do you already have. A peer holding an earlier version of a
// file answers with only what changed, so delta sync works on the direct path
// with no extra machinery.

export const WIRE = {
  OFFER: 'offer',
  DECLINE: 'decline',
  NEED: 'need',
  CHUNK: 'chunk',
  DONE: 'done',
};

// A data channel's send buffer is finite. Pushing a multi-megabyte chunk into a
// full one throws or silently drops it.
const HIGH_WATER = 4 << 20;

function waitForDrain(channel) {
  if (channel.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = HIGH_WATER / 2;
    channel.addEventListener('bufferedamountlow', () => resolve(), { once: true });
  });
}

async function send(channel, value) {
  await waitForDrain(channel);
  channel.send(value);
}

// negotiate drives the sending half and resolves when the transfer ends, either
// because it finished or because the peer refused it.
export function negotiate(channel, manifest, readChunk) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    channel.onmessage = async (event) => {
      if (typeof event.data !== 'string') return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }

      if (frame.type === WIRE.DECLINE) {
        finish({ accepted: false, sent: 0, held: 0, reason: frame.reason || '' });
        return;
      }
      if (frame.type !== WIRE.NEED) return;

      try {
        const wanted = new Set(frame.indexes || []);
        let sent = 0;
        for (let i = 0; i < manifest.cids.length; i++) {
          if (!wanted.has(i)) continue;
          const bytes = await readChunk(i);
          await send(channel, JSON.stringify({ type: WIRE.CHUNK, index: i }));
          await send(channel, bytes);
          sent++;
        }
        await send(channel, JSON.stringify({ type: WIRE.DONE }));
        finish({ accepted: true, sent, held: manifest.cids.length - sent });
      } catch (err) {
        if (!settled) { settled = true; reject(err); }
      }
    };

    // The offer names the file and its chunks. It carries no hashes: those are
    // the per-chunk key material and they live only in the sealed chunk list.
    send(channel, JSON.stringify({
      type: WIRE.OFFER,
      name: manifest.name,
      size: manifest.size,
      mime: manifest.mime,
      cids: manifest.cids,
    })).catch(reject);
  });
}

// receive drives the receiving half. onOffer decides whether to take it, has()
// answers the dedup question per index, and onChunk is handed each sealed chunk.
export function receive(channel, { onOffer, has, onChunk }) {
  return new Promise((resolve, reject) => {
    let pending = null;
    let received = 0;

    channel.onmessage = async (event) => {
      try {
        if (typeof event.data !== 'string') {
          // A body with no header is not ours to keep. Writing it under
          // whatever index was last seen would corrupt the file silently.
          if (pending === null) return;
          const bytes = event.data instanceof Uint8Array
            ? event.data
            : new Uint8Array(event.data);
          const index = pending;
          pending = null;
          await onChunk(index, bytes);
          received++;
          return;
        }

        const frame = JSON.parse(event.data);
        if (frame.type === WIRE.OFFER) {
          const decision = await onOffer(frame);
          if (!decision.accept) {
            channel.send(JSON.stringify({ type: WIRE.DECLINE, reason: decision.reason || '' }));
            resolve({ accepted: false, received: 0 });
            return;
          }
          const need = [];
          for (let i = 0; i < frame.cids.length; i++) {
            if (!await has(i)) need.push(i);
          }
          channel.send(JSON.stringify({ type: WIRE.NEED, indexes: need }));
          return;
        }
        if (frame.type === WIRE.CHUNK) {
          pending = frame.index;
          return;
        }
        if (frame.type === WIRE.DONE) {
          resolve({ accepted: true, received });
        }
      } catch (err) {
        reject(err);
      }
    };
  });
}

// On a tailnet ICE finds the 100.x addresses as host candidates, so there is no
// STUN and no TURN to configure. An empty server list is correct here rather
// than an oversight.
export function newConnection() {
  return new RTCPeerConnection({ iceServers: [] });
}
```

- [ ] **Step 3: Run the tests and commit**

```bash
node --test web/peer.test.mjs
git add web/peer.js web/peer.test.mjs
git commit -m "feat(peer): direct transfer framing with peer-side dedup negotiation"
```

---

### Task 31: Session orchestration

**Files:**
- Create: `web/session.js`
- Modify: `web/app.js`, `web/api.js`

**Interfaces:**
- Produces: `startSend(transferId)`, `handleSignal(payload)`, `drainQueue()`

This is where the pieces meet: presence and signalling from task 27, the queue and bitmaps from 28, staging from 29, and the channel from 30.

**Sending:** for each queued transfer, if a recipient is online, build a connection, send the offer through the signalling relay, and on connection run `negotiate` reading chunks from staging. On completion clear the stage.

**Receiving:** on a `signal` event, answer, and run `receive` with `has` reading from staging and `onChunk` writing to it. After each session write the progress bitmap to the server so the sender knows what is left even after both sides disconnect.

**Draining:** `drainQueue` runs on app open and whenever a presence change arrives. That is what makes "open the app and it sends" true rather than "keep the app open".

- [ ] **Step 1: Add the API methods**

```js
  presence: () => json('/api/presence'),
  signal: (to, payload) => sendJSON('/api/signal', { to, payload }),
  queue: () => json('/api/queue'),
  putProgress: (id, bitmap) => sendBytes(`/api/transfer/${id}/progress`, bitmap),
  getProgress: async (id, node) =>
    new Uint8Array(await (await req(
      `/api/transfer/${id}/progress?node=${encodeURIComponent(node)}`)).arrayBuffer()),
```

- [ ] **Step 2: Write `web/session.js`**

Implement against the interfaces above, holding at most one active session per peer. Requirements this module must meet, each of which is a way it can go wrong:

- **One session per peer at a time.** Two concurrent channels to the same device would interleave chunk frames and corrupt both transfers.
- **Write progress after every session, including a failed one.** A transfer that moved 400 of 500 chunks before the network dropped must resume at 400, and only the written bitmap can tell the sender that.
- **Never delete staged chunks until the recipient's bitmap confirms them.** Deleting on send would lose a chunk whose delivery failed after it left.
- **Treat a decline as final and a failure as retryable.** Re-offering a declined transfer would deliver a file the recipient refused.
- **Time out a handshake.** A peer that answers the signal but never opens a channel must not hold the queue.

- [ ] **Step 3: Wire it into the app**

In `web/app.js`, after `listen()`:

```js
  onSignal(async (payload) => {
    const { handleSignal } = await import('./session.js');
    await handleSignal(payload);
  });
  const { drainQueue } = await import('./session.js');
  await requestPersistence();
  drainQueue();
  onInbox(() => drainQueue());
```

- [ ] **Step 4: Verify**

```bash
node --test web/*.test.mjs && go test ./...
```

Then with two devices on the tailnet:

1. Send a 200 MB file from A to B with both apps open. B prompts, accept, it transfers. Confirm `ls data/` on the server shows **no** chunk content.
2. `cmp` the received file against the original.
3. Send the same file again and confirm B asks for nothing.
4. Decline on B and confirm A reports it and does not retry.
5. **Close B entirely and send.** A reports it queued. Open B: it transfers without A being touched, because A drained on its own last open. If A is also closed, open A and confirm it drains then.
6. **Interrupt a large transfer** by killing B's network at roughly half, then reconnect. Confirm it resumes near half rather than restarting, and that the server's progress bitmap reflects it.
7. Reload both pages mid-transfer and confirm it still resumes, which is what staging exists for.
8. Send a 2 GB file and watch memory. It must stay flat on both ends.

- [ ] **Step 5: Commit**

```bash
git add web/session.js web/app.js web/api.js
git commit -m "feat(session): queued peer-to-peer delivery with resumable progress"
```

---

### Task 32: Hold-for-me, the one server-storage path

**Files:**
- Modify: `web/views/send.js`, `web/upload.js`, `web/app.css`, `README.md`

The existing server upload path becomes an explicit per-transfer choice rather than the default. A checkbox on the send screen, off by default, labelled:

> **Hold on the server if I go offline** - the file is uploaded encrypted so it arrives even if this device is closed. Otherwise it waits here until both devices are online.

When ticked, the transfer uses `uploadThroughServer`, which is already built and reviewed. When not, it is queued for direct delivery.

This is the only path by which content reaches the server, and even then it is ciphertext under a key the server does not hold.

- [ ] **Step 1** Add the checkbox and route `sendNow` on its value.
- [ ] **Step 2** Update the README's feature section to describe the default as peer to peer and this as the exception.
- [ ] **Step 3** Commit: `feat(send): make server storage an explicit per-transfer choice`

---

### Task 33: Relays, replanned

**Deferred until tasks 27 through 32 are complete.** Relays were originally specified as mirroring transfers to a peer instance, and there is no longer content on a server to mirror.

A relay is now a second instance that shares the queue and the signalling relay, so devices talking to different instances can still find each other and then connect **directly**. That is a smaller and different feature: it forwards pending transfer records, progress bitmaps, presence, and session descriptions, and never any file content.

Write this task's plan once the queue exists, so it is specified against the real shapes rather than guessed at.
