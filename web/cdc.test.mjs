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
