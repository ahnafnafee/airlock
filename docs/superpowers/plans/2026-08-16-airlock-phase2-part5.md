# Airlock Phase 2 Implementation Plan, part 5: direct transfer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-16-airlock-phase2-part4.md`. Numbering is unbroken and the Phase 2 Global Constraints bind every task here.

**Spec:** `docs/superpowers/specs/2026-08-15-airlock-design.md`, sections 1 and 5.

**What these tasks add.** When both devices have the app open, bytes go straight across the tailnet over a WebRTC data channel in one hop, and the server stores nothing. When the receiver is asleep or closed, everything falls back to the encrypted inbox already built.

**Why this is additive rather than a rewrite.** Chunks are sealed before they touch any transport, so a data channel and an HTTP body carry identical bytes. The negotiation is the same question either way, "which of these chunk ids do you already have", asked of a peer instead of the server. Nothing about the crypto, the chunking, or the dedup changes.

**Why the fallback is not optional.** A browser has no listening socket and a service worker cannot hold a data channel open, so a closed device cannot receive directly at all. Removing the stored path would break "leave this for my desktop overnight", which is most of what a personal transfer tool is for.

**Why the tailnet makes this easy.** ICE finds the `100.x` addresses as host candidates, so there is no STUN server, no TURN server, and no relay fallback to configure. The signalling server's only job is to pass two blobs it cannot interpret.

---

### Task 27: Presence and signalling

**Files:**
- Modify: `events.go`, `server.go`, `main.go`
- Test: `events_test.go`, `server_test.go`

**Interfaces:**
- New: `func (e *Events) Online() []string`
- New: `func (e *Events) Send(to string, payload string) bool`
- New routes: `GET /api/presence`, `POST /api/signal`
- The SSE stream gains a second event type, `signal`

