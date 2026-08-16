import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadThroughServer, queueForDelivery } from './upload.js';
import {
  DOMAIN, chunkIdentity, openRecord, sealChunk, deriveMaster,
  MODE_SEALED, MODE_PLAIN, b64encode,
} from './crypto.js';

const CDC = { min: 64, normal: 128, max: 512, maskS: (1 << 9) - 1, maskL: (1 << 7) - 1 };
const mkP = deriveMaster('test passphrase', b64encode(new Uint8Array(16).fill(3)));
// The id the fake server hands back for every transfer it creates.
const TRANSFER = 'a'.repeat(32);

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
      return { id: TRANSFER, missing: cids.filter((c) => !held.has(c)) };
    },
    async putRecord(id, kind, bytes) { calls.records.push({ id, kind, bytes }); },
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
// failAt makes one position's write reject, the way a dead seal worker or an
// exhausted origin quota does.
function fakeStage(failAt = -1) {
  const staged = new Map();
  const clears = [];
  const keys = [];
  const put = async (index, bytes) => {
    if (index === failAt) throw new Error('the staging worker stopped');
    staged.set(index, bytes);
  };
  return {
    staged,
    clears,
    keys,
    put,
    async open(key) {
      keys.push(key);
      return {
        put,
        clear: async () => { clears.push(staged.size); staged.clear(); },
      };
    },
  };
}

// Stands in for the worker pool. The real one seals in a worker and writes the
// sealed bytes into staging from there, and neither a Worker nor an origin
// private file system exists here. What these tests hold to account is what
// reaches staging and in what shape, so this does the same work on this thread
// and against the same crypto.
function fakePool(stage, size = 4) {
  let mk = null;
  let mode = null;
  let inFlight = 0;
  // The real pool holds a caller with a chunk until a worker is free, which is
  // the backpressure that keeps the cutting thread from running away with the
  // whole file in memory. A fake without it would let this suite pass a
  // preparation that queues everything.
  const waiting = [];
  const pool = {
    size,
    peak: 0,
    closed: 0,
    async init(key, m) { mk = key; mode = m; },
    async seal(index, plain) {
      if (inFlight >= size) await new Promise((resolve) => waiting.push(resolve));
      inFlight++;
      pool.peak = Math.max(pool.peak, inFlight);
      try {
        const { h, cid } = await chunkIdentity(mk, mode, plain);
        const sealed = await sealChunk(mk, mode, h, cid, plain);
        // Closing the real pool terminates its workers, so nothing it was
        // holding reaches the stage afterwards. Without the same rule here a
        // chunk could land after the caller had already cleared up.
        if (pool.closed) throw new Error('the seal pool was closed');
        await stage.put(index, sealed);
        return { index, h, cid };
      } finally {
        inFlight--;
        waiting.shift()?.();
      }
    },
    close() { pool.closed++; },
  };
  return pool;
}

// The queued path's two injected collaborators, wired to each other. `opts` is
// what queueForDelivery is handed; `pool` is the same pool, for a test that
// wants to hold it to account.
function queued(stage, pool = fakePool(stage)) {
  return { pool, opts: { openStage: stage.open, newPool: () => pool } };
}

// The sealed metadata record, opened. It is the only description of the file
// that ever leaves this device, so it is where a claim about a name or a type
// surviving the send has to be settled.
async function sealedMeta(api) {
  const record = api.calls.records.find((x) => x.kind === 'meta');
  return JSON.parse(new TextDecoder().decode(
    await openRecord(await mkP, DOMAIN.META, TRANSFER, record.bytes)));
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
    mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api, ...queued(stage).opts,
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

test('the file is read once, and the chunks are sealed several at a time', async () => {
  // The two halves of this task. A second read of a file that may be twenty
  // gigabytes is the largest single cost there was, and sealing one chunk at a
  // time uses one core of however many the device has.
  const api = fakeApi();
  const stage = fakeStage();
  const data = pseudoRandom(20000, 61);
  let reads = 0;
  const file = fakeFile(data);
  const stream = file.stream.bind(file);
  file.stream = () => { reads++; return stream(); };

  const wiring = queued(stage);
  const r = await queueForDelivery(file, {
    mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api, ...wiring.opts,
  });
  assert.equal(reads, 1, 'the file must be opened exactly once');
  assert.ok(r.total > 4, 'the fixture must produce more chunks than the pool has workers');
  assert.ok(wiring.pool.peak > 1, `peak concurrency was ${wiring.pool.peak}, so sealing is serial`);
  assert.ok(
    wiring.pool.peak <= wiring.pool.size,
    `peak concurrency was ${wiring.pool.peak}, above the pool size`);
  assert.equal(wiring.pool.closed, 1, 'the pool must be closed when the pass ends');
});

test('the stage is named by the id the sealed metadata carries', async () => {
  // The chunks are staged before the transfer exists, so the directory cannot be
  // named by the transfer's id. Nothing else records where they went: a sender
  // that could not find them again would offer a transfer whose every position
  // answers with nothing.
  const api = fakeApi();
  const stage = fakeStage();
  await queueForDelivery(fakeFile(pseudoRandom(20000, 67)), {
    mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api, ...queued(stage).opts,
  });
  assert.equal(stage.keys.length, 1);
  assert.match(stage.keys[0], /^[0-9a-f]{32}$/, 'the stage id must be a well formed id');
  assert.notEqual(stage.keys[0], TRANSFER, 'the stage cannot be named by an id it predates');

  const meta = await sealedMeta(api);
  assert.equal(meta.stage, stage.keys[0]);
  assert.equal(meta.name, 'f.bin', 'the rest of the record must be unchanged');
});

test('a transfer sent through the server names no staging directory', async () => {
  // The field is where this device put the chunks. On the server path there are
  // no staged chunks, and a record naming a directory that does not exist would
  // send a later reader looking for one.
  const api = fakeApi();
  await uploadThroughServer(fakeFile(pseudoRandom(5000, 71)), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  const meta = await sealedMeta(api);
  assert.equal('stage' in meta, false);
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
    mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api, ...queued(stage).opts,
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
    mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api, ...queued(stage).opts,
  });
  assert.equal(
    api.calls.created[0].cids.filter((cid) => !held.has(cid)).length, 0,
    'the server must already hold every chunk, or this test asserts nothing');
  assert.equal(stage.staged.size, r.total);
});

