import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadThroughServer, queueForDelivery } from './upload.js';
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
  const calls = { chunks: [], records: [], created: [], deleted: [] };
  return {
    calls,
    async createTransfer(cids, to) {
      // The server refuses a transfer that names no chunks. The fake refuses it
      // too, so the suite can never go green on a request the real server would
      // reject.
      if (cids.length < 1) throw new Error('507: storage quota exceeded');
      calls.created.push({ cids, to });
      return { id: 'a'.repeat(32), missing: cids.filter((c) => !held.has(c)) };
    },
    async putRecord(id, kind, bytes) { calls.records.push({ kind, length: bytes.length }); },
    async deleteTransfer(id) { calls.deleted.push(id); },
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

// The direct path writes into this device's own staging area, keyed by the
// chunk's position in the transfer, which is the only key the peer protocol
// ever asks for.
// failAt makes one position's write reject, the way a dead staging worker or an
// exhausted origin quota does.
function fakeStage(failAt = -1) {
  const staged = new Map();
  const clears = [];
  return {
    staged,
    clears,
    async open() {
      return {
        put: async (index, bytes) => {
          if (index === failAt) throw new Error('the staging worker stopped');
          staged.set(index, bytes);
        },
        clear: async () => { clears.push(staged.size); staged.clear(); },
      };
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
  const r = await uploadThroughServer(fakeFile(data), {
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
  const r1 = await uploadThroughServer(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: first });

  const second = fakeApi(held);
  const r2 = await uploadThroughServer(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: second });

  assert.equal(second.calls.chunks.length, 0, 'a duplicate upload must send nothing');
  assert.equal(r2.held, r1.total);
  assert.equal(r2.sent, 0);
});

test('an edited file re-sends only the chunks that changed', async () => {
  // The delta-sync property. Fixed-size chunking would re-send everything after
  // the edit.
  const held = new Set();
  const data = pseudoRandom(200000, 11);
  await uploadThroughServer(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: fakeApi(held) });

  const edited = new Uint8Array(data.length + 50);
  edited.set(data.subarray(0, 2000), 0);
  edited.set(pseudoRandom(50, 77), 2000);
  edited.set(data.subarray(2000), 2050);

  const second = fakeApi(held);
  const r = await uploadThroughServer(fakeFile(edited), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: second });
  assert.ok(r.sent < r.total * 0.2, `re-sent ${r.sent} of ${r.total} chunks after a 50-byte edit`);
});