**The server is a postbox here, nothing more.** It relays opaque strings between two nodes and never parses them. SDP and ICE candidates are the peers' business, and treating them as data the server understands would be the first step toward the server needing to.

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
	// The sender needs to know this so it can spool instead of waiting for an
	// answer that will never come.
	if e.Send("nobody", "sdp-blob") {
		t.Fatal("Send should report false when the node has no stream")
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

	// No stream for the target, so the sender is told to fall back.
	w := do(t, s, "POST", "/api/signal", `{"to":"desktop","payload":"x"}`)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("signal to an absent node = %d, want 503", w.Code)
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
// Online reports which nodes currently hold at least one open stream. A device
// with several tabs open is still one device.
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

// Send delivers one opaque signalling payload to every stream a node holds, and
// reports whether anything received it. The caller needs that answer: a sender
// whose offer went nowhere has to spool the transfer instead of waiting for a
// reply that will never arrive.
//
// The payload is a string the server never parses. Session descriptions and ICE
// candidates are the peers' business.
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

The nudge channel is buffered by one, which is right for a nudge and wrong for signalling, where dropping a message stalls a handshake. Widen it in `Subscribe`:

```go
	// Nudges collapse, so one would do. Signalling messages do not: dropping an
	// answer or a candidate stalls a handshake that has no other way to recover.
	ch := make(chan string, 16)
```

- [ ] **Step 3: Emit the event type in the SSE handler**

In `server.go`'s `events` handler, the channel now carries two kinds of message. Replace the send with:

```go
		case msg, open := <-ch:
			if !open {
				return
			}
			if payload, ok := strings.CutPrefix(msg, "signal:"); ok {
				// Newlines would terminate the SSE field early, and a session
				// description is full of them, so signalling payloads travel
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
	// Only a device this server knows may be signalled, so the relay cannot be
	// used to reach anything the caller could not already reach.
	if !s.cfg.Devices.Allowed(req.To) {
		http.Error(w, "unknown device", http.StatusNotFound)
		return
	}
	if !s.cfg.Events.Send(req.To, req.Payload) {
		// Not an error: the sender uses this to decide to spool instead.
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

### Task 28: The direct channel

**Files:**
- Create: `web/peer.js`
- Modify: `web/api.js`, `web/app.js`
- Test: `web/peer.test.mjs`

**Interfaces:**
- Produces, from `web/peer.js`:
  - `export async function offerTransfer(to, manifest, readChunk, opts) -> {accepted, sent, held}`
  - `export function onOffer(handler)` where the handler receives `{from, manifest, accept, decline}`
  - `export function attachSignalling(send, subscribe)`
  - `export const WIRE = { OFFER, ACCEPT, DECLINE, NEED, CHUNK, DONE }`

**The wire protocol on the data channel**, all JSON control frames except chunk bodies, which are binary and preceded by their own control frame:

```
sender  -> OFFER   {name, size, mime, cids: [...]}
receiver -> DECLINE {reason}                        ends here
receiver -> ACCEPT
receiver -> NEED   {cids: [...]}    the same dedup question, asked of a peer
sender  -> CHUNK   {cid}            then one binary frame carrying that chunk
sender  -> DONE
```

`NEED` is why this is not a second protocol. A receiver that already holds a chunk, because it was sent the same file before or an earlier version of it, asks for nothing, and the direct path gets dedup and delta sync for free from the work already done.

**Chunks are already sealed** when they reach this module. It moves opaque bytes and never touches a key.

**Backpressure is not optional.** A data channel's send buffer is finite, and pushing an 8 MiB chunk into a full one throws or silently drops. Wait on `bufferedamountlow` before every send.

- [ ] **Step 1: Write the failing tests**

Create `web/peer.test.mjs`. `RTCPeerConnection` does not exist in Node, so these test the framing and the negotiation, which is where the bugs live, against a pair of fake channels.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { WIRE, negotiate, receive } from './peer.js';

// A pair of in-memory channels standing in for a data channel on each end.
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

const chunks = {
  ['a'.repeat(64)]: new Uint8Array([1, 2, 3]),
  ['b'.repeat(64)]: new Uint8Array([4, 5, 6]),
  ['c'.repeat(64)]: new Uint8Array([7, 8, 9]),
};

test('the receiver asks only for chunks it lacks', async () => {
  const [send, recv] = pipePair();
  const got = [];

  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    // Pretend the middle chunk is already here, as it would be for a resend.
    has: (cid) => cid === 'b'.repeat(64),
    onChunk: (cid, bytes) => got.push([cid, bytes]),
  });
  const result = await negotiate(send, MANIFEST, (cid) => chunks[cid]);
  await receiving;

  assert.equal(result.accepted, true);
  assert.equal(result.sent, 2, 'only the two missing chunks should cross the wire');
  assert.equal(result.held, 1);
  assert.deepEqual(got.map(([cid]) => cid), ['a'.repeat(64), 'c'.repeat(64)]);
  assert.deepEqual(got[0][1], chunks['a'.repeat(64)]);
});

test('a declined offer sends no chunks', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: false, reason: 'not now' }),
    has: () => false,
    onChunk: () => assert.fail('a declined transfer must send nothing'),
  });
  const result = await negotiate(send, MANIFEST, (cid) => chunks[cid]);
  await receiving;

  assert.equal(result.accepted, false);
  assert.equal(result.sent, 0);
  assert.equal(result.reason, 'not now');
});

test('a receiver that already holds everything accepts and receives nothing', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: () => true,
    onChunk: () => assert.fail('nothing should be sent'),
  });
  const result = await negotiate(send, MANIFEST, (cid) => chunks[cid]);
  await receiving;

  assert.equal(result.accepted, true);
  assert.equal(result.sent, 0);
  assert.equal(result.held, 3);
});

test('the offer carries no key material', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: false }),
    has: () => false,
    onChunk: () => {},
  });
  await negotiate(send, MANIFEST, (cid) => chunks[cid]);
  await receiving;

  const offer = JSON.parse(send.sent[0]);
  assert.equal(offer.type, WIRE.OFFER);
  // The chunk hashes are the key material for this transfer. They travel in the
  // sealed chunk list, never in a control frame a peer could log.
  assert.ok(!('hashes' in offer), 'the offer must not carry chunk hashes');
  assert.ok(!JSON.stringify(offer).includes('hash'));
});

test('a chunk frame is followed by exactly its bytes', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: () => false,
    onChunk: () => {},
  });
  await negotiate(send, MANIFEST, (cid) => chunks[cid]);
  await receiving;

  // Alternating control frame and binary body, ending with DONE.
  const kinds = send.sent.map((d) => (typeof d === 'string' ? JSON.parse(d).type : 'binary'));
  assert.deepEqual(kinds, [
    WIRE.OFFER,
    WIRE.CHUNK, 'binary',
    WIRE.CHUNK, 'binary',
    WIRE.CHUNK, 'binary',
    WIRE.DONE,
  ]);
});
```

- [ ] **Step 2: Write `web/peer.js`**

```js
// Direct transfer over a WebRTC data channel. Chunks arrive here already sealed,
// so this module moves opaque bytes and never touches a key.
//
// The negotiation is deliberately the same question the server is asked: which
// of these chunk ids do you already have. A peer that holds an earlier version
// of a file answers with only the changed chunks, so delta sync works on the
// direct path with no extra machinery.

export const WIRE = {
  OFFER: 'offer',
  ACCEPT: 'accept',
  DECLINE: 'decline',
  NEED: 'need',
  CHUNK: 'chunk',
  DONE: 'done',
};

// A data channel's send buffer is finite. Pushing a multi-megabyte chunk into a
// full one throws or drops it, so every send waits for the buffer to drain.
const HIGH_WATER = 4 << 20;

function waitForDrain(channel) {
  if (channel.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = HIGH_WATER / 2;
    channel.addEventListener('bufferedamountlow', () => resolve(), { once: true });
  });
}

const send = async (channel, value) => {
  await waitForDrain(channel);
  channel.send(value);
};

// negotiate drives the sending half and resolves once the transfer ends, either
// because it finished or because the peer declined.
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
        const wanted = new Set(frame.cids || []);
        let sent = 0;
        for (const cid of manifest.cids) {
          if (!wanted.has(cid)) continue;
          const bytes = await readChunk(cid);
          await send(channel, JSON.stringify({ type: WIRE.CHUNK, cid }));
          await send(channel, bytes);
          sent++;
        }
        await send(channel, JSON.stringify({ type: WIRE.DONE }));
        finish({ accepted: true, sent, held: manifest.cids.length - sent });
      } catch (err) {
        if (!settled) { settled = true; reject(err); }
      }
    };

    // The offer describes the file and names its chunks. It carries no hashes:
    // those are the per-chunk key material and they travel only inside the
    // sealed chunk list.
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
// answers the dedup question, and onChunk is handed each sealed chunk in order.
export function receive(channel, { onOffer, has, onChunk }) {
  return new Promise((resolve, reject) => {
    let pendingCid = null;
    let received = 0;

    channel.onmessage = async (event) => {
      try {
        if (typeof event.data !== 'string') {
          if (!pendingCid) return; // a body with no header is not ours to keep
          const bytes = event.data instanceof Uint8Array
            ? event.data
            : new Uint8Array(event.data);
          await onChunk(pendingCid, bytes);
          pendingCid = null;
          received++;
          return;
        }

        const frame = JSON.parse(event.data);
        switch (frame.type) {
          case WIRE.OFFER: {
            const decision = await onOffer(frame);
            if (!decision.accept) {
              channel.send(JSON.stringify({
                type: WIRE.DECLINE, reason: decision.reason || '',
              }));
              resolve({ accepted: false, received: 0 });
              return;
            }
            const need = [];
            for (const cid of frame.cids) {
              if (!await has(cid)) need.push(cid);
            }
            channel.send(JSON.stringify({ type: WIRE.ACCEPT }));
            channel.send(JSON.stringify({ type: WIRE.NEED, cids: need }));
            return;
          }
          case WIRE.CHUNK:
            pendingCid = frame.cid;
            return;
          case WIRE.DONE:
            resolve({ accepted: true, received });
            return;
          default:
            return;
        }
      } catch (err) {
        reject(err);
      }
    };
  });
}
```

- [ ] **Step 3: Run the tests**

Run: `node --test web/peer.test.mjs`
Expected: PASS, five tests.

- [ ] **Step 4: Add the signalling client**

Append to `web/peer.js`:

```js
// Signalling travels as base64 over the server's event stream, because a session
// description is full of newlines and an SSE data field ends at the first one.
const b64 = {
  encode: (obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj)))),
  decode: (s) => JSON.parse(new TextDecoder().decode(
    Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))),
};

// On a tailnet ICE finds the 100.x addresses as host candidates, so there is no
// STUN and no TURN to configure. An empty server list is correct here, not an
// oversight.
const RTC_CONFIG = { iceServers: [] };

export function newConnection() {
  return new RTCPeerConnection(RTC_CONFIG);
}

export { b64 };
```

Add to `web/api.js`:

```js
  presence: () => json('/api/presence'),
  signal: (to, payload) => req('/api/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, payload }),
  }),
```

In `web/app.js`, route `signal` events from the stream to a handler registry beside the existing `onInbox`:

```js
const signalListeners = new Set();
export function onSignal(fn) { signalListeners.add(fn); }
```

and inside `listen()`:

```js
  source.addEventListener('signal', (event) => {
    for (const fn of signalListeners) fn(event.data);
  });
```

- [ ] **Step 5: Commit**

```bash
git add web/peer.js web/peer.test.mjs web/api.js web/app.js
git commit -m "feat(peer): direct transfer framing with peer-side dedup negotiation"
```

---

### Task 29: Prefer direct, fall back to the inbox

**Files:**
- Modify: `web/views/send.js`, `web/views/inbox.js`, `web/app.js`, `web/sw.js`, `web/app.css`

**Interfaces:**
- Produces: `export async function sendDirect(file, to, opts) -> {ok, reason}` in `web/views/send.js`
- Produces: a service-worker route `GET /dl/live/{token}` streaming a transfer as it arrives

**The decision is the sender's and it is made once, before any bytes move.** Ask who is online. If the chosen recipient is there, try direct. If the offer is declined, stop, because a decline means no. If the channel fails to open or the peer never answers, spool to the inbox, because a failure is not a refusal.

**Saving without buffering.** A live transfer's bytes arrive in the page, not on the server, so `/dl/{id}` cannot serve them. The page registers a stream with the worker under a one-time token and points a download at `/dl/live/{token}`; the worker returns a `Response` whose body the page feeds as chunks decrypt. The browser writes to disk as it goes, so a 20 GB live transfer costs no more memory than a small one.

- [ ] **Step 1: Add the live download route to `web/sw.js`**

```js
// A live transfer's bytes never reach the server, so the page hands them here.
// The browser then saves the response the same way it saves any download,
// streaming to disk rather than buffering.
const liveStreams = new Map();

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'live') return;
  liveStreams.set(event.data.token, {
    stream: event.data.stream,
    name: event.data.name,
    size: event.data.size,
  });
});

async function liveDownload(token) {
  const entry = liveStreams.get(token);
  if (!entry) return new Response('this transfer is no longer available', { status: 404 });
  liveStreams.delete(token);

  const filename = encodeURIComponent(entry.name);
  return new Response(entry.stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(entry.size),
      'Content-Disposition':
        `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
    },
  });
}
```

and in the `fetch` listener, before the existing `/dl/` branch so the more specific path wins:

```js
  if (event.request.method === 'GET' && url.pathname.startsWith('/dl/live/')) {
    event.respondWith(liveDownload(url.pathname.slice(9)));
    return;
  }
