import test from 'node:test';
import assert from 'node:assert/strict';
import { WIRE, FRAGMENT, LINK_COUNT, linkCountFor, negotiate, receive,
  peerToPeerAvailable,
  newConnection,
} from './peer.js';

// The transport refuses a message larger than the connection's negotiated
// maximum, and 64 KiB is the safe interop figure. The fake enforces it by
// throwing, because a fake that quietly accepted an 8 MiB message would let
// every test here pass while the product could not send a single chunk.
const MAX_MESSAGE = 64 << 10;

function linkPool(links, channelsPerLink) {
  const send = [];
  const recv = [];
  for (let l = 0; l < links; l++) {
    const a = { channels: [] };
    const b = { channels: [] };
    for (let c = 0; c < channelsPerLink; c++) {
      const x = { sent: [], onmessage: null, bufferedAmount: 0, readyState: 'open' };
      const y = { sent: [], onmessage: null, bufferedAmount: 0, readyState: 'open' };
      const wire = (from, to) => (d) => {
        const size = typeof d === 'string' ? d.length : d.byteLength;
        if (size > MAX_MESSAGE) throw new Error(`message of ${size} exceeds maxMessageSize`);
        from.sent.push(d);
        queueMicrotask(() => to.onmessage?.({ data: d }));
      };
      x.send = wire(x, y);
      y.send = wire(y, x);
      x.addEventListener = () => {};
      y.addEventListener = () => {};
      a.channels.push(x);
      b.channels.push(y);
    }
    send.push(a);
    recv.push(b);
  }
  return [send, recv];
}

// The wire format of a fragment, restated here on purpose: this is the
// assertion, so a change to the header in peer.js fails these tests rather than
// passing whatever it now writes.
const HEADER = 12;
function fragment(index, offset, total, payload) {
  const message = new Uint8Array(HEADER + payload.length);
  const view = new DataView(message.buffer);
  view.setUint32(0, index);
  view.setUint32(4, offset);
  view.setUint32(8, total);
  message.set(payload, HEADER);
  return message;
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

function bigManifest(count, chunkSize) {
  return {
    name: 'big.bin', size: count * chunkSize, mime: '',
    cids: Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, '0')),
  };
}

const kindsOf = (channel) => channel.sent.map((d) => (typeof d === 'string' ? JSON.parse(d).type : 'binary'));

test('the receiver asks only for what it lacks', async () => {
  const [send, recv] = linkPool(1, 1);
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
  const [send, recv] = linkPool(2, 2);
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
  // A decision, so the sender is right to record it as final.
  assert.equal(result.retryable, false);
});

test('a refusal marked retryable arrives as one, and only when it was marked', async () => {
  // The sender treats the two oppositely: a decision is never re-offered, and a
  // condition of the moment has to be. The marker is what separates them, so it
  // has to survive the wire rather than being inferred from the reason text.
  for (const [retryable, expected] of [[true, true], [false, false], [undefined, false]]) {
    const [send, recv] = linkPool(1, 1);
    const receiving = receive(recv, {
      onOffer: async () => ({ accept: false, reason: 'no room', retryable }),
      has: async () => false,
      onChunk: async () => assert.fail('a declined transfer must send nothing'),
    });
    const result = await negotiate(send, MANIFEST, readChunk);
    await receiving;
    assert.equal(result.retryable, expected, `retryable ${retryable}`);
    assert.equal(result.reason, 'no room');
  }
});

test('a receiver holding everything accepts and receives nothing', async () => {
  const [send, recv] = linkPool(2, 2);
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => true,
    onChunk: async () => assert.fail('nothing should be sent'),
  });
  const result = await negotiate(send, MANIFEST, readChunk);
  const received = await receiving;
  assert.equal(result.sent, 0);
  assert.equal(result.held, 3);
  // DONE naming a count of zero is what ends a transfer with nothing in it.
  assert.equal(received.received, 0);
});

test('an empty file completes without asking either side for a chunk', async () => {
  const [send, recv] = linkPool(1, 1);
  const manifest = { name: 'empty.txt', size: 0, mime: 'text/plain', cids: [] };
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => assert.fail('an empty file has no chunk to look up'),
    onChunk: async () => assert.fail('an empty file has no chunk to receive'),
  });
  const result = await negotiate(send, manifest, () => {
    assert.fail('an empty file has no chunk to read');
  });
  const received = await receiving;

  assert.deepEqual(result, { accepted: true, sent: 0, held: 0 });
  assert.deepEqual(received, { accepted: true, received: 0 });
});

