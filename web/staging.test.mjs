import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bitmapOf, indexesFrom, makeStageOpener, makeWriter, openStage,
  reconcileReceiverStages, stageDir, writeStaged,
} from './staging.js';

// A stand-in for the dedicated worker. Nothing here writes to disk: what these
// tests hold to account is the message protocol, since a reply matched to the
// wrong write or a death that settles nothing is a transfer that hangs.
function fakeWorker() {
  const handlers = {};
  const posted = [];
  return {
    posted,
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    postMessage(message, transfer = []) { posted.push({ message, transfer }); },
    reply(data) { for (const fn of handlers.message || []) fn({ data }); },
    die() { for (const fn of handlers.error || []) fn({}); },
  };
}

const settled = (promise) => {
  const state = { done: false, error: null };
  promise.then(() => { state.done = true; }, (err) => { state.error = err; });
  return state;
};

// Two turns, because a reply resolves a promise whose continuation runs on the
// microtask queue rather than in the call that delivered it.
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('a write resolves on its own ticket, not on whichever reply arrives first', async () => {
  const worker = fakeWorker();
  const write = makeWriter(() => worker);

  const first = settled(write('a'.repeat(32), 0, new Uint8Array([1])));
  const second = settled(write('a'.repeat(32), 1, new Uint8Array([2])));
  const tickets = worker.posted.map((p) => p.message.ticket);
  assert.equal(new Set(tickets).size, 2);

  worker.reply({ ticket: tickets[1] });
  await turn();
  assert.equal(second.done, true);
  assert.equal(first.done, false);

  worker.reply({ ticket: tickets[0] });
  await turn();
  assert.equal(first.done, true);
});

test('a failed write rejects with the reason the worker gave', async () => {
  const worker = fakeWorker();
  const write = makeWriter(() => worker);
  const put = write('b'.repeat(32), 3, new Uint8Array([9]));
  worker.reply({ ticket: worker.posted[0].message.ticket, error: 'the disk is full' });
  await assert.rejects(put, /the disk is full/);
});

test('a quota failure is still recognizable as one after crossing the worker', async () => {
  // A DOMException is not clonable everywhere, so the reason and the name travel
  // as strings and the name is put back on this side. The session drops a
  // partial stage on the strength of that name, and it cannot fall back to
  // matching the message: every engine words this one differently.
  const worker = fakeWorker();
  const write = makeWriter(() => worker);
  const put = write('f'.repeat(32), 0, new Uint8Array([1]));
  worker.reply({
    ticket: worker.posted[0].message.ticket,
    error: 'The quota has been exceeded.',
    name: 'QuotaExceededError',
  });
  await assert.rejects(put, (err) => err.name === 'QuotaExceededError');
});

test('a failure the worker did not name stays an ordinary error', async () => {
  const worker = fakeWorker();
  const write = makeWriter(() => worker);
  const put = write('g'.repeat(32), 0, new Uint8Array([1]));
  worker.reply({ ticket: worker.posted[0].message.ticket, error: 'the handle would not open' });
  await assert.rejects(put, (err) => err.name === 'Error' && /handle would not open/.test(err.message));
});

test('a worker that dies fails every write waiting on it', async () => {
  // A write left waiting on a reply that is never coming is a session that
  // neither finishes nor records progress, which is worse than a failed one.
  let spawned = 0;
  let worker = null;
  const write = makeWriter(() => { spawned++; worker = fakeWorker(); return worker; });

  const first = write('c'.repeat(32), 0, new Uint8Array([1]));
  const second = write('c'.repeat(32), 1, new Uint8Array([2]));
  const dying = worker;
  dying.die();
  await assert.rejects(first, /the staging worker stopped/);
  await assert.rejects(second, /the staging worker stopped/);

  // And the next write gets a fresh worker rather than queueing behind a dead
  // one, so one lost worker does not end writing for the life of the page.
  const third = settled(write('c'.repeat(32), 2, new Uint8Array([3])));
  assert.equal(spawned, 2);
  worker.reply({ ticket: worker.posted[0].message.ticket });
  await turn();
  assert.equal(third.done, true);

  // A late reply from the worker that died lands on a ticket nobody holds. It
  // must be ignored rather than resolving somebody else's write.
  dying.reply({ ticket: 1 });
  await turn();
});

