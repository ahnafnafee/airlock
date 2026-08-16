# Airlock Phase 2 Implementation Plan, part 6: throughput

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-16-airlock-phase2-part5.md`, tasks 27 through 32. Task 33 was relays, which are cancelled outright rather than deferred: content never passes through a server, so there is nothing for a relay to relay that presence and signalling do not already cover.

**Spec:** `docs/superpowers/specs/2026-08-15-airlock-design.md`, section 6.

## What these tasks are for

The target is a LAN, where the link is a gigabit or better and every bottleneck is on our side of the wire. Five of them, in the order they bind:

1. **Chunks larger than the data channel's message limit do not send at all.** This is a correctness bug rather than a slow path: an 8 MiB chunk sent as one message fails, and the safe interop limit is 64 KiB.
2. **One `RTCPeerConnection` is one SCTP association**, with one congestion window and one UDP socket. Several connections multiply throughput; several channels on one connection do not.
3. **Ordered delivery costs head-of-line blocking** for no benefit, because chunks carry their index and are reassembled by it.
4. **Sealing runs on the main thread, one chunk at a time**, while every other core sits idle.
5. **The file is read twice**, once to compute ids and once to seal.

And one reliability property that matters more than any of them: **the sending device must not fall asleep halfway.**

**What none of this removes.** The floor is `usrsctp`, single threaded and CPU bound, and it is not a setting. These tasks strip away everything that is not that floor, which should take a single-channel figure of roughly 100 to 300 Mbps to something approaching a gigabit link. Saturating 10 GbE would need a native peer, where bytes never enter a JavaScript runtime, at the cost of a second implementation of the crypto. That trade was already made once, against.

Nothing here changes the wire format, the crypto, or the chunk ids. These are the same bytes, moving faster.

## Rejected, with reasons

Recorded so they are not proposed again, and so the reasoning can be checked against task 36's measurements rather than taken on faith.

**Buffering the file in RAM.** The network moves 12 to 40 MB/s; a SATA SSD reads at roughly 500 MB/s and an NVMe drive at several GB/s. Disk is already one to two orders of magnitude faster than the wire, so this optimizes the step that is not costing anything. It would also destroy the flat-memory property that lets a 20 GB transfer cost what a 20 MB one does, which is the single reason large transfers are expected to be reliable here. The operating system's page cache already provides the part that helps, for free, since recently written chunks are re-read from memory.

**Encrypting or hashing on the GPU.** Web Crypto's AES-GCM reaches AES-NI, a dedicated instruction performing an AES round per cycle, and already runs at several GB/s. A GPU has no equivalent instruction, so AES would run as shader code, and the data would pay a PCIe round trip to reach VRAM and return. At the demand rate above, the transfer overhead alone exceeds the entire cost of the encryption. The same holds for SHA-256.

The one genuinely parallel piece is boundary detection, and it only binds above roughly 1.6 Gbps. Even then the cheap answer is SeqCDC, a byte-comparison loop, before anything involving a GPU.

**If task 36's breakdown shows disk read or crypto to be a meaningful share of the wall clock, these conclusions are wrong and should be revisited.** That is what step 4 of it measures.

---

### Task 33: Keep the device awake

**Files:**
- Create: `web/wake.js`
- Modify: `web/session.js`, `web/app.js`
- Test: `web/wake.test.mjs`

**Interfaces:**
- Produces: `export async function holdWakeLock()` returning a release function, and `export function transfersActive(n)`

**The most common way a large transfer fails is the sending device going to sleep.** The Screen Wake Lock API prevents exactly that, and it is the only mechanism a web application has. It cannot keep a closed application running; that gap is real and is why a native client was considered and cut.

Two details that are easy to get wrong and produce a lock that silently does nothing:

- **A wake lock is released when the page is hidden**, and is not restored automatically. It has to be re-acquired on `visibilitychange`.
- **It must be released when the last transfer finishes.** A lock held forever is a battery complaint, and it is the kind of bug nobody reports because the symptom is diffuse.

- [ ] **Step 1: Write the failing tests**

Create `web/wake.test.mjs`. The API does not exist in Node, so a fake stands in and the tests cover the refcount, which is where the leak would be.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { __setWakeLockImpl, transfersActive, activeCount } from './wake.js';

function fakeLock() {
  const state = { held: 0, released: 0 };
  __setWakeLockImpl(async () => {
    state.held++;
    return { release: async () => { state.released++; } };
  });
  return state;
}

test('a lock is taken for the first transfer and released after the last', async () => {
  const state = fakeLock();

  await transfersActive(1);
  assert.equal(state.held, 1);
  await transfersActive(1);
  // Two concurrent transfers, still one lock. Taking a second would leak it.
  assert.equal(state.held, 1);
  assert.equal(activeCount(), 2);

  await transfersActive(-1);
  assert.equal(state.released, 0, 'still one transfer running');
  await transfersActive(-1);
  assert.equal(state.released, 1);
  assert.equal(activeCount(), 0);
});

test('the count never goes negative', async () => {
  fakeLock();
  await transfersActive(-1);
  await transfersActive(-1);
  assert.equal(activeCount(), 0);
  // A stray release must not make the next transfer fail to take a lock.
  await transfersActive(1);
  assert.equal(activeCount(), 1);
});

test('a browser without the API degrades quietly', async () => {
  __setWakeLockImpl(null);
  await transfersActive(1);
  await transfersActive(-1);
  assert.equal(activeCount(), 0);
});

test('a rejected request does not wedge the count', async () => {
  // Some browsers refuse a lock on a background tab. That must not stop the
  // transfer or leave the refcount stuck.
  __setWakeLockImpl(async () => { throw new Error('refused'); });
  await transfersActive(1);
  assert.equal(activeCount(), 1);
  await transfersActive(-1);
  assert.equal(activeCount(), 0);
});
```