test('the offer carries no key material', async () => {
  const [send, recv] = linkPool(1, 1);
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: false }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, MANIFEST, readChunk);
  await receiving;

  const offer = JSON.parse(send[0].channels[0].sent[0]);
  assert.equal(offer.type, WIRE.OFFER);
  // Chunk hashes are the per-chunk key material. They travel only inside the
  // sealed chunk list, never in a control frame.
  assert.ok(!JSON.stringify(offer).includes('hash'));
});

test('a chunk that fits in one fragment travels as one message', async () => {
  const [send, recv] = linkPool(1, 1);
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, MANIFEST, readChunk);
  await receiving;

  assert.deepEqual(kindsOf(send[0].channels[0]), [
    WIRE.OFFER, 'binary', 'binary', 'binary', WIRE.DONE,
  ]);
});

test('a chunk larger than the message limit is fragmented and reassembled', async () => {
  // The regression test for the bug that made this task necessary.
  const [send, recv] = linkPool(2, 2);
  const chunkSize = 200 << 10; // well over the 64 KiB limit
  const manifest = bigManifest(3, chunkSize);
  const body = (i) => new Uint8Array(chunkSize).fill(i + 1);

  const got = new Map();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => got.set(i, bytes),
  });
  const result = await negotiate(send, manifest, (i) => body(i));
  await receiving;

  assert.equal(result.sent, 3);
  assert.equal(got.size, 3);
  for (const [i, bytes] of got) {
    assert.equal(bytes.length, chunkSize, `chunk ${i} came back the wrong length`);
    assert.deepEqual(bytes, body(i));
  }
  // Every wire message respected the limit, which the fake enforces by throwing.
  for (const link of send) {
    for (const channel of link.channels) {
      for (const message of channel.sent) {
        const size = typeof message === 'string' ? message.length : message.byteLength;
        assert.ok(size <= MAX_MESSAGE);
      }
    }
  }
});

test('one chunk is spread across every channel of its link', async () => {
  // Head-of-line blocking is the reason a link has more than one channel, and it
  // only helps if a chunk's fragments actually use both.
  const [send, recv] = linkPool(1, 2);
  const chunkSize = 4 * FRAGMENT;
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, bigManifest(1, chunkSize), () => new Uint8Array(chunkSize).fill(7));
  await receiving;

  for (const [c, channel] of send[0].channels.entries()) {
    const bodies = channel.sent.filter((d) => typeof d !== 'string');
    assert.ok(bodies.length > 0, `channel ${c} carried no fragment`);
  }
});

test('chunks are spread across every link', async () => {
  const [send, recv] = linkPool(4, 1);
  const manifest = bigManifest(12, 1024);
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, manifest, (i) => new Uint8Array(1024).fill(i));
  await receiving;

  for (const [i, link] of send.entries()) {
    const bodies = link.channels.flatMap((c) => c.sent).filter((d) => typeof d !== 'string');
    assert.ok(bodies.length > 0, `link ${i} carried nothing, so work is not spread`);
  }
});

test('exactly one chunk is read ahead while the current read is blocked', async () => {
  // Hold the first read open. A serial sender observes only chunk 0 here; an
  // unbounded sender observes all three. One-item read-ahead observes 0 and 1,
  // which is enough to keep storage latency off the wire without holding the
  // whole transfer in memory.
  const [send] = linkPool(1, 1);
  const control = send[0].channels[0];
  const reads = [];
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });

  const transferring = negotiate(send, MANIFEST, (i) => {
    reads.push(i);
    return i === 0 ? first : bodies[i];
  });
  const handling = control.onmessage({
    data: JSON.stringify({ type: WIRE.NEED, indexes: [0, 1, 2] }),
  });

  const whileFirstIsBlocked = [...reads];
  releaseFirst(bodies[0]);
  await handling;
  const result = await transferring;

  assert.deepEqual(whileFirstIsBlocked, [0, 1]);
  assert.equal(result.sent, 3);
});