```

The page transfers a `ReadableStream` to the worker, which browsers support as a transferable object. If a target browser refuses it, fall back to the spooled path rather than buffering the file in memory, and say so in your report.

- [ ] **Step 2: Try direct in the send flow**

In `web/views/send.js`, `sendNow` chooses a path per file:

```js
  async function sendNow(files) {
    const to = recipient.value ? [recipient.value] : [];
    for (const file of files) {
      // Direct needs one named recipient who is online. "All my devices" spools,
      // because a single channel cannot serve several receivers and fanning out
      // would send the bytes as many times as there are devices.
      let online = [];
      try {
        online = await api.presence();
      } catch {
        online = [];
      }
      const peer = to.length === 1 && online.includes(to[0]) ? to[0] : null;

      if (peer) {
        const result = await sendDirect(file, peer);
        if (result.ok) {
          status.textContent = `Sent ${file.name} directly to ${peer}`;
          continue;
        }
        if (result.declined) {
          // A decline is an answer, not a failure. Spooling it anyway would
          // deliver the file the recipient just refused.
          status.textContent = `${peer} declined ${file.name}`;
          continue;
        }
        status.textContent = `Direct transfer failed, sending through the server`;
      }
      await uploadThroughServer(file, to);
    }
  }
```

`uploadThroughServer` is the existing upload path, renamed.

- [ ] **Step 3: Answer offers in the inbox view**

Register a signal handler when the app boots so an offer is answered whether or not the Send view is mounted. In `web/app.js`, after `listen()`:

```js
  onSignal(async (payload) => {
    const { handleSignal } = await import('./peer-session.js');
    await handleSignal(payload);
  });
