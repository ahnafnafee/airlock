import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadThroughServer } from './upload.js';
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
    async createTransfer(cids, to, serverHeld = false) {
      calls.created.push({ cids, to, held: serverHeld });
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
  const remembered = [];
  return {
    pool,
    remembered,
    opts: {
      openStage: stage.open,
      newPool: () => pool,
      rememberOutboundStage: async (transferId, stageId) => {
        remembered.push({ transferId, stageId });
      },
    },
  };
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

test('a held transfer is announced only after its chunks and records are ready', async () => {
  const api = fakeApi();
  const order = [];
  const putChunk = api.putChunk;
  const putRecord = api.putRecord;
  api.putChunk = async (...args) => {
    order.push('chunk');
    return putChunk(...args);
  };
  api.putRecord = async (id, kind, bytes) => {
    order.push(kind);
    return putRecord(id, kind, bytes);
  };

  await uploadThroughServer(fakeFile(pseudoRandom(20000)), {
    mk: await mkP, mode: MODE_SEALED, to: ['desktop'], cdc: CDC, api,
  });

  assert.ok(order.includes('chunk'), 'the fixture must upload at least one chunk');
  assert.deepEqual(order.slice(-2), ['chunklist', 'meta']);
  assert.equal(order.slice(0, -2).every((step) => step === 'chunk'), true);
});

test('a held upload rolls back its partial server transfer before reporting failure', async () => {
  const api = fakeApi();
  const original = new Error('the progress sink stopped');

  await assert.rejects(
    uploadThroughServer(fakeFile(pseudoRandom(20000, 37)), {
      mk: await mkP,
      mode: MODE_SEALED,
      to: ['desktop'],
      cdc: CDC,
      api,
      // The first report happens after createTransfer returned, so the server
      // already has a partial transfer for the rollback to remove.
      onProgress: () => { throw original; },
    }),
    (err) => err === original,
  );

  assert.equal(api.calls.created.length, 1, 'the transfer must exist, or this test asserts nothing');
  assert.deepEqual(api.calls.deleted, [TRANSFER]);
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

test('an empty file sends its sealed records without inventing a chunk', async () => {
  const api = fakeApi();
  const result = await uploadThroughServer(fakeFile(new Uint8Array(0), 'empty.txt'), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.deepEqual(api.calls.created[0].cids, []);
  assert.deepEqual(api.calls.chunks, []);
  assert.deepEqual(api.calls.records.map((x) => x.kind), ['chunklist', 'meta']);
  assert.equal(result.total, 0);
  assert.equal(result.sent, 0);
  assert.deepEqual(await sealedMeta(api), {
    name: 'empty.txt', size: 0, mime: 'application/octet-stream',
  });
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


// The strip is a row in file order, so a reader takes a segment's place as that
// chunk's place in the file. Reporting only counts made every re-send look like
// a change at the tail, whatever had actually changed, which is precisely the
// question a delta makes interesting.
test('a re-send reports where the held chunks are, not just how many', async () => {
  // Deterministic but non-repeating, so no two chunks share content and a
  // position is unambiguous.
  const bytes = new Uint8Array(4096);
  let x = 1;
  for (let i = 0; i < bytes.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; bytes[i] = x >>> 16; }
  const file = new File([bytes], 'delta.bin');
  const mk = await mkP;

  const first = fakeApi();
  await uploadThroughServer(file, { mk, mode: MODE_SEALED, cdc: CDC, api: first, onProgress() {} });
  const all = first.calls.chunks;
  assert.ok(all.length >= 3, `needs several chunks to place one, got ${all.length}`);
  assert.equal(new Set(all).size, all.length, 'the fixture must not repeat a chunk');

  // Every chunk held except one in the MIDDLE, which is the shape of an edit.
  const middle = Math.floor(all.length / 2);
  const held = new Set(all.filter((_, i) => i !== middle));
  const api = fakeApi(held);
  const reports = [];
  const r = await uploadThroughServer(file, {
    mk, mode: MODE_SEALED, cdc: CDC, api, onProgress: (p) => reports.push(p),
  });

  const expected = all.map((_, i) => i).filter((i) => i !== middle);
  assert.deepEqual(r.heldAt, expected, 'every position except the changed one should report as held');
  assert.deepEqual(reports.at(-1).storedAt, [middle],
    `the stored position should be the one that changed, got ${JSON.stringify(reports.at(-1).storedAt)}`);
});
