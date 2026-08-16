import test from 'node:test';
import assert from 'node:assert/strict';
import { upload } from './upload.js';
import { deriveMaster, MODE_SEALED, MODE_PLAIN, b64encode } from './crypto.js';

const CDC = { min: 64, normal: 128, max: 512, maskS: (1 << 9) - 1, maskL: (1 << 7) - 1 };
const mkP = deriveMaster('test passphrase', b64encode(new Uint8Array(16).fill(3)));

function fakeFile(bytes, name = 'f.bin', type = 'application/octet-stream') {
  return {
    name, type, size: bytes.length,
    stream() {
      let off = 0;
      return new ReadableStream({
        pull(c) {
          if (off >= bytes.length) { c.close(); return; }
          c.enqueue(bytes.subarray(off, off + 1000));
          off += 1000;
        },
      });
    },
  };
}

function fakeApi(held = new Set()) {
  const calls = { chunks: [], records: [], created: [] };
  return {
    calls,
    async createTransfer(cids, to) {
      calls.created.push({ cids, to });
      return { id: 'a'.repeat(32), missing: cids.filter((c) => !held.has(c)) };
    },
    async putRecord(id, kind, bytes) { calls.records.push({ kind, length: bytes.length }); },
    async putChunk(cid, transferId, bytes) {
      // The transfer id is not optional: the server refuses a chunk without it,
      // because that is what refreshes the transfer's inactivity clock.
      if (!/^[0-9a-f]{32}$/.test(transferId || '')) {
        throw new Error(`putChunk called without a transfer id: ${transferId}`);
      }
      calls.chunks.push(cid);
      held.add(cid);
    },
  };
}

function pseudoRandom(n, seed = 5) {
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

test('uploads every chunk the server lacks, and the two records', async () => {
  const api = fakeApi();
  const data = pseudoRandom(20000);
  const r = await upload(fakeFile(data), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.equal(api.calls.created.length, 1);
  assert.equal(api.calls.chunks.length, r.total);
  assert.equal(r.held, 0);
  assert.deepEqual(api.calls.records.map((x) => x.kind).sort(), ['chunklist', 'meta']);
});

test('a second upload of identical content sends no chunks at all', async () => {
  // This is dedup, delta sync and resume, all of which are the same mechanism.
  const held = new Set();
  const data = pseudoRandom(20000, 9);
  const first = fakeApi(held);
  const r1 = await upload(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: first });

  const second = fakeApi(held);
  const r2 = await upload(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: second });

  assert.equal(second.calls.chunks.length, 0, 'a duplicate upload must send nothing');
  assert.equal(r2.held, r1.total);
  assert.equal(r2.sent, 0);
});

test('an edited file re-sends only the chunks that changed', async () => {
  // The delta-sync property. Fixed-size chunking would re-send everything after
  // the edit.
  const held = new Set();
  const data = pseudoRandom(200000, 11);
  await upload(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: fakeApi(held) });

  const edited = new Uint8Array(data.length + 50);
  edited.set(data.subarray(0, 2000), 0);
  edited.set(pseudoRandom(50, 77), 2000);
  edited.set(data.subarray(2000), 2050);

  const second = fakeApi(held);
  const r = await upload(fakeFile(edited), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: second });
  assert.ok(r.sent < r.total * 0.2, `re-sent ${r.sent} of ${r.total} chunks after a 50-byte edit`);
});

test('progress reports held chunks before any upload starts', async () => {
  const held = new Set();
  const data = pseudoRandom(20000, 13);
  await upload(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: fakeApi(held) });

  // Append to the file so the second send has real work to do. A wholly held
  // file would make the ordering claim vacuous: there is no "before any upload
  // starts" when no upload ever starts.
  const grown = new Uint8Array(data.length + 3000);
  grown.set(data, 0);
  grown.set(pseudoRandom(3000, 31), data.length);

  const seen = [];
  const r = await upload(fakeFile(grown), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: fakeApi(held),
    onProgress: (p) => seen.push({ ...p }),
  });
  assert.ok(r.sent > 0, 'the appended bytes should have produced new chunks');
  assert.ok(seen.length > 0);
  assert.ok(seen[0].held > 0, 'the first progress report should already show dedup hits');
  assert.equal(seen[0].sent, 0, 'the first progress report must precede every upload');
});

test('a failed chunk upload is retried', async () => {
  let failures = 2;
  const api = fakeApi();
  const inner = api.putChunk;
  api.putChunk = async (cid, transferId, bytes) => {
    if (failures-- > 0) throw new Error('network');
    return inner(cid, transferId, bytes);
  };
  const r = await upload(fakeFile(pseudoRandom(20000, 17)), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.equal(r.sent, r.total, 'every chunk should land despite transient failures');
});

test('plaintext mode uploads unsealed bytes', async () => {
  const api = fakeApi();
  const r = await upload(fakeFile(pseudoRandom(5000, 19)), {
    mk: await mkP, mode: MODE_PLAIN, to: [], cdc: CDC, api,
  });
  assert.equal(r.sent, r.total);
});

test('an empty file still produces a transfer', async () => {
  const api = fakeApi();
  const r = await upload(fakeFile(new Uint8Array(0), 'empty.txt'), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.equal(r.total, 0);
  assert.deepEqual(api.calls.records.map((x) => x.kind).sort(), ['chunklist', 'meta']);
});

test('a file made of repeated chunks reports nothing held on its first send', async () => {
  // A file can contain the same chunk many times: an image of a disk, a padded
  // archive, anything mostly zeros. Deriving the hit count from the size of the
  // missing set would count those repeats as dedup hits on a file the server has
  // never seen, and the strip would go green on a first upload.
  const unit = pseudoRandom(4000, 23);
  const data = new Uint8Array(unit.length * 5);
  for (let i = 0; i < 5; i++) data.set(unit, i * unit.length);

  const api = fakeApi();
  const r = await upload(fakeFile(data), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.ok(new Set(api.calls.created[0].cids).size < r.total, 'the fixture must repeat chunks');
  assert.equal(r.held, 0, 'nothing was held: this is the first time the server sees this file');
  // The repeats are uploaded once, not once per occurrence.
  assert.equal(api.calls.chunks.length, new Set(api.calls.chunks).size);
});