- [ ] **Step 2: Write `web/wake.js`**

```js
// The most common way a large transfer fails is the sending device going to
// sleep. A screen wake lock prevents exactly that, for as long as the app is
// open. Nothing a web application can do keeps a closed app running.

let impl = typeof navigator !== 'undefined' && navigator.wakeLock
  ? () => navigator.wakeLock.request('screen')
  : null;

// Test seam. Production never calls this.
export function __setWakeLockImpl(fn) { impl = fn; }

let active = 0;
let lock = null;

export function activeCount() { return active; }

async function acquire() {
  if (lock || !impl) return;
  try {
    lock = await impl();
  } catch {
    // Some browsers refuse a lock on a background tab. The transfer still
    // works; it is just more likely to be interrupted, so this is not worth
    // failing over.
    lock = null;
  }
}

async function release() {
  const held = lock;
  lock = null;
  if (held) {
    try {
      await held.release();
    } catch {
      // Already released by the browser, which happens when the page is hidden.
    }
  }
}

// transfersActive(+1) when a transfer starts, (-1) when it ends. One lock is
// held for any number of concurrent transfers: taking one each would leak all
// but the last.
export async function transfersActive(delta) {
  active = Math.max(0, active + delta);
  if (active > 0) await acquire();
  else await release();
}

if (typeof document !== 'undefined') {
  // A wake lock is dropped when the page is hidden and is not restored on its
  // own. Without this the lock silently stops working after the first time the
  // user switches away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active > 0) acquire();
  });
}
```

- [ ] **Step 3: Hold it around transfers**

In `web/session.js`, wrap every send and receive session:

```js
  await transfersActive(1);
  try {
    // ... run the session
  } finally {
    await transfersActive(-1);
  }
```

The `finally` is the point: a session that throws must still release, or the device never sleeps again until the tab closes.

- [ ] **Step 4: Verify and commit**

```bash
node --test web/wake.test.mjs
```

On a phone: start a large transfer, put the phone down, and confirm the screen stays on and the transfer completes. Then confirm the screen sleeps normally once it finishes.

```bash
git add web/wake.js web/wake.test.mjs web/session.js web/app.js
git commit -m "feat(web): hold a screen wake lock while transfers are running"
```

