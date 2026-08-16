import test from 'node:test';
import assert from 'node:assert/strict';
import { bitmapOf, indexesFrom, makeWriter } from './staging.js';

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