test('two links delivering concurrently do not cross their chunk indexes', async () => {
  // Reassembly state must be per link and addressed by index. A single shared
  // pending slot races the moment two links deliver at once, and chunks land
  // under each other's indexes. That corruption is invisible with one link,
  // which is exactly why this test exists.
  const [send, recv] = linkPool(4, 2);
  const manifest = bigManifest(16, 4096);
  const got = new Map();
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => got.set(i, bytes[0]),
  });
  await negotiate(send, manifest, (i) => new Uint8Array(4096).fill(i));
  await receiving;

  assert.equal(got.size, 16);
  for (const [i, value] of got) assert.equal(value, i, `chunk ${i} holds chunk ${value}'s bytes`);
});

test('the offer travels once, not once per link', async () => {
  const [send, recv] = linkPool(4, 2);
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: false }),
    has: async () => false,
    onChunk: async () => {},
  });
  await negotiate(send, bigManifest(1, 16), () => new Uint8Array(16));
  await receiving;

  const offers = send.flatMap((l) => l.channels).flatMap((c) => c.sent)
    .filter((d) => typeof d === 'string' && JSON.parse(d).type === WIRE.OFFER);
  assert.equal(offers.length, 1);
});

// The next group drives the receiving half directly, because the fake pool
// delivers in send order and the real transport does not. Unordered channels
// may reorder within a stream, and a chunk's fragments are split across two
// streams which have no ordering between them at all.

function receiver(handlers) {
  const [, recv] = linkPool(1, 1);
  const channel = recv[0].channels[0];
  const receiving = receive(recv, handlers);
  return { receiving, deliver: (data) => channel.onmessage({ data }) };
}