test('a chunk is handed over rather than copied', async () => {
  const worker = fakeWorker();
  const write = makeWriter(() => worker);

  const own = new Uint8Array([1, 2, 3]);
  write('d'.repeat(32), 0, own);
  assert.deepEqual(worker.posted[0].transfer, [own.buffer]);

  // A view onto a buffer somebody else also reads from is copied instead:
  // transferring it would detach the buffer and empty the other view.
  const shared = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
  write('d'.repeat(32), 1, shared);
  assert.deepEqual(worker.posted[1].transfer, []);
});

test('one worker serves every write', () => {
  // Spawning per write would open a handle race between two workers writing the
  // same file, and would pay a worker startup for every chunk.
  let spawned = 0;
  const worker = fakeWorker();
  const write = makeWriter(() => { spawned++; return worker; });
  write('e'.repeat(32), 0, new Uint8Array([1]));
  write('e'.repeat(32), 1, new Uint8Array([2]));
  assert.equal(spawned, 1);
});

// A stand-in for the origin private file system, holding just the parts of it
// staging.js touches: directories, files, the sync access handle a write goes
// through, and a name listing.
function fakeStorage() {
  // File names whose write stops after one byte, which is the state a closed
  // tab, a sleeping device or a killed process leaves a chunk in.
  const halt = new Set();

  const missing = (name) => {
    const err = new Error(`no entry named ${name}`);
    err.name = 'NotFoundError';
    return err;
  };

  function fakeFile(name) {
    let bytes = new Uint8Array(0);
    return {
      async createSyncAccessHandle() {
        return {
          write(src, { at = 0 } = {}) {
            const cut = halt.has(name) ? Math.min(1, src.byteLength) : src.byteLength;
            const grown = new Uint8Array(Math.max(bytes.length, at + cut));
            grown.set(bytes);
            grown.set(src.subarray(0, cut), at);
            bytes = grown;
            if (halt.has(name)) throw new Error('the write stopped');
            return cut;
          },
          truncate(size) { bytes = bytes.slice(0, size); },
          flush() {},
          close() {},
        };
      },
      async getFile() {
        const copy = bytes.slice();
        return { size: copy.length, async arrayBuffer() { return copy.buffer; } };
      },
    };
  }

  function fakeDir() {
    const entries = new Map();
    return {
      async getDirectoryHandle(name, { create = false } = {}) {
        const found = entries.get(name);
        if (found) return found;
        if (!create) throw missing(name);
        const made = fakeDir();
        entries.set(name, made);
        return made;
      },
      async getFileHandle(name, { create = false } = {}) {
        const found = entries.get(name);
        if (found) return found;
        if (!create) throw missing(name);
        const made = fakeFile(name);
        entries.set(name, made);
        return made;
      },
      async removeEntry(name) {
        if (!entries.delete(name)) throw missing(name);
      },
      async *keys() { yield* [...entries.keys()]; },
    };
  }

  return { halt, root: fakeDir() };
}

// staging.js resolves the file system through navigator.storage on every call
// rather than holding it, so installing the fake here reaches every path to disk.
function onDisk() {
  const disk = fakeStorage();
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { getDirectory: async () => disk.root } },
    configurable: true,
  });
  return disk;
}

const STAGE = '0'.repeat(32);
const OTHER_STAGE = '1'.repeat(32);
const ACTIVE_STAGE = '2'.repeat(32);
const CID_A = 'a'.repeat(64);
const CID_B = 'b'.repeat(64);
const CID_C = 'c'.repeat(64);

test('a later transfer can own and read a chunk cached by CID in an earlier transfer', async () => {
  onDisk();
  const open = makeStageOpener(writeStaged);
  const earlier = await open(STAGE, [CID_A, CID_B]);
  await earlier.put(1, new Uint8Array([4, 5, 6]));

  // A new opener stands in for a page reload: the lookup comes from the
  // persisted manifest and not an in-memory map left by the first transfer.
  const afterReload = makeStageOpener(writeStaged);
  const later = await afterReload(OTHER_STAGE, [CID_B, CID_C]);
  assert.equal(await later.has(0), true);
  assert.deepEqual([...await later.get(0)], [4, 5, 6]);
  assert.equal(await later.has(1), false, 'a different CID must still be requested');

  // Reuse gives the later transfer its own position. Clearing the earlier
  // owner must not make a transfer that already answered "held" unassemblable.
  await earlier.clear();
  assert.deepEqual([...await later.get(0)], [4, 5, 6]);
});