```

`web/peer-session.js` owns one live session at a time: it answers an offer by showing a prompt naming the sender, the filename and the size, with Accept and Decline, then wires `receive()` to a stream fed to the worker. Reuse `el` from `app.js` and the visual tokens; the prompt uses `--sodium` for Accept and plain ghost styling for Decline, matching the notification's two actions so the same words mean the same things in both places.

- [ ] **Step 4: Verify**

```bash
node --test web/*.test.mjs && go test ./...
```

Then with two browsers open on two tailnet devices:

1. Send a 200 MB file from A to B with both apps open. B prompts with the name and size; accept and it transfers. Confirm `ls data/chunks` on the server does **not** grow.
2. Compare the received file against the original with `cmp`.
3. Send the same file again and confirm B asks for nothing, because it already holds every chunk.
4. Decline an offer on B and confirm A reports the decline and does **not** spool it.
5. Close B entirely and send again. A reports falling back, the file lands in the inbox, and B gets a notification when it reopens.
6. Send to "All my devices" with B open and confirm it spools rather than going direct.
7. Start a direct transfer and kill B's network mid-flight. A must report a failure and not hang.
8. Send a 2 GB file directly and watch memory in the task manager. It must stay flat.

- [ ] **Step 5: Commit**

```bash
git add web/views/send.js web/views/inbox.js web/peer-session.js web/app.js web/sw.js web/app.css
git commit -m "feat(send): prefer a direct channel, fall back to the inbox"
```
