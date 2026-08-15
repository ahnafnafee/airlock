# Airlock Phase 1 Implementation Plan, part 3: chunking and crypto

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-15-airlock-part2.md`. Task numbering is unbroken and the **Global Constraints** in `2026-08-15-airlock.md` bind every task here.

**Spec:** `docs/superpowers/specs/2026-08-15-airlock-design.md`

These two modules are pure logic with no DOM and no network, which is why they are testable directly under Node. They are also where every subtle correctness property in the project lives, so their tests carry more weight than any others in the plan.

---

### Task 8: FastCDC content-defined chunking

**Files:**
- Create: `web/cdc.js`
- Create: `web/package.json`
- Test: `web/cdc.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces, from `web/cdc.js`:
  - `export function cutPoint(buf, start, end, params) -> number` (length of the chunk starting at `start`)
  - `export async function* chunkStream(stream, params)` yielding `Uint8Array` plaintext chunks
  - `export async function* chunkFile(file, params)` a convenience wrapper over `file.stream()`
  - `params` is `{min, normal, max, maskS, maskL}`, exactly the shape the server sends as `config.cdc`

**Why `web/package.json` exists:** it contains only `{"type":"module","private":true}`, which is what lets Node load these `.js` files as ES modules in tests. Nothing is ever installed from it and it is deliberately excluded from the Go embed list.

**The property that matters.** Fixed-size chunking defeats delta sync: inserting one byte at the front shifts every later boundary and invalidates every chunk. Content-defined boundaries re-synchronize within about one chunk of an edit. Test 4 is the only test that checks this, and it is the reason this module exists rather than a `for` loop over fixed offsets.

- [ ] **Step 1: Write the failing tests**

Create `web/cdc.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cutPoint, chunkStream } from './cdc.js';

// Small parameters so tests run fast. The shape matches the server's config.cdc.
const P = { min: 64, normal: 128, max: 512, maskS: (1 << 9) - 1, maskL: (1 << 7) - 1 };

// Seeded generator: tests must be reproducible, so no Math.random.
function pseudoRandom(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function streamOf(bytes, sliceSize = 997) {
  let off = 0;
  return new ReadableStream({
    pull(controller) {
      if (off >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(off, off + sliceSize));
      off += sliceSize;
    },
  });
}

async function chunksOf(bytes, sliceSize) {
  const out = [];
  for await (const c of chunkStream(streamOf(bytes, sliceSize), P)) out.push(c);
  return out;
}

const digest = (b) => createHash('sha256').update(b).digest('hex');

test('chunking is deterministic', async () => {
  const data = pseudoRandom(200000);
  const a = (await chunksOf(data)).map(digest);
  const b = (await chunksOf(data)).map(digest);
  assert.deepEqual(a, b);
});

test('chunking does not depend on how the stream is sliced', async () => {
  // Two devices reading the same file with different buffer sizes must produce
  // identical chunks, or dedup silently stops working between them.
  const data = pseudoRandom(200000, 7);
  const a = (await chunksOf(data, 997)).map(digest);
  const b = (await chunksOf(data, 65536)).map(digest);
  assert.deepEqual(a, b);
});

test('chunks reassemble to the original bytes', async () => {
  const data = pseudoRandom(200000, 11);
  const chunks = await chunksOf(data);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  assert.equal(total, data.length);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { joined.set(c, off); off += c.length; }
  assert.deepEqual(joined, data);
});

test('every chunk respects min and max except the last', async () => {
  const data = pseudoRandom(200000, 13);
  const chunks = await chunksOf(data);
  assert.ok(chunks.length > 20, `expected many chunks, got ${chunks.length}`);
  for (const c of chunks.slice(0, -1)) {
    assert.ok(c.length >= P.min, `chunk of ${c.length} is below min`);
    assert.ok(c.length <= P.max, `chunk of ${c.length} is above max`);
  }
});

test('an insertion near the front leaves most later chunks intact', async () => {
  // This is the delta-sync property and the whole reason for content-defined
  // boundaries. Fixed-size chunking would score near zero here.
  const data = pseudoRandom(400000, 17);
  const inserted = new Uint8Array(data.length + 100);
  inserted.set(data.subarray(0, 1000), 0);
  inserted.set(pseudoRandom(100, 999), 1000);
  inserted.set(data.subarray(1000), 1100);

  const before = new Set((await chunksOf(data)).map(digest));
  const after = (await chunksOf(inserted)).map(digest);
  const shared = after.filter((h) => before.has(h)).length;

  assert.ok(
    shared / after.length > 0.8,
    `only ${shared}/${after.length} chunks survived a 100-byte insertion`);
});

test('boundaries come from content, not from hitting the maximum', async () => {
  const data = pseudoRandom(200000, 23);
  const chunks = await chunksOf(data);
  const atMax = chunks.filter((c) => c.length === P.max).length;
  assert.ok(atMax < chunks.length / 2, `${atMax}/${chunks.length} chunks are exactly max`);
});

test('a stream shorter than the minimum yields one chunk', async () => {
  const chunks = await chunksOf(pseudoRandom(10, 29));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 10);
});

test('an empty stream yields no chunks', async () => {
  const chunks = await chunksOf(new Uint8Array(0));
  assert.equal(chunks.length, 0);
});

test('cutPoint never returns zero on a non-empty buffer', async () => {
  // A zero-length cut would spin the chunker forever.
  for (let seed = 1; seed < 40; seed++) {
    const buf = pseudoRandom(1000, seed);
    assert.ok(cutPoint(buf, 0, buf.length, P) > 0);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test web/cdc.test.mjs`