---

### Task 34: Parallel connections, unordered channels, correct fragmentation

**Files:**
- Modify: `web/peer.js`, `web/session.js`
- Test: `web/peer.test.mjs`

**Interfaces:**
- New: `export function openChannels(pc, count)`
- Changed: `negotiate(links, manifest, readChunk)` and `receive(links, handlers)` take an array of links, each `{pc, channels}`
- New: `export const LINK_COUNT = 4`, `export const CHANNELS_PER_LINK = 2`, `export const FRAGMENT = 16 << 10`

**Three changes. One is a correctness fix, two are throughput.**

**Fragmentation is not optional, and without it nothing works.** A data channel has a maximum message size, negotiated per connection and readable as `pc.sctp.maxMessageSize`. In practice 64 KiB is the safe interop figure. Sending an 8 MiB chunk as a single message does not run slowly, it fails. Chunks are split into fragments, sent in sequence, and reassembled by byte count on the far side.

**Throughput needs several connections, not several channels.** This corrects an earlier draft of this plan, which had it wrong. Data channels on one `RTCPeerConnection` are SCTP streams inside a single association: they share one congestion window, one DTLS transport, and one UDP socket. Striping across them does not multiply bandwidth. Several `RTCPeerConnection`s do, because each is an independent association.

**Channels within a connection still earn their place**, for head-of-line blocking rather than bandwidth. One stalled fragment holds up everything queued behind it on the same stream, so two unordered streams per connection let a slow fragment be overtaken.

So the shape is `LINK_COUNT` connections, each with `CHANNELS_PER_LINK` unordered channels, and chunk `i` assigned to link `i % LINK_COUNT`. Both constants are named because task 36 measures them, and one of them may turn out to be 1.

**What this cannot do.** The ceiling is `usrsctp`, which is single threaded and CPU bound, and it is not a setting. These changes remove everything that is not that ceiling. On a gigabit link the target is to approach it. On 10 GbE no browser tab will saturate the wire, and only a native peer would, at the cost of a second implementation of the crypto.

- [ ] **Step 1: Write the failing tests**

Replace `pipePair` in `web/peer.test.mjs` with a pool that models the message-size limit, because that is the bug most worth a regression test:

```js
const MAX_MESSAGE = 64 << 10;

function linkPool(links, channelsPerLink) {
  const send = [];
  const recv = [];
  for (let l = 0; l < links; l++) {
    const a = { channels: [] };
    const b = { channels: [] };
    for (let c = 0; c < channelsPerLink; c++) {
      const x = { sent: [], onmessage: null, bufferedAmount: 0, readyState: 'open' };
      const y = { sent: [], onmessage: null, bufferedAmount: 0, readyState: 'open' };
      const wire = (from, to) => (d) => {
        // The real transport refuses an oversize message. Model it, or these
        // tests pass while the product cannot send a single chunk.
        const size = typeof d === 'string' ? d.length : d.byteLength;
        if (size > MAX_MESSAGE) throw new Error(`message of ${size} exceeds maxMessageSize`);
        from.sent.push(d);
        queueMicrotask(() => to.onmessage?.({ data: d }));
      };
      x.send = wire(x, y);
      y.send = wire(y, x);
      x.addEventListener = () => {};
      y.addEventListener = () => {};
      a.channels.push(x);
      b.channels.push(y);
    }
    send.push(a);
    recv.push(b);
  }
  return [send, recv];
}

function bigManifest(count, chunkSize) {
  return {
    name: 'big.bin', size: count * chunkSize, mime: '',
    cids: Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, '0')),
  };
}

test('a chunk larger than the message limit is fragmented and reassembled', async () => {
  // The regression test for the bug that made this task necessary.
  const [send, recv] = linkPool(2, 2);
  const chunkSize = 200 << 10; // well over the 64 KiB limit
  const manifest = bigManifest(3, chunkSize);
  const body = (i) => new Uint8Array(chunkSize).fill(i + 1);

  const got = new Map();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => got.set(i, bytes),
  });
  const result = await negotiate(send, manifest, (i) => body(i));
  await receiving;

  assert.equal(result.sent, 3);
  assert.equal(got.size, 3);
  for (const [i, bytes] of got) {
    assert.equal(bytes.length, chunkSize, `chunk ${i} came back the wrong length`);
    assert.deepEqual(bytes, body(i));
  }
  // Every wire message respected the limit, which the fake enforces by throwing.
  for (const link of send) {
    for (const channel of link.channels) {
      for (const message of channel.sent) {
        const size = typeof message === 'string' ? message.length : message.byteLength;
        assert.ok(size <= MAX_MESSAGE);
      }
    }
  }
});

test('chunks are spread across every link', async () => {
  const [send, recv] = linkPool(4, 1);
  const manifest = bigManifest(12, 1024);
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, manifest, (i) => new Uint8Array(1024).fill(i));
  await receiving;

  for (const [i, link] of send.entries()) {
    const bodies = link.channels.flatMap((c) => c.sent).filter((d) => typeof d !== 'string');
    assert.ok(bodies.length > 0, `link ${i} carried nothing, so work is not spread`);
  }
});

test('two links delivering concurrently do not cross their chunk indexes', async () => {
  // Reassembly state must be per link. A single shared pending index races the
  // moment two links deliver headers at once, and chunks land under each
  // other's indexes. That corruption is invisible with one link, which is
  // exactly why this test exists.
  const [send, recv] = linkPool(4, 2);
  const manifest = bigManifest(16, 4096);
  const got = new Map();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => got.set(i, bytes[0]),
  });
  await negotiate(send, manifest, (i) => new Uint8Array(4096).fill(i));
  await receiving;

  assert.equal(got.size, 16);
  for (const [i, value] of got) assert.equal(value, i, `chunk ${i} holds chunk ${value}'s bytes`);
});