test('fragments arriving out of order are put back in the right places', async () => {
  const got = [];
  const r = receiver({
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => got.push([i, bytes]),
  });
  r.deliver(JSON.stringify({ type: WIRE.OFFER, ...MANIFEST }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The tail first, which is what an unordered channel is allowed to do.
  r.deliver(fragment(0, 3, 6, new Uint8Array([4, 5, 6])));
  r.deliver(fragment(0, 0, 6, new Uint8Array([1, 2, 3])));
  r.deliver(JSON.stringify({ type: WIRE.DONE, count: 1 }));
  await r.receiving;

  assert.deepEqual(got, [[0, new Uint8Array([1, 2, 3, 4, 5, 6])]]);
});

test('a repeated fragment does not finish a chunk that still has a hole', async () => {
  // Counting a repeat toward the total would hand onChunk a buffer with zeroes
  // where the missing fragment belongs, and nothing would ever say so.
  const got = [];
  const r = receiver({
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => got.push([i, bytes]),
  });
  r.deliver(JSON.stringify({ type: WIRE.OFFER, ...MANIFEST }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  r.deliver(fragment(0, 0, 6, new Uint8Array([1, 2, 3])));
  r.deliver(fragment(0, 0, 6, new Uint8Array([1, 2, 3])));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(got, []);

  r.deliver(fragment(0, 3, 6, new Uint8Array([4, 5, 6])));
  r.deliver(JSON.stringify({ type: WIRE.DONE, count: 1 }));
  await r.receiving;
  assert.deepEqual(got, [[0, new Uint8Array([1, 2, 3, 4, 5, 6])]]);
});

test('a fragment that names no place inside a chunk is dropped', async () => {
  const got = [];
  const r = receiver({
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => got.push([i, bytes]),
  });
  r.deliver(JSON.stringify({ type: WIRE.OFFER, ...MANIFEST }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Too short to carry a header at all.
  r.deliver(new Uint8Array([9, 9, 9]));
  // Runs off the end of the chunk it claims to belong to.
  r.deliver(fragment(1, 4, 6, new Uint8Array([1, 2, 3])));
  // Claims a length no chunker would ever produce.
  r.deliver(fragment(2, 0, 1 << 30, new Uint8Array([1])));
  // Names a chunk past the end of the list this side agreed to take.
  r.deliver(fragment(MANIFEST.cids.length, 0, 3, new Uint8Array([1, 2, 3])));
  r.deliver(fragment(0, 0, 3, new Uint8Array([1, 2, 3])));
  r.deliver(JSON.stringify({ type: WIRE.DONE, count: 1 }));
  await r.receiving;

  assert.deepEqual(got, [[0, new Uint8Array([1, 2, 3])]]);
});

test('the transfer is not done until every chunk has landed', async () => {
  // DONE travels on one channel and the last body may be on another, so DONE
  // arriving first says nothing about what is still in flight. Resolving on it
  // alone would report a short count and drop the tail of the file.
  const got = [];
  const r = receiver({
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => got.push([i, bytes]),
  });
  r.deliver(JSON.stringify({ type: WIRE.OFFER, ...MANIFEST }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  r.deliver(fragment(0, 0, 3, bodies[0]));
  r.deliver(JSON.stringify({ type: WIRE.DONE, count: 2 }));

  let settled = false;
  r.receiving.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, 'DONE alone ended a transfer with a chunk outstanding');

  r.deliver(fragment(1, 0, 3, bodies[1]));
  const result = await r.receiving;
  assert.equal(result.received, 2);
  assert.deepEqual(got, [[0, bodies[0]], [1, bodies[1]]]);
});

// A real data channel delivers each message as its own task and never waits for
// the handler it called, so DONE can land while an onChunk write is still in
// flight.
function deliverInOrder(r) {
  r.deliver(JSON.stringify({ type: WIRE.OFFER, ...MANIFEST }));
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    for (let i = 0; i < bodies.length; i++) r.deliver(fragment(i, 0, 3, bodies[i]));
    r.deliver(JSON.stringify({ type: WIRE.DONE, count: bodies.length }));
  });
}

test('completion waits for every chunk write to land', async () => {
  const written = [];
  const r = receiver({
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i, bytes) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      written.push([i, bytes]);
    },
  });
  await deliverInOrder(r);
  const result = await r.receiving;

  assert.equal(result.accepted, true);
  assert.equal(result.received, bodies.length);
  assert.deepEqual(written, bodies.map((b, i) => [i, b]));
});

test('a chunk write that fails fails the transfer', async () => {
  // Resolving on DONE ahead of the writes would settle the promise first and
  // turn this rejection into a silent success.
  const r = receiver({
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async (i) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (i === 1) throw new Error('the store refused the chunk');
    },
  });
  await deliverInOrder(r);

  await assert.rejects(r.receiving, /the store refused the chunk/);
});

test('a peer that asks twice is answered once', async () => {
  // The whole file is read and sealed again on a second answer, across four
  // connections. That is a cost a peer should not be able to ask for twice.
  const [send, recv] = linkPool(1, 1);
  let reads = 0;
  const receiving = receive(recv, {
    onOffer: async () => ({ accept: true }),
    has: async () => false,
    onChunk: async () => {},
  });
  const result = await negotiate(send, MANIFEST, (i) => { reads++; return bodies[i]; });
  await receiving;

  recv[0].channels[0].send(JSON.stringify({ type: WIRE.NEED, indexes: [0, 1, 2] }));
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(result.sent, 3);
  assert.equal(reads, 3);
});

test('a phone opens one connection where a desktop opens several', async () => {
  // Including the iPad, which has called itself a Macintosh since it grew a
  // desktop browser. Touch points are what still separate the two.
  assert.equal(linkCountFor({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }), 1);
  assert.equal(linkCountFor({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), 1);
  assert.equal(linkCountFor({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }), LINK_COUNT);
  assert.equal(linkCountFor({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), LINK_COUNT);
});

// WebRTC is the first thing a VPN client or privacy extension turns off, because
// a peer connection is what reveals a local address. Turning it off removes the
// constructor from the global scope rather than making it fail, so the direct
// path died on a bare ReferenceError several frames from anything that could
// explain it, and the transfer sat at zero chunks with nothing anywhere saying
// why. This is the question that has to be asked before the handshake starts.
test('a browser with WebRTC turned off is recognized, not discovered mid-handshake', () => {
  assert.equal(peerToPeerAvailable({ RTCPeerConnection: function () {} }), true);
  assert.equal(peerToPeerAvailable({}), false);
  // Present but not constructible is the same answer: something replaced it.
  assert.equal(peerToPeerAvailable({ RTCPeerConnection: undefined }), false);
  assert.equal(peerToPeerAvailable({ RTCPeerConnection: {} }), false);

  // And the failure names itself rather than arriving as a ReferenceError.
  assert.throws(() => newConnection({}), /WebRTC turned off/);
});