Expected: FAIL, cannot find module `./cdc.js`.

- [ ] **Step 3: Create `web/package.json`**

```json
{
  "type": "module",
  "private": true
}
```

- [ ] **Step 4: Write `web/cdc.js`**

```js
// Content-defined chunking, FastCDC style. Boundaries are chosen by the data
// rather than by offset, so inserting a byte near the front of a file
// invalidates only the chunks around the insertion instead of every chunk after
// it. That property is what makes delta sync work.

// A table of 256 pseudorandom 32-bit values, generated deterministically from a
// fixed seed rather than hardcoded. Every device must produce identical
// boundaries or dedup quietly stops working between them, with no error
// anywhere to notice.
const GEAR = (() => {
  const g = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    g[i] = x;
  }
  return g;
})();

// cutPoint returns the length of the chunk beginning at start. It never returns
// zero for a non-empty range, because a zero-length chunk would spin the caller
// forever.
export function cutPoint(buf, start, end, p) {
  let n = end - start;
  if (n <= p.min) return n;
  if (n > p.max) n = p.max;
  const normal = Math.min(p.normal, n);

  let fp = 0;
  let i = p.min;
  // Below the target size the stricter mask makes a cut unlikely, which is what
  // stops chunks from clustering at the minimum. Past it, the looser mask makes
  // one likely, which pulls the average toward the target.
  for (; i < normal; i++) {
    fp = ((fp << 1) + GEAR[buf[start + i]]) >>> 0;
    if ((fp & p.maskS) === 0) return i + 1;
  }
  for (; i < n; i++) {
    fp = ((fp << 1) + GEAR[buf[start + i]]) >>> 0;
    if ((fp & p.maskL) === 0) return i + 1;
  }
  return n;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// chunkStream yields plaintext chunks from a ReadableStream of Uint8Array. It
// holds at most one maximum-sized window plus the incoming slice, so a 20 GB
// file costs the same memory as a 20 MB one.
//
// The buffer is refilled to at least max before every cut, which is what makes
// the output independent of how the source stream happens to slice its reads.
// Cutting from a short buffer would produce different boundaries on a device
// with a different read size, and dedup between those two devices would fail.
export async function* chunkStream(stream, p) {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  let done = false;

  while (true) {
    while (!done && buf.length < p.max) {
      const r = await reader.read();
      if (r.done) { done = true; break; }
      buf = concat(buf, r.value);
    }
    if (buf.length === 0) return;

    const n = cutPoint(buf, 0, buf.length, p);
    yield buf.subarray(0, n);
    // slice rather than subarray: a view would keep the whole original buffer
    // alive and defeat the streaming property.
    buf = buf.slice(n);
    if (done && buf.length === 0) return;
  }
}

export function chunkFile(file, p) {
  return chunkStream(file.stream(), p);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test web/cdc.test.mjs`
Expected: PASS, nine tests. If the insertion-stability test fails, the chunker is not content-defined and delta sync will not work; do not proceed past it.