test('the offer travels once, not once per link', async () => {
  const [send, recv] = linkPool(4, 2);
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: false }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, bigManifest(1, 16), () => new Uint8Array(16));
  await receiving;

  const offers = send.flatMap((l) => l.channels).flatMap((c) => c.sent)
    .filter((d) => typeof d === 'string' && JSON.parse(d).type === WIRE.OFFER);
  assert.equal(offers.length, 1);
});
```

- [ ] **Step 2: Rework `web/peer.js`**

```js
export const LINK_COUNT = 4;
export const CHANNELS_PER_LINK = 2;

// 64 KiB is the safe interop maximum for a data channel message. The real limit
// is pc.sctp.maxMessageSize and is read at runtime; this is the fragment size
// used within it. An 8 MiB chunk sent as one message does not run slowly, it
// fails outright.
export const FRAGMENT = 16 << 10;
const SAFE_MAX_MESSAGE = 64 << 10;

// Throughput needs several connections, not several channels. Channels on one
// RTCPeerConnection are SCTP streams inside a single association and share one
// congestion window, so striping across them buys no bandwidth. Separate
// connections are separate associations.
//
// Channels within a connection still earn their place: they are unordered, so a
// stalled fragment on one stream does not hold up what is queued behind it.
export function openChannels(pc, count = CHANNELS_PER_LINK) {
  return Array.from({ length: count }, (_, i) => {
    const channel = pc.createDataChannel(`airlock-${i}`, { ordered: false });
    // Without this, Safari hands back a Blob and every chunk needs an extra
    // async read before it can be decrypted.
    channel.binaryType = 'arraybuffer';
    return channel;
  });
}

// WebKit publishes no per-page connection limit and practitioner reports have
// iOS being both more resource constrained and less reliable with several
// connections at once. Opening four there risks trading a working transfer for
// throughput that a phone's link cannot use anyway.
export function linkCountFor(navigatorLike = navigator) {
  const ua = navigatorLike.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua)
    || (ua.includes('Macintosh') && navigatorLike.maxTouchPoints > 1);
  return iOS ? 1 : LINK_COUNT;
}