test('inbox reconciliation removes only terminal receiver stages', async () => {
  const disk = onDisk();
  const open = makeStageOpener(writeStaged);
  const staleReceiver = await open(STAGE, [CID_A]);
  const activeReceiver = await open(ACTIVE_STAGE, [CID_B]);
  const outbound = await open(OTHER_STAGE);
  await staleReceiver.put(0, new Uint8Array([1]));
  await activeReceiver.put(0, new Uint8Array([2]));
  await outbound.put(0, new Uint8Array([3]));

  assert.deepEqual(await reconcileReceiverStages(new Set([ACTIVE_STAGE])), [STAGE]);
  const staging = await disk.root.getDirectoryHandle('staging');
  const names = [];
  for await (const name of staging.keys()) names.push(name);
  assert.deepEqual(names.sort(), [ACTIVE_STAGE, OTHER_STAGE].sort());
  assert.deepEqual([...await activeReceiver.get(0)], [2]);
  assert.deepEqual([...await outbound.get(0)], [3]);
});

test('an interrupted write leaves nothing that reports as staged', async () => {
  // The whole point. A chunk file exists from the moment a write starts, so if
  // presence meant existence, a write cut short would be counted as delivered,
  // the progress bitmap would claim the chunk arrived, and the sender would be
  // told it may stop holding the only other copy.
  const disk = onDisk();
  const stage = await openStage(STAGE);
  disk.halt.add('4');

  await assert.rejects(writeStaged(STAGE, 4, new Uint8Array([1, 2, 3])), /the write stopped/);

  // The short file really is on disk. Nothing below is reading an absence.
  const dir = await stageDir(STAGE);
  assert.equal((await (await dir.getFileHandle('4')).getFile()).size, 1);

  assert.equal(await stage.has(4), false);
  assert.deepEqual([...await stage.held()], []);
  assert.deepEqual([...await stage.bitmap(8)], [0]);
  await assert.rejects(stage.get(4), /not staged/);
});

test('a completed write is reported as staged straight away', async () => {
  onDisk();
  const stage = await openStage(STAGE);
  await writeStaged(STAGE, 4, new Uint8Array([1, 2, 3]));

  assert.equal(await stage.has(4), true);
  assert.deepEqual([...await stage.held()], [4]);
  assert.deepEqual([...await stage.bitmap(8)], [0b10000]);
  assert.deepEqual([...await stage.get(4)], [1, 2, 3]);
});

test('an index written again after an interrupted write is held once it lands', async () => {
  // Refusing the short chunk is only half of it. The index has to become held
  // when the chunk is asked for again, or a resume could never finish.
  const disk = onDisk();
  const stage = await openStage(STAGE);

  disk.halt.add('4');
  await assert.rejects(writeStaged(STAGE, 4, new Uint8Array([1, 2, 3])));
  disk.halt.delete('4');
  await writeStaged(STAGE, 4, new Uint8Array([1, 2, 3]));

  assert.equal(await stage.has(4), true);
  assert.deepEqual([...await stage.get(4)], [1, 2, 3]);
});

test('a chunk left unfinished by an earlier session is not held', async () => {
  // The same state as an interrupted write, arrived at without one, because
  // this is what a device that died between the bytes and the commit leaves.
  onDisk();
  const stage = await openStage(STAGE);
  const dir = await stageDir(STAGE);
  const handle = await dir.getFileHandle('9', { create: true });
  const access = await handle.createSyncAccessHandle();
  access.write(new Uint8Array([1, 2, 3]), { at: 0 });
  access.close();
  await dir.getFileHandle('9.part', { create: true });

  assert.equal(await stage.has(9), false);
  assert.deepEqual([...await stage.held()], []);
});

test('only a bare position counts as a chunk', async () => {
  // Number() would read these as 16, 1000, 5, 7 and 8, so a name that is not
  // the one String(index) produces would invent chunks this device never took.
  onDisk();
  const stage = await openStage(STAGE);
  await writeStaged(STAGE, 5, new Uint8Array([1]));

  const dir = await stageDir(STAGE);
  for (const name of ['0x10', '1e3', '+5', '007', ' 8', '2.part']) {
    await dir.getFileHandle(name, { create: true });
  }

  assert.deepEqual([...await stage.held()], [5]);
  assert.deepEqual([...await stage.bitmap(16)], [0b100000, 0]);
});

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

test('an index outside the chunk count sets no bit', () => {
  // The mirror of the case above, on the writing side. Index 9 of a 9-chunk
  // transfer lands in the final byte's spare bits, which is in range of the
  // array and so would be written silently without the bound.
  assert.deepEqual([...bitmapOf(new Set([9]), 9)], [0, 0]);
  assert.deepEqual([...bitmapOf(new Set([-1, 0]), 9)], [0b1, 0]);
});