- [ ] **Step 6: Commit**

```bash
git add web/cdc.js web/cdc.test.mjs web/package.json
git commit -m "feat(web): content-defined chunking with insertion-stable boundaries"
```

---

### Task 9: Browser crypto, sealed and plaintext modes

**Files:**
- Create: `web/crypto.js`
- Test: `web/crypto.test.mjs`

**Interfaces:**
- Consumes: `web/package.json` from Task 8.
- Produces, from `web/crypto.js`:
  - `export const MODE_PLAIN = 0x00`, `export const MODE_SEALED = 0x01`
  - `export async function deriveMaster(passphrase, saltB64) -> CryptoKey` (an HKDF base key)
  - `export async function chunkIdentity(mk, mode, plain) -> {h, cid}` where `h` is a `Uint8Array(32)` and `cid` is 64 lowercase hex
  - `export async function sealChunk(mk, mode, h, cid, plain) -> Uint8Array`
  - `export async function openChunk(mk, mode, h, cid, sealed) -> Uint8Array`
  - `export async function sealRecord(mk, mode, domain, transferId, bytes) -> Uint8Array`
  - `export async function openRecord(mk, domain, transferId, record) -> Uint8Array`
  - `export async function makeCheck(mk) -> Uint8Array`, `export async function verifyCheck(mk, record) -> boolean`
  - `export function packHashes(hashes) -> Uint8Array`, `export function unpackHashes(bytes) -> Uint8Array[]`
  - `export function modeOf(record) -> number`
  - `export const DOMAIN = { META: 0x4d, LIST: 0x4c, THUMB: 0x54, CHECK: 0x4b }`
  - `export async function saveMaster(mk)`, `export async function loadMaster()`, `kvPut`, `kvGet`
  - `export function b64encode(bytes)`, `export function b64decode(str)`, `export function hex(bytes)`

**Two modes, one byte.** Every sealed record carries its mode as its first byte, so a receiver never has to be told which scheme was used and the server needs no extra field. In plaintext mode the sealing functions are the identity function and `cid` is the content hash directly. That mode exists because it was asked for; it trades the entire at-rest guarantee for a speedup that is expected to be unmeasurable, since AES-GCM reaches native code at gigabytes per second while a tailnet moves tens of megabytes per second. Do not remove it, and do not present it as free.

**Determinism is the dedup property and also the riskiest assumption here.** Chunk keys and IVs are derived from the plaintext's own hash, so the same bytes always produce the same ciphertext. That is what lets the server recognize a duplicate. It is safe only because a deterministic IV is reused solely with the key derived from the same plaintext, so a given key and IV pair can only ever encrypt one message. Tests 2 through 5 exist to hold that line.

- [ ] **Step 1: Write the failing tests**