test('progress reports held chunks before any upload starts', async () => {
  const held = new Set();
  const data = pseudoRandom(20000, 13);
  await uploadThroughServer(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: fakeApi(held) });

  // Append to the file so the second send has real work to do. A wholly held
  // file would make the ordering claim vacuous: there is no "before any upload
  // starts" when no upload ever starts.
  const grown = new Uint8Array(data.length + 3000);
  grown.set(data, 0);
  grown.set(pseudoRandom(3000, 31), data.length);

  const seen = [];
  const r = await uploadThroughServer(fakeFile(grown), {
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
  const r = await uploadThroughServer(fakeFile(pseudoRandom(20000, 17)), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.equal(r.sent, r.total, 'every chunk should land despite transient failures');
});

test('plaintext mode uploads unsealed bytes', async () => {
  const api = fakeApi();
  const r = await uploadThroughServer(fakeFile(pseudoRandom(5000, 19)), {
    mk: await mkP, mode: MODE_PLAIN, to: [], cdc: CDC, api,
  });
  assert.equal(r.sent, r.total);
});

test('an empty file is refused, with the reason it was actually refused for', async () => {
  // The server will not create a transfer that names no chunks, and reports the
  // refusal as a storage quota failure. Sending one anyway would put "storage
  // quota exceeded" under a zero-byte file, which is untrue about every part of
  // the situation. The client refuses first and says why.
  const api = fakeApi();
  await assert.rejects(
    uploadThroughServer(fakeFile(new Uint8Array(0), 'empty.txt'), {
      mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
    }),
    /empty file/,
  );
  assert.equal(api.calls.created.length, 0, 'nothing should reach the server');
  assert.equal(api.calls.records.length, 0);
});

test('progress reports how many chunks are on the wire', async () => {
  // The strip paints that window amber, and amber means in transit and nothing
  // else. Without a real count the signature element either never shows the
  // sending state or guesses at it, and a guess can leave a segment pulsing
  // after the upload has finished.
  const seen = [];
  const r = await uploadThroughServer(fakeFile(pseudoRandom(20000, 29)), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: fakeApi(),
    onProgress: (p) => seen.push({ ...p }),
  });
  assert.ok(r.sent > 0);
  assert.ok(seen.some((p) => p.inflight > 0), 'some report must show work in flight');
  assert.ok(seen.every((p) => p.inflight <= 4), 'never more than the concurrency limit');
  assert.equal(seen.at(-1).inflight, 0, 'nothing may be left in flight at the end');
  assert.equal(seen.at(-1).sent, r.sent);
  assert.equal(r.inflight, 0);
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
  const r = await uploadThroughServer(fakeFile(data), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.ok(new Set(api.calls.created[0].cids).size < r.total, 'the fixture must repeat chunks');
  assert.equal(r.held, 0, 'nothing was held: this is the first time the server sees this file');
  // The repeats are uploaded once, not once per occurrence.
  assert.equal(api.calls.chunks.length, new Set(api.calls.chunks).size);
});

test('a queued transfer stages every chunk and sends the server none of them', async () => {
  // The whole point of the default path. The server learns what the transfer is
  // made of and gets the two sealed records the recipient needs to read it, and
  // not one byte of content.
  const api = fakeApi();
  const stage = fakeStage();
  const r = await queueForDelivery(fakeFile(pseudoRandom(20000, 41)), {
    mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api,
    openStage: stage.open,
  });
  assert.ok(r.total > 1, 'the fixture must produce several chunks');
  assert.equal(api.calls.created.length, 1);
  assert.deepEqual(api.calls.created[0].to, ['desktop']);
  assert.equal(api.calls.chunks.length, 0, 'no content may reach the server on this path');
  assert.deepEqual(api.calls.records.map((x) => x.kind).sort(), ['chunklist', 'meta']);
  assert.equal(r.held, 0, 'nothing is held: no recipient has been asked yet');
  assert.equal(r.sent, r.total);
  assert.deepEqual(
    [...stage.staged.keys()].sort((a, b) => a - b),
    [...Array(r.total).keys()],
    'every position in the transfer must have a staged chunk behind it');
});

test('a queued transfer stages a repeated chunk at every position it occupies', async () => {
  // The peer asks for chunk 7 of this transfer by position. Staging under the
  // chunk id instead, or claiming an id the way the server path does so it goes
  // up once, would leave the later positions with no file behind them and the
  // peer would ask for a chunk this device could not produce.
  const unit = pseudoRandom(4000, 23);
  const data = new Uint8Array(unit.length * 5);
  for (let i = 0; i < 5; i++) data.set(unit, i * unit.length);

  const api = fakeApi();
  const stage = fakeStage();
  const r = await queueForDelivery(fakeFile(data), {
    mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api,
    openStage: stage.open,
  });
  assert.ok(new Set(api.calls.created[0].cids).size < r.total, 'the fixture must repeat chunks');
  assert.equal(stage.staged.size, r.total);
});

test('a queued transfer stages chunks the server already holds', async () => {
  // The server is not the recipient. A chunk it kept from an earlier transfer
  // that was held on the server says nothing about what this device can hand to
  // a peer, so the missing set has no bearing on what is staged. Reading it here
  // would produce a queued transfer with holes in it that fails only later, on
  // the wire, against a device that asked for a position nothing answers.
  const held = new Set();
  const data = pseudoRandom(20000, 43);
  await uploadThroughServer(fakeFile(data), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: fakeApi(held),
  });

  const api = fakeApi(held);
  const stage = fakeStage();
  const r = await queueForDelivery(fakeFile(data), {
    mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api,
    openStage: stage.open,
  });
  assert.equal(
    api.calls.created[0].cids.filter((cid) => !held.has(cid)).length, 0,
    'the server must already hold every chunk, or this test asserts nothing');
  assert.equal(stage.staged.size, r.total);
});

test('a staging failure takes the transfer and the partial stage back down', async () => {
  // The transfer is created before the first chunk is staged, so a write that
  // fails part way leaves a transfer on the queue whose stage has holes in it.
  // Left alone, every later drain offers it, reaches a position with nothing
  // behind it, fails the session and cools the peer off, forever, and nothing
  // ever sweeps the chunks it did write. The failure has to undo both.
  const api = fakeApi();
  const stage = fakeStage(2);
  await assert.rejects(
    queueForDelivery(fakeFile(pseudoRandom(20000, 47)), {
      mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api,
      openStage: stage.open,
    }),
    // Rethrown as it was, so the caption names the reason the write failed
    // rather than the cleanup that followed it.
    /staging worker stopped/,
  );
  assert.equal(api.calls.created.length, 1, 'the transfer must have been created, or this test asserts nothing');
  assert.deepEqual(api.calls.deleted, ['a'.repeat(32)], 'the transfer must not stay on the queue');
  assert.deepEqual(stage.clears, [2], 'the two chunks that did land must be cleared');
  assert.equal(stage.staged.size, 0);
});

test('cleanup failing over a staging failure still reports the staging failure', async () => {
  // A device offline enough to fail a stage write is a device whose DELETE may
  // fail too. Neither best-effort step may replace the reason the send failed.
  const api = fakeApi();
  api.deleteTransfer = async () => { throw new Error('503: unreachable'); };
  const stage = fakeStage(1);
  await assert.rejects(
    queueForDelivery(fakeFile(pseudoRandom(20000, 53)), {
      mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api,
      openStage: stage.open,
    }),
    /staging worker stopped/,
  );
  assert.deepEqual(stage.clears, [1], 'the stage is still cleared when the delete fails');
});

test('a queued empty file is refused before the server hears about it', async () => {
  const api = fakeApi();
  const stage = fakeStage();
  await assert.rejects(
    queueForDelivery(fakeFile(new Uint8Array(0), 'empty.txt'), {
      mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api, openStage: stage.open,
    }),
    /empty file/,
  );
  assert.equal(api.calls.created.length, 0);
  assert.equal(stage.staged.size, 0);
});
