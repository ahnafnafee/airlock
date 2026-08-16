import test from 'node:test';
import assert from 'node:assert/strict';
import { poolSize, sealPool } from './sealpool.js';

// A fake worker that echoes back a deterministic "sealed" value after a delay,
// so ordering and concurrency are observable.
function fakeWorkerFactory(record) {
  return () => {
    const worker = {
      onmessage: null,
      postMessage(msg, transfer = []) {
        record.posted.push({ msg, transfer });
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

// A worker that answers only when a test tells it to, so a chunk can be held in
// flight or failed on purpose.
function manualWorkerFactory(record) {
  return () => {
    const worker = {
      onmessage: null,
      postMessage(msg, transfer = []) { record.posted.push({ msg, transfer }); },
      terminate() { record.terminated++; },
    };
    record.workers.push(worker);
    return worker;
  };
}

const fresh = () => ({ inFlight: 0, peak: 0, terminated: 0, posted: [], workers: [] });

test('the pool stops at the measured four-worker knee', () => {
  assert.equal(poolSize(2), 2);
  assert.equal(poolSize(64), 4);
  assert.equal(poolSize(null), 4);
});

test('results come back keyed by index regardless of completion order', async () => {
  const record = fresh();
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
  const record = fresh();
  const pool = sealPool(4, fakeWorkerFactory(record));
  await Promise.all(Array.from({ length: 8 }, (_, i) => pool.seal(i, new Uint8Array([5]))));
  assert.ok(record.peak > 1, `peak concurrency was ${record.peak}, so the pool is serial`);
  assert.ok(record.peak <= 4, `peak concurrency was ${record.peak}, above the pool size`);
  pool.close();
});

test('close terminates every worker', async () => {
  const record = fresh();
  const pool = sealPool(3, fakeWorkerFactory(record));
  await pool.seal(0, new Uint8Array([1]));
  pool.close();
  assert.equal(record.terminated, 3);
});

test('a chunk is handed over rather than copied', async () => {
  // Without the transfer list every chunk is duplicated on the way in, which is
  // a full extra copy of the file and appears in no profile line by name.
  const record = fresh();
  const pool = sealPool(2, manualWorkerFactory(record));

  const own = new Uint8Array([1, 2, 3]);
  const first = pool.seal(0, own);
  assert.deepEqual(record.posted[0].transfer, [own.buffer]);

  // A view onto a buffer somebody else still reads from is copied instead.
  // Chunks are cut from a sliding window, and detaching that window would empty
  // the chunker rather than cost a copy.
  const shared = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
  const second = pool.seal(1, shared);
  assert.deepEqual(record.posted[1].transfer, []);

  pool.close();
  await assert.rejects(first, /closed/);
  await assert.rejects(second, /closed/);
});

test('a chunk the worker could not seal rejects with the reason it gave', async () => {
  const record = fresh();
  const pool = sealPool(1, manualWorkerFactory(record));
  const sealing = pool.seal(0, new Uint8Array([1]));
  record.workers[0].onmessage({ data: { index: 0, error: 'the disk is full' } });
  await assert.rejects(sealing, /the disk is full/);
  pool.close();
});

test('closing settles a chunk that is still waiting for a worker', async () => {
  // A caller left waiting on a worker that is never coming is a preparation that
  // neither finishes nor fails, which is worse than one that fails: the transfer
  // hangs with a partial stage and nothing to say why.
  const record = fresh();
  const pool = sealPool(1, manualWorkerFactory(record));
  const first = pool.seal(0, new Uint8Array([1]));
  const queued = pool.seal(1, new Uint8Array([2]));
  await Promise.resolve();
  assert.equal(record.posted.length, 1, 'the second chunk must be waiting, not posted');

  pool.close();
  await assert.rejects(first, /closed/);
  await assert.rejects(queued, /closed/);
});

test('a spawn that fails part way terminates the workers it did make', () => {
  // Nothing else holds them, so they would run for the life of the page.
  const record = fresh();
  const make = manualWorkerFactory(record);
  let made = 0;
  assert.throws(
    () => sealPool(4, () => {
      if (made++ === 2) throw new Error('the worker did not load');
      return make();
    }),
    /did not load/,
  );
  assert.equal(record.terminated, 2, 'the two that were made must not be left running');
});

test('a worker that dies fails the chunk it was holding', async () => {
  // Nothing is retried: every chunk of this transfer is sealed by this pool, so
  // one that has lost a worker cannot finish the job it was made for, and
  // failing at once is what lets the caller take the partial stage back down.
  const record = fresh();
  const pool = sealPool(1, manualWorkerFactory(record));
  const sealing = pool.seal(0, new Uint8Array([1]));
  record.workers[0].onerror({});
  await assert.rejects(sealing, /seal worker stopped/);
  await assert.rejects(pool.seal(1, new Uint8Array([2])), /seal worker stopped/);
  pool.close();
});