Create `web/crypto.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_PLAIN, MODE_SEALED, DOMAIN,
  deriveMaster, chunkIdentity, sealChunk, openChunk,
  sealRecord, openRecord, makeCheck, verifyCheck,
  packHashes, unpackHashes, modeOf, b64encode, hex,
} from './crypto.js';

const SALT = b64encode(new Uint8Array(16).fill(7));
const OTHER_SALT = b64encode(new Uint8Array(16).fill(9));
const TID = 'a'.repeat(32);
const OTHER_TID = 'b'.repeat(32);
const enc = (s) => new TextEncoder().encode(s);

// Derived once: 600k PBKDF2 iterations are deliberately slow.
const mkP = deriveMaster('correct horse battery staple', SALT);
const wrongP = deriveMaster('hunter2', SALT);
const otherSaltP = deriveMaster('correct horse battery staple', OTHER_SALT);

test('the same plaintext always yields the same chunk id', async () => {
  // This is the dedup property. If it ever stops holding, dedup silently stops
  // working and every duplicate re-uploads.
  const mk = await mkP;
  const a = await chunkIdentity(mk, MODE_SEALED, enc('the same bytes'));
  const b = await chunkIdentity(mk, MODE_SEALED, enc('the same bytes'));
  assert.equal(a.cid, b.cid);
  assert.deepEqual(a.h, b.h);
  assert.match(a.cid, /^[0-9a-f]{64}$/);
});

test('different plaintext yields a different chunk id', async () => {
  const mk = await mkP;
  const seen = new Set();
  for (let i = 0; i < 64; i++) {
    const { cid } = await chunkIdentity(mk, MODE_SEALED, enc(`chunk number ${i}`));
    assert.ok(!seen.has(cid), `collision at ${i}`);
    seen.add(cid);
  }
});

test('a different master key yields a different id for the same plaintext', async () => {
  // This is the defense against confirmation of file contents. Plain convergent
  // encryption would let anyone who can hash the plaintext compute its id and
  // ask the server whether it is present.
  const a = await chunkIdentity(await mkP, MODE_SEALED, enc('secret document'));
  const b = await chunkIdentity(await otherSaltP, MODE_SEALED, enc('secret document'));
  assert.notEqual(a.cid, b.cid);
});

test('the same plaintext always yields the same ciphertext', async () => {
  const mk = await mkP;
  const plain = enc('deterministic please');
  const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
  const a = await sealChunk(mk, MODE_SEALED, h, cid, plain);
  const b = await sealChunk(mk, MODE_SEALED, h, cid, plain);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, plain);
});

test('sealed chunk round trip', async () => {
  const mk = await mkP;
  const plain = new Uint8Array([1, 2, 3, 4, 5]);
  const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
  const sealed = await sealChunk(mk, MODE_SEALED, h, cid, plain);
  assert.deepEqual(await openChunk(mk, MODE_SEALED, h, cid, sealed), plain);
});

test('plaintext mode passes bytes through and hashes directly', async () => {
  const mk = await mkP;
  const plain = enc('not a secret');
  const { h, cid } = await chunkIdentity(mk, MODE_PLAIN, plain);
  assert.equal(cid, hex(h), 'in plaintext mode the id is the content hash itself');
  const stored = await sealChunk(mk, MODE_PLAIN, h, cid, plain);
  assert.deepEqual(stored, plain);
  assert.deepEqual(await openChunk(mk, MODE_PLAIN, h, cid, stored), plain);
});

test('an empty chunk round trips in both modes', async () => {
  const mk = await mkP;
  for (const mode of [MODE_SEALED, MODE_PLAIN]) {
    const empty = new Uint8Array(0);
    const { h, cid } = await chunkIdentity(mk, mode, empty);
    const sealed = await sealChunk(mk, mode, h, cid, empty);
    assert.equal((await openChunk(mk, mode, h, cid, sealed)).length, 0);
  }
});

test('a chunk opened under the wrong id fails', async () => {
  const mk = await mkP;
  const plain = enc('bound to its id');
  const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
  const sealed = await sealChunk(mk, MODE_SEALED, h, cid, plain);
  const wrongCid = 'f'.repeat(64);
  await assert.rejects(async () => openChunk(mk, MODE_SEALED, h, wrongCid, sealed));
});

test('a corrupted chunk is rejected rather than returning garbage', async () => {
  const mk = await mkP;
  const plain = enc('tamper with me');
  const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
  const sealed = await sealChunk(mk, MODE_SEALED, h, cid, plain);
  sealed[sealed.length - 1] ^= 0xff;
  await assert.rejects(async () => openChunk(mk, MODE_SEALED, h, cid, sealed));
});

test('record round trip and mode byte', async () => {
  const mk = await mkP;
  const body = enc(JSON.stringify({ name: 'holiday photo.jpg', size: 12345 }));
  const sealed = await sealRecord(mk, MODE_SEALED, DOMAIN.META, TID, body);
  assert.equal(modeOf(sealed), MODE_SEALED);
  assert.deepEqual(await openRecord(mk, DOMAIN.META, TID, sealed), body);

  const plain = await sealRecord(mk, MODE_PLAIN, DOMAIN.META, TID, body);
  assert.equal(modeOf(plain), MODE_PLAIN);
  // The reader is never told which mode was used; it reads the byte.
  assert.deepEqual(await openRecord(mk, DOMAIN.META, TID, plain), body);
});

test('a record bound to one domain cannot be opened as another', async () => {
  const mk = await mkP;
  const sealed = await sealRecord(mk, MODE_SEALED, DOMAIN.META, TID, enc('x'));
  await assert.rejects(async () => openRecord(mk, DOMAIN.LIST, TID, sealed));
  await assert.rejects(async () => openRecord(mk, DOMAIN.THUMB, TID, sealed));
});

test('a record from one transfer cannot be spliced into another', async () => {
  const mk = await mkP;
  const sealed = await sealRecord(mk, MODE_SEALED, DOMAIN.LIST, TID, enc('chunk list'));
  await assert.rejects(async () => openRecord(mk, DOMAIN.LIST, OTHER_TID, sealed));
});

test('the check blob accepts the right passphrase and rejects the wrong one', async () => {
  const record = await makeCheck(await mkP);
  assert.equal(await verifyCheck(await mkP, record), true);
  assert.equal(await verifyCheck(await wrongP, record), false);
});

test('hash packing round trips', async () => {
  const hashes = [];
  for (let i = 0; i < 5; i++) hashes.push(new Uint8Array(32).fill(i));
  const packed = packHashes(hashes);
  assert.equal(packed.length, 160);
  assert.deepEqual(unpackHashes(packed), hashes);
});

test('unpacking a truncated hash list is refused', async () => {
  // A chunk list cut short would otherwise silently produce a short file.
  assert.throws(() => unpackHashes(new Uint8Array(33)));
});

test('a bad transfer id is refused before any crypto happens', async () => {
  const mk = await mkP;
  await assert.rejects(async () => sealRecord(mk, MODE_SEALED, DOMAIN.META, '../etc/passwd', enc('x')));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test web/crypto.test.mjs`
