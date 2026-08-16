import test from 'node:test';
import assert from 'node:assert/strict';
import { WIRE, negotiate, receive } from './peer.js';

function pipePair() {
  const a = { sent: [], onmessage: null, bufferedAmount: 0, readyState: 'open' };
  const b = { sent: [], onmessage: null, bufferedAmount: 0, readyState: 'open' };
  a.send = (d) => { a.sent.push(d); queueMicrotask(() => b.onmessage?.({ data: d })); };
  b.send = (d) => { b.sent.push(d); queueMicrotask(() => a.onmessage?.({ data: d })); };
  a.addEventListener = () => {};
  b.addEventListener = () => {};
  return [a, b];
}

const MANIFEST = {
  name: 'holiday.jpg', size: 9, mime: 'image/jpeg',
  cids: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
  // The plaintext chunk hashes are the per-chunk key material the sending side
  // holds alongside the ids. They belong in the fixture so that a negotiate
  // which shipped the whole manifest would fail the no-key-material test rather
  // than pass it for want of anything to leak.
  hashes: ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
};
const bodies = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([7, 8, 9])];
const readChunk = (i) => bodies[i];

test('the receiver asks only for what it lacks', async () => {
  const [send, recv] = pipePair();
  const got = [];
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async (i) => i === 1, // already holds the middle chunk, as on a resend
    onChunk: async (i, bytes) => got.push([i, bytes]),
  });
  const result = await negotiate(send, MANIFEST, readChunk);
  await receiving;

  assert.equal(result.accepted, true);
  assert.equal(result.sent, 2);
  assert.equal(result.held, 1);
  assert.deepEqual(got.map(([i]) => i), [0, 2]);
  assert.deepEqual(got[0][1], bodies[0]);
});

test('a declined offer sends nothing', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: false, reason: 'not now' }),
    has: async () => false,
    onChunk: async () => assert.fail('a declined transfer must send nothing'),
  });
  const result = await negotiate(send, MANIFEST, readChunk);
  await receiving;

  assert.equal(result.accepted, false);
  assert.equal(result.sent, 0);
  assert.equal(result.reason, 'not now');
});

test('a receiver holding everything accepts and receives nothing', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => true,
    onChunk: async () => assert.fail('nothing should be sent'),
  });
  const result = await negotiate(send, MANIFEST, readChunk);
  await receiving;
  assert.equal(result.sent, 0);
  assert.equal(result.held, 3);
});

test('the offer carries no key material', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: false }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, MANIFEST, readChunk);
  await receiving;

  const offer = JSON.parse(send.sent[0]);
  assert.equal(offer.type, WIRE.OFFER);
  // Chunk hashes are the per-chunk key material. They travel only inside the
  // sealed chunk list, never in a control frame.
  assert.ok(!JSON.stringify(offer).includes('hash'));
});

test('each chunk frame is followed by exactly its body', async () => {
  const [send, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, MANIFEST, readChunk);
  await receiving;

  const kinds = send.sent.map((d) => (typeof d === 'string' ? JSON.parse(d).type : 'binary'));
  assert.deepEqual(kinds, [
    WIRE.OFFER,
    WIRE.CHUNK, 'binary',
    WIRE.CHUNK, 'binary',
    WIRE.CHUNK, 'binary',
    WIRE.DONE,
  ]);
});

test('a body arriving with no header is ignored', async () => {
  // A peer that sends a stray binary frame must not have it written under
  // whatever index happened to be pending.
  const [send, recv] = pipePair();
  let written = 0;
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => true,
    onChunk: async () => { written++; },
  });
  recv.onmessage?.({ data: new Uint8Array([9, 9, 9]) });
  await negotiate(send, MANIFEST, readChunk);
  await receiving;
  assert.equal(written, 0);
});

test('a body arriving after its chunk completes is ignored', async () => {
  // The other half of the same rule: the pending index is consumed by the first
  // body that follows it. A second stray body must not be written a second time
  // under the index that has already finished.
  const [, recv] = pipePair();
  const got = [];
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => { got.push([i, bytes]); },
  });
  const deliver = (data) => recv.onmessage({ data });
  await deliver(JSON.stringify({ type: WIRE.OFFER, ...MANIFEST }));
  await deliver(JSON.stringify({ type: WIRE.CHUNK, index: 0 }));
  await deliver(bodies[0]);
  await deliver(new Uint8Array([9, 9, 9]));
  await deliver(JSON.stringify({ type: WIRE.DONE }));
  await receiving;

  assert.deepEqual(got, [[0, bodies[0]]]);
});

// A real data channel delivers each message as its own task and never waits for
// the handler it called, so DONE can land while an onChunk write is still in
// flight. These two drive receive directly with that timing, which pipePair's
// microtask delivery hides.
function deliverInOrder(recv) {
  const deliver = (data) => { recv.onmessage({ data }); };
  deliver(JSON.stringify({ type: WIRE.OFFER, ...MANIFEST }));
  return new Promise((r) => setTimeout(r, 0)).then(() => {
    for (let i = 0; i < bodies.length; i++) {
      deliver(JSON.stringify({ type: WIRE.CHUNK, index: i }));
      deliver(bodies[i]);
    }
    deliver(JSON.stringify({ type: WIRE.DONE }));
  });
}

test('completion waits for every chunk write to land', async () => {
  const [, recv] = pipePair();
  const written = [];
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => {
      await new Promise((r) => setTimeout(r, 5));
      written.push([i, bytes]);
    },
  });
  await deliverInOrder(recv);
  const result = await receiving;

  assert.equal(result.accepted, true);
  assert.equal(result.received, bodies.length);
  assert.deepEqual(written, bodies.map((b, i) => [i, b]));
});

test('a chunk write that fails fails the transfer', async () => {
  // Resolving on DONE ahead of the writes would settle the promise first and
  // turn this rejection into a silent success.
  const [, recv] = pipePair();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i) => {
      await new Promise((r) => setTimeout(r, 5));
      if (i === 1) throw new Error('the store refused the chunk');
    },
  });
  await deliverInOrder(recv);

  await assert.rejects(receiving, /the store refused the chunk/);
});