function fragmentSize(pc) {
  const limit = pc?.sctp?.maxMessageSize;
  if (!limit || limit > SAFE_MAX_MESSAGE) return FRAGMENT;
  return Math.min(FRAGMENT, Math.max(1024, limit - 1024));
}
```

The chunk frame gains a length, so the receiver knows when a chunk is whole:

```
sender -> CHUNK {index, bytes}   then ceil(bytes / fragment) binary messages
```

`negotiate(links, manifest, readChunk)` sends control frames on the first channel of the first link, assigns chunk `i` to `links[i % links.length]`, and writes that chunk's fragments round-robin across that link's channels, awaiting each channel's own drain.

`receive(links, handlers)` attaches a handler to every channel. **Reassembly state is per link, not global.** A fragment is appended to that link's current chunk buffer; when the buffer reaches the declared length the chunk goes to `onChunk` and the state clears. A binary message arriving with no declared chunk is dropped.

- [ ] **Step 3: Negotiate several connections in `web/session.js`**

Each link is its own offer and answer through the signalling relay, tagged with a link index so the far side pairs them correctly. Open them concurrently. A link that fails to connect is dropped from the array rather than failing the transfer, so a transfer degrades to fewer links instead of not happening at all.

- [ ] **Step 4: Verify and commit**

```bash
node --test web/peer.test.mjs
```

The fragmentation test is the one that matters. If it passes while the fake is enforcing the message-size limit, chunks of any size will actually cross the wire.

```bash
git add web/peer.js web/session.js web/peer.test.mjs
git commit -m "feat(peer): parallel connections, unordered channels and message fragmentation"
```

---

### Task 35: Parallel sealing and a single pass over the file

**Files:**
- Create: `web/seal-worker.js`, `web/sealpool.js`
- Modify: `web/upload.js`, `web/session.js`
- Test: `web/sealpool.test.mjs`

**Interfaces:**
- Produces: `export function sealPool(size)` returning `{seal(index, plain), close()}`
- Changed: preparing a transfer stages sealed chunks as it cuts, and returns the id list

**Four wastes, removed together.**

**Two of them are copies rather than computation**, which is the kind of cost that hides because no profile line is named after it:

- **Chunks are structured-cloned into the workers.** `postMessage` copies by default, so every chunk is duplicated on the way in. Passing the buffer in the transfer list makes it a pointer move. The sealed result already comes back transferred; the input was missed.
- **Staging uses the async file API.** `createWritable()` allocates and awaits per write. `createSyncAccessHandle()` is available in dedicated workers and is substantially faster. Since sealing already happens in a worker, staging belongs there too, so the bytes are sealed and written in one place and never cross a thread boundary twice.

**Two are the ones this task was originally for:**

**Sealing was serial.** Cutting is inherently sequential, because a content-defined boundary depends on the bytes before it. Hashing and sealing a chunk depend on nothing but that chunk. So the main thread keeps cutting and hands each chunk to a pool of workers, which is the difference between one core and all of them on the CPU-bound half.

**The file was read twice.** The original design computed ids in one pass and sealed in a second. Now that staging exists, the second read is pure waste: seal during the first pass, write to staging, and send from there. One read of a 20 GB file instead of two.

- [ ] **Step 1: Write the failing tests**

`web/sealpool.test.mjs`, with a fake worker factory so the pool logic is testable without real workers:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sealPool } from './sealpool.js';

// A fake worker that echoes back a deterministic "sealed" value after a delay,
// so ordering and concurrency are observable.
function fakeWorkerFactory(record) {
  return () => {
    const worker = {
      onmessage: null,
      postMessage(msg) {
        record.inFlight++;
        record.peak = Math.max(record.peak, record.inFlight);
        setTimeout(() => {
          record.inFlight--;
          worker.onmessage({
            data: { index: msg.index, cid: `cid${msg.index}`, sealed: msg.plain },
          });
        }, msg.plain[0]);
      },
      terminate() { record.terminated++; },
    };
    return worker;
  };
}

test('results come back keyed by index regardless of completion order', async () => {
  const record = { inFlight: 0, peak: 0, terminated: 0 };
  const pool = sealPool(4, fakeWorkerFactory(record));

  // Deliberately reversed delays, so the last submitted finishes first.
  const results = await Promise.all([
    pool.seal(0, new Uint8Array([30])),
    pool.seal(1, new Uint8Array([20])),
    pool.seal(2, new Uint8Array([10])),
  ]);
  assert.deepEqual(results.map((r) => r.index), [0, 1, 2]);
  assert.deepEqual(results.map((r) => r.cid), ['cid0', 'cid1', 'cid2']);
  pool.close();
});

test('the pool runs several chunks at once', async () => {
  const record = { inFlight: 0, peak: 0, terminated: 0 };
  const pool = sealPool(4, fakeWorkerFactory(record));
  await Promise.all(Array.from({ length: 8 }, (_, i) => pool.seal(i, new Uint8Array([5]))));
  assert.ok(record.peak > 1, `peak concurrency was ${record.peak}, so the pool is serial`);
  assert.ok(record.peak <= 4, `peak concurrency was ${record.peak}, above the pool size`);
  pool.close();
});

test('close terminates every worker', async () => {
  const record = { inFlight: 0, peak: 0, terminated: 0 };
  const pool = sealPool(3, fakeWorkerFactory(record));
  await pool.seal(0, new Uint8Array([1]));
  pool.close();
  assert.equal(record.terminated, 3);
});
```