test('a staging failure clears the partial stage and tells the server nothing', async () => {
  // The chunks are staged before the transfer is created, which is what makes a
  // failure part way through cheap to undo: no transfer sits on the queue with
  // holes in its stage, offered by every later drain and failing forever. What
  // is left is the chunks that did land, which nothing else would ever sweep.
  const api = fakeApi();
  const stage = fakeStage(2);
  const wiring = queued(stage);
  await assert.rejects(
    queueForDelivery(fakeFile(pseudoRandom(20000, 47)), {
      mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api, ...wiring.opts,
    }),
    // Rethrown as it was, so the caption names the reason the write failed
    // rather than the cleanup that followed it.
    /staging worker stopped/,
  );
  assert.equal(api.calls.created.length, 0, 'the server must never hear about it');
  assert.deepEqual(api.calls.deleted, []);
  assert.equal(stage.clears.length, 1, 'the chunks that did land must be cleared');
  assert.equal(stage.staged.size, 0);
  assert.equal(wiring.pool.closed, 1, 'a failed pass must still close the pool');
});

test('a transfer the server refuses leaves nothing staged behind it', async () => {
  // Everything is on disk by the time the server is asked, so a refusal here is
  // a stage with no transfer to read it. Nothing else sweeps one.
  const api = fakeApi();
  api.createTransfer = async () => { throw new Error('507: storage quota exceeded'); };
  const stage = fakeStage();
  await assert.rejects(
    queueForDelivery(fakeFile(pseudoRandom(20000, 51)), {
      mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api, ...queued(stage).opts,
    }),
    /storage quota/,
  );
  assert.equal(stage.clears.length, 1);
  assert.equal(stage.staged.size, 0);
});

test('cleanup failing over a record failure still reports the record failure', async () => {
  // A device offline enough to fail a record write is a device whose DELETE may
  // fail too. Neither best-effort step may replace the reason the send failed.
  const api = fakeApi();
  api.putRecord = async () => { throw new Error('503: unreachable'); };
  api.deleteTransfer = async () => { throw new Error('503: unreachable'); };
  const stage = fakeStage();
  await assert.rejects(
    queueForDelivery(fakeFile(pseudoRandom(20000, 53)), {
      mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api, ...queued(stage).opts,
    }),
    /unreachable/,
  );
  assert.equal(api.calls.created.length, 1, 'the transfer must exist, or this test asserts nothing');
  assert.equal(stage.clears.length, 1, 'the stage is still cleared when the delete fails');
  assert.equal(stage.staged.size, 0);
});

test('a file with no extension and no detected type transfers', async () => {
  // Common for archives, disk images, and anything from a unix machine. The
  // browser reports an empty type and there is nothing to infer from the name.
  const api = fakeApi();
  const file = fakeFile(pseudoRandom(9000, 31), 'Makefile', '');
  const r = await uploadThroughServer(file, {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.ok(r.total > 0);
  assert.equal(r.sent, r.total);

  const meta = await sealedMeta(api);
  assert.equal(meta.name, 'Makefile');
  // An empty type reaches the other side as a blob with no type at all, which
  // is a worse answer than the honest one for bytes nothing could identify.
  assert.equal(meta.mime, 'application/octet-stream');
});

test('unusual names and types reach the sealed metadata unchanged', async () => {
  // Nothing between the picker and the record may normalize, transliterate or
  // percent-encode a name. The record is the only description of the file that
  // ever leaves this device, so whatever it says is what the recipient saves.
  for (const [name, type] of [
    ['日本語のファイル.txt', 'text/plain'],
    ['🎉 party.gif', 'image/gif'],
    ['a.b.c.d.tar.zst', 'application/zstd'],
    ["it's a file, isn't it.bin", ''],
    ['.hidden', ''],
    // Reserved on Windows and a filename anywhere else. Renaming it would be
    // the wrong layer: the browser writing the file is what knows the rules of
    // the disk it is writing to.
    ['CON', ''],
    ['x'.repeat(200) + '.dat', 'application/octet-stream'],
  ]) {
    const api = fakeApi();
    const r = await uploadThroughServer(fakeFile(pseudoRandom(3000, 7), name, type), {
      mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
    });
    assert.ok(r.total > 0, `no chunks for ${name}`);
    assert.equal(r.sent, r.total, `not everything sent for ${name}`);

    const meta = await sealedMeta(api);
    assert.equal(meta.name, name, `the name was altered for ${name}`);
    assert.equal(meta.mime, type || 'application/octet-stream', `the type was altered for ${name}`);
  }
});

test('a queued empty file is refused before the server hears about it', async () => {
  const api = fakeApi();
  const stage = fakeStage();
  await assert.rejects(
    queueForDelivery(fakeFile(new Uint8Array(0), 'empty.txt'), {
      mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api, ...queued(stage).opts,
    }),
    /empty file/,
  );
  assert.equal(api.calls.created.length, 0);
  assert.equal(stage.staged.size, 0);
});