Expected: FAIL, cannot find module `./crypto.js`.

- [ ] **Step 3: Write `web/crypto.js`**

```js
// All encryption happens here, in the browser. The server holds ciphertext and
// nothing else. Node exposes the same Web Crypto API, so this module is tested
// directly with `node --test`.

const PBKDF2_ITERATIONS = 600000;
const IV_LEN = 12;
const TAG_LEN = 16;
const HASH_LEN = 32;
const CHECK_PLAINTEXT = 'airlock-v1';

export const MODE_PLAIN = 0x00;
export const MODE_SEALED = 0x01;

// Domain bytes keep the four kinds of sealed record from being substituted for
// each other.
export const DOMAIN = { META: 0x4d, LIST: 0x4c, THUMB: 0x54, CHECK: 0x4b };

const enc = (s) => new TextEncoder().encode(s);

export function b64encode(bytes) {
  // Built one character at a time on purpose: String.fromCharCode.apply blows
  // the stack on large arrays.
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(s, expectedLength) {
  if (!new RegExp(`^[0-9a-f]{${expectedLength * 2}}$`).test(s)) {
    throw new Error('malformed id');
  }
  const out = new Uint8Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function deriveMaster(passphrase, saltB64) {
  const base = await crypto.subtle.importKey(
    'raw', enc(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64decode(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, 256);
  // Imported non-extractable, so it can live in IndexedDB and be used by the
  // service worker without ever being readable by script.
  return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

function hkdfBits(mk, salt, info, byteLength) {
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc(info) }, mk, byteLength * 8)
    .then((b) => new Uint8Array(b));
}

function hkdfAesKey(mk, salt, info) {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc(info) }, mk,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// chunkIdentity computes the content hash and the server-facing id.
//
// In sealed mode the id mixes the master key in, so only passphrase holders can
// compute an id from a plaintext. Plain convergent encryption, where the id is
// just a hash of the content, would let anyone test whether the server holds a
// file they already have.
export async function chunkIdentity(mk, mode, plain) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', plain));
  if (mode === MODE_PLAIN) return { h, cid: hex(h) };
  return { h, cid: hex(await hkdfBits(mk, h, 'airlock-cid-v1', 32)) };
}

// sealChunk is deterministic by design: the key and the IV both derive from the
// plaintext's own hash, so identical bytes always produce identical ciphertext
// and the server can recognize a duplicate.
//
// A deterministic IV is safe only because of that derivation. GCM's nonce-reuse
// catastrophe needs one key and IV pair used on two different plaintexts, which
// cannot happen when the key itself is a function of the plaintext.
export async function sealChunk(mk, mode, h, cid, plain) {
  if (mode === MODE_PLAIN) return new Uint8Array(plain);
  const key = await hkdfAesKey(mk, h, 'airlock-key-v1');
  const iv = await hkdfBits(mk, h, 'airlock-iv-v1', IV_LEN);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: hexToBytes(cid, 32) }, key, plain);
  return new Uint8Array(ct);
}

export async function openChunk(mk, mode, h, cid, sealed) {
  if (mode === MODE_PLAIN) return new Uint8Array(sealed);
  const key = await hkdfAesKey(mk, h, 'airlock-key-v1');
  const iv = await hkdfBits(mk, h, 'airlock-iv-v1', IV_LEN);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: hexToBytes(cid, 32) }, key, sealed);
  return new Uint8Array(plain);
}

// The record key seals everything that is per transfer rather than per chunk.
// Records are not content-addressed, so they use random IVs.
const recordKey = (mk) => hkdfAesKey(mk, new Uint8Array(32), 'airlock-meta-v1');

function recordAAD(domain, transferId) {
  if (domain === DOMAIN.CHECK) return new Uint8Array([DOMAIN.CHECK]);
  const a = new Uint8Array(1 + 16);
  a[0] = domain;
  a.set(hexToBytes(transferId, 16), 1);
  return a;
}

export function modeOf(record) {
  return record[0];
}

// Records carry their mode in the first byte, so a reader never has to be told
// which scheme was used and the server needs no field for it.
export async function sealRecord(mk, mode, domain, transferId, bytes) {
  const aad = recordAAD(domain, transferId);
  if (mode === MODE_PLAIN) {
    const out = new Uint8Array(1 + bytes.length);
    out[0] = MODE_PLAIN;
    out.set(bytes, 1);
    return out;
  }
  const key = await recordKey(mk);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad }, key, bytes));
  const out = new Uint8Array(1 + IV_LEN + ct.length);
  out[0] = MODE_SEALED;
  out.set(iv, 1);
  out.set(ct, 1 + IV_LEN);
  return out;
}

export async function openRecord(mk, domain, transferId, record) {
  const b = record instanceof Uint8Array ? record : new Uint8Array(record);
  const aad = recordAAD(domain, transferId);
  if (b.length < 1) throw new Error('empty record');
  if (b[0] === MODE_PLAIN) return b.slice(1);
  if (b.length < 1 + IV_LEN + TAG_LEN) throw new Error('record too short');
  const key = await recordKey(mk);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b.subarray(1, 1 + IV_LEN), additionalData: aad },
    key, b.subarray(1 + IV_LEN));
  return new Uint8Array(plain);
}

export const makeCheck = (mk) =>
  sealRecord(mk, MODE_SEALED, DOMAIN.CHECK, null, enc(CHECK_PLAINTEXT));

export async function verifyCheck(mk, record) {
  try {
    const got = await openRecord(mk, DOMAIN.CHECK, null, record);
    return new TextDecoder().decode(got) === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

// The chunk list is raw concatenated hashes rather than JSON: 32 bytes per
// chunk instead of about 70, which matters at thousands of chunks per file.
export function packHashes(hashes) {
  const out = new Uint8Array(hashes.length * HASH_LEN);
  hashes.forEach((h, i) => out.set(h, i * HASH_LEN));
  return out;
}

export function unpackHashes(bytes) {
  if (bytes.length % HASH_LEN !== 0) {
    // A truncated list would otherwise silently produce a short file.
    throw new Error('chunk list is not a whole number of hashes');
  }
  const out = [];
  for (let i = 0; i < bytes.length; i += HASH_LEN) {
    out.push(bytes.slice(i, i + HASH_LEN));
  }
  return out;
}

// Key storage. IndexedDB is reachable from both the page and the service worker,
// which is what lets the worker decrypt downloads and notification metadata on
// its own.
const DB_NAME = 'airlock';
const STORE_NAME = 'kv';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvPut(k, v) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvGet(k) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(k);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const saveMaster = (mk) => kvPut('master', mk);
export const loadMaster = () => kvGet('master');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test web/crypto.test.mjs`
Expected: PASS, sixteen tests.

Four of them are the ones that matter. If "the same plaintext always yields the same chunk id" fails, dedup does not work. If "a different master key yields a different id" fails, the server can confirm which files you hold. If either domain-separation test passes decryption, records can be substituted for one another. Do not proceed past any of those.

- [ ] **Step 5: Commit**

```bash
git add web/crypto.js web/crypto.test.mjs
git commit -m "feat(web): convergent chunk sealing with domain-separated records"
```

---

Tasks 10 through 12, the application itself, are in
`docs/superpowers/plans/2026-08-15-airlock-part4.md`.