- [ ] **Step 2: Write `web/seal-worker.js`**

```js
// Hashes and seals one chunk. Cutting stays on the main thread because a
// content-defined boundary depends on the bytes before it; this does not depend
// on anything but its own chunk, which is what makes it parallelizable.
import { chunkIdentity, sealChunk } from './crypto.js';

let master = null;
let mode = null;

let stageDir = null;

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    // A non-extractable CryptoKey survives structured clone, so no key material
    // is serialized to get here.
    master = msg.master;
    mode = msg.mode;
    stageDir = msg.stageDir;
    self.postMessage({ type: 'ready' });
    return;
  }
  try {
    const { h, cid } = await chunkIdentity(master, mode, msg.plain);
    const sealed = await sealChunk(master, mode, h, cid, msg.plain);

    // Written here rather than back on the main thread. The synchronous handle
    // is only available in a worker and is much faster than createWritable, and
    // writing where the bytes already are avoids sending them across a thread
    // boundary a second time.
    const handle = await stageDir.getFileHandle(String(msg.index), { create: true });
    const access = await handle.createSyncAccessHandle();
    try {
      access.write(sealed, { at: 0 });
      access.flush();
    } finally {
      access.close();
    }

    // Only the identity comes back. The sealed bytes stay on disk.
    self.postMessage({ index: msg.index, h, cid });
  } catch (err) {
    self.postMessage({ index: msg.index, error: String(err) });
  }
};
```

- [ ] **Step 3: Write `web/sealpool.js`**

A fixed pool sized from `navigator.hardwareConcurrency`, capped so a 32-core machine does not open 32 workers each holding a chunk in memory. Requirements:

- Results resolve by index, since completion order is not submission order.
- `seal()` applies backpressure when every worker is busy, or the caller can cut faster than the pool seals and hold the whole file in memory.
- `close()` terminates every worker, including on error.
- **Chunks are transferred, not cloned.** `worker.postMessage({index, plain}, [plain.buffer])` moves the buffer instead of copying it. Without the transfer list, every chunk is duplicated on the way in, which is a full extra copy of the file across a transfer and appears in no profile line by name. The plain buffer is unusable by the caller afterward, which is correct: it has been handed over.
- Each worker is initialized once with the master key, the mode, and the staging directory handle, so per-chunk messages carry only an index and bytes.

- [ ] **Step 4: Prepare and stage in one pass**

Rework the preparation step so cutting, sealing and staging happen together:

```js
// One read of the source file. Chunks are cut on this thread, sealed by the
// pool, and written straight into staging, which is where the sender will read
// them from when the peer is reachable. The earlier design read the file once to
// compute ids and again to seal, which is a second full pass over 20 GB for
// nothing.
export async function prepare(file, { mk, mode, cdc, transferId, onProgress }) {
  const stage = await openStage(transferId);
  const pool = sealPool(poolSize(), () => new Worker('/seal-worker.js', { type: 'module' }));
  await pool.init(mk, mode);

  const cids = [];
  const hashes = [];
  const pending = [];
  let index = 0;

  try {
    for await (const plain of chunkFile(file, cdc)) {
      const i = index++;
      // The worker seals and stages. Only the identity comes back, so the bytes
      // cross a thread boundary once, going in, and never come back.
      pending.push(pool.seal(i, plain).then((r) => {
        cids[r.index] = r.cid;
        hashes[r.index] = r.h;
        onProgress?.({ prepared: r.index + 1 });
      }));
    }
    await Promise.all(pending);
  } finally {
    pool.close();
  }
  return { cids, hashes };
}
```

`pending` must be bounded, not unbounded: awaiting only at the end would queue every chunk of a 20 GB file. The pool's own backpressure provides that bound, so `pool.seal` must not resolve its slot until a worker takes the work.

- [ ] **Step 5: Verify and commit**

```bash
node --test web/sealpool.test.mjs
```

In the browser, prepare a 2 GB file and confirm in the Performance panel that several workers are busy at once and that memory stays flat.

```bash
git add web/seal-worker.js web/sealpool.js web/sealpool.test.mjs web/upload.js web/session.js
git commit -m "feat(web): seal chunks in a worker pool during a single pass over the file"
```

---

### Task 36: Measure it

**Files:**
- Create: `docs/benchmarks.md`
- Modify: `web/peer.js` if the channel count is wrong

**Everything in this part was an argument. This is the part that checks.**

Measure on the real LAN, between two real machines, and write down what happened even when it contradicts the reasoning above.

- [ ] **Step 1: Channel count**

Transfer the same 2 GB file with `CHANNEL_COUNT` at 1, 2, 4, 6, 8 and 12. Record MB/s for each. Expect a knee: throughput climbing steeply to some count and flattening after. Set the constant to the knee, not past it, because each channel costs a send buffer.

If one channel already saturates the link, say so plainly and set the count to 1. That result would mean the multiplexing in task 34 earns nothing on this hardware, and shipping complexity that earns nothing is worse than not having built it.

- [ ] **Step 2: Ordered against unordered**

Flip `ordered` back to `true` and repeat one run. Record the difference. If it is inside the noise, note that too.

- [ ] **Step 3: Seal pool size**

Time `prepare()` on a 2 GB file with pool sizes 1, 2, 4, 8. Record the wall clock and the peak memory. Look for the point where more workers stop helping, which is usually the core count, and for the point where memory becomes uncomfortable.

- [ ] **Step 4: Where the time actually goes**

For one 2 GB LAN transfer, break the wall clock into: reading the file, cutting, hashing and sealing, staging writes, and channel time. This is the number that says what to optimize next, and it is the only way to know whether SeqCDC is worth the risk.

- [ ] **Step 5: Decide on SeqCDC, with evidence**

If cutting is a meaningful share of the total, [SeqCDC](https://cs.uwaterloo.ca/~alkiswan/papers/SeqCDC_Middleware24.pdf) replaces the gear-hash rolling hash with a scan for a run of monotonically increasing bytes. It is both faster and simpler code, and lands within 4% of FastCDC's dedup ratio.

It is not adopted on principle because its sequence length is a subtle parameter: getting it wrong collapses the dedup ratio silently rather than failing. If the measurement says cutting is under about a tenth of the total, record that SeqCDC was considered and rejected on evidence, and move on.

- [ ] **Step 6: Write it down**

`docs/benchmarks.md` gets a table per measurement, the hardware and link they were taken on, the date, and a conclusion per open question. Where a result contradicts the design's stated reasoning, say so in that file rather than quietly leaving the reasoning in place.

- [ ] **Step 7: Commit**

```bash
git add docs/benchmarks.md web/peer.js
git commit -m "docs: measured channel count, pool size and where transfer time goes"
```
