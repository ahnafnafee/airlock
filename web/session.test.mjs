import test from 'node:test';
import assert from 'node:assert/strict';
import { liveTransport, makeSessions, mayConsumeStage } from './session.js';
import { api } from './api.js';
import { LINK_COUNT } from './peer.js';
import { bitmapOf } from './staging.js';
import { DOMAIN, MODE_SEALED, b64encode, sealRecord } from './crypto.js';

// These test the five ways this module can go wrong, against fakes for
// everything it reaches outside itself. There is no RTCPeerConnection in Node
// and no origin private file system, but neither is where the bugs are: the
// bugs are in when a session may start, when a staged chunk may be deleted, and
// what is written down after a session that failed.

const ID = 'a'.repeat(32);
const CIDS = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
const ME = 'desktop';
const PEER = 'pixel';

const key = await crypto.subtle.importKey(
  'raw', new Uint8Array(32), 'HKDF', false, ['deriveBits', 'deriveKey']);

const STAGE = 'd'.repeat(32);

const metaRecord = async (extra = {}) => b64encode(await sealRecord(
  key, MODE_SEALED, DOMAIN.META, ID,
  new TextEncoder().encode(JSON.stringify({
    name: 'holiday.jpg', size: 9, mime: 'image/jpeg', ...extra,
  }))));

const META = await metaRecord();
const META_STAGED = await metaRecord({ stage: STAGE });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Long enough for a chain of real subtle-crypto promises to land, which is what
// separates "this session has not started yet" from "this session was refused".
const settle = () => sleep(50);

// The default transfer is one arriving here. A test about sending overrides both
// ends, because which side this device is on decides everything below.
const SENDING = { sender: ME, to: [PEER] };

function fakeStage(held = []) {
  const store = new Map(held.map((i) => [i, new Uint8Array([i])]));
  const stage = {
    store,
    cleared: 0,
    put: async (i, bytes) => { store.set(i, bytes); },
    get: async (i) => {
      if (!store.has(i)) throw new Error(`chunk ${i} is not staged`);
      return store.get(i);
    },
    has: async (i) => store.has(i),
    held: async () => new Set(store.keys()),
    bitmap: async (count) => bitmapOf(new Set(store.keys()), count),
    clear: async () => { stage.cleared++; store.clear(); },
  };
  return stage;
}

function fakeChannel() {
  return {
    readyState: 'open',
    bufferedAmount: 0,
    addEventListener() {},
    removeEventListener() {},
    send() {},
  };
}

// A transfer runs over several connections, each carrying several channels.
// Everything this module does with them is per link, so one link with one
// channel is enough to stand for the shape.
const fakeLinks = (channel) => [{ pc: null, channels: [channel] }];

// One device's worth of fakes. Everything a test wants to vary is an override,
// and everything a test wants to assert on is recorded on `log`.
function harness(overrides = {}) {
  const log = {
    opens: [], accepts: [], answers: [], progress: [], aborted: 0,
  };
  const info = {
    id: ID,
    sender: PEER,
    to: [ME],
    declined: [],
    cids: CIDS,
    meta: META,
    ...overrides.info,
  };
  const stage = overrides.stage || fakeStage();
  const progressOf = overrides.progressOf || (() => new Uint8Array(0));
  // Which directory each side asked for. The sender's is named by the sealed
  // metadata rather than by the transfer, so the key is worth recording.
  log.stages = [];

  const api = {
    // A fresh copy per call, and a null list stays null: that is what the wire
    // carries for a slice the server never allocated.
    transfer: async () => ({
      ...info,
      to: Array.isArray(info.to) ? [...info.to] : info.to,
      declined: Array.isArray(info.declined) ? [...info.declined] : info.declined,
    }),
    presence: async () => overrides.online || [PEER],
    queue: async () => overrides.queue || [],
    getProgress: async (id, node) => progressOf(node),
    putProgress: async (id, bitmap) => { log.progress.push({ id, bitmap }); },
    signal: async () => {},
    whoami: async () => ({ node: ME }),
  };

  const channel = fakeChannel();
  const opened = () => ({ links: fakeLinks(channel), close: () => {} });

  const transport = {
    open: overrides.open || (async (node, id, signal) => {
      log.opens.push({ node, id });
      signal?.addEventListener('abort', () => { log.aborted++; });
      return opened();
    }),
    accept: overrides.accept || (async (msg, signal) => {
      log.accepts.push(msg);
      signal?.addEventListener('abort', () => { log.aborted++; });
      return opened();
    }),
    answer: async (msg) => { log.answers.push(msg); },
  };

  const sessions = makeSessions({
    api,
    transport,
    openStage: async (key) => { log.stages.push(key); return stage; },
    negotiate: overrides.negotiate
      || (async () => ({ accepted: true, sent: CIDS.length, held: 0 })),
    receive: overrides.receive || (async () => ({ accepted: true, received: 0 })),
    loadMaster: async () => (overrides.locked ? null : key),
    identity: async () => ME,
    shortfall: overrides.shortfall,
    handshakeMs: overrides.handshakeMs ?? 200,
    flushMs: 50,
    cooldownMs: overrides.cooldownMs ?? 0,
    confirmTries: overrides.confirmTries ?? 2,
    confirmGapMs: 0,
    // Off unless a test is about the poll, so no test leaves a timer behind it.
    presencePollMs: overrides.presencePollMs ?? 0,
    wait: () => Promise.resolve(),
    now: overrides.now || (() => Date.now()),
  });

  return { sessions, api, transport, stage, log, info, channel };
}

const offerFrom = (node = PEER, transfer = ID) => b64encode(new TextEncoder().encode(
  JSON.stringify({ kind: 'offer', from: node, transfer, channels: 2, sdps: ['v=0', 'v=0'] })));

test('a peer gets one session at a time', async () => {
  let release = null;
  let holding = true;
  const h = harness({
    info: SENDING,
    open: (node, id) => {
      h.log.opens.push({ node, id });
      const opened = { links: fakeLinks(h.channel), close: () => {} };
      if (!holding) return Promise.resolve(opened);
      return new Promise((resolve) => { release = () => resolve(opened); });
    },
    handshakeMs: 0,
  });

  // Two concurrent offers to the same device. A second channel would interleave
  // its chunk frames with the first and corrupt both transfers.
  const first = h.sessions.startSend(ID);
  const second = h.sessions.startSend(ID);
  await settle();
  assert.equal(h.log.opens.length, 1);

  holding = false;
  release();
  await Promise.all([first, second]);

  // And the slot is given back, so the next drain is not blocked forever.
  await h.sessions.startSend(ID);
  assert.equal(h.log.opens.length, 2);
});

test('a receiver writes its progress after a session that failed', async () => {
  const stage = fakeStage([0, 1]);
  const h = harness({
    stage,
    receive: async () => { throw new Error('the connection dropped'); },
  });

  await h.sessions.handleSignal(offerFrom());

  // Two of three chunks landed before the drop. Without this write the sender
  // has no way to learn that and would start again from nothing.
  assert.equal(h.log.progress.length, 1);
  assert.equal(h.log.progress[0].id, ID);
  assert.deepEqual([...h.log.progress[0].bitmap], [0b011]);
});

test('a receiver writes its progress after a session that succeeded', async () => {
  const stage = fakeStage([0, 1, 2]);
  const h = harness({ stage });
  await h.sessions.handleSignal(offerFrom());
  assert.equal(h.log.progress.length, 1);
  assert.deepEqual([...h.log.progress[0].bitmap], [0b111]);
});

test('staged chunks survive a session the recipient has not confirmed', async () => {
  const stage = fakeStage([0, 1, 2]);
  // The recipient reports two of three. A chunk whose delivery failed after it
  // left this device is exactly this case, and deleting here would lose it.
  const h = harness({
    info: SENDING,
    stage,
    progressOf: () => new Uint8Array([0b011]),
  });

  await h.sessions.startSend(ID);
  assert.equal(stage.cleared, 0);
  assert.equal(stage.store.size, 3);
});

test('staged chunks are dropped once the recipient confirms every one', async () => {
  const stage = fakeStage([0, 1, 2]);
  const h = harness({
    info: SENDING,
    stage,
    progressOf: () => new Uint8Array([0b111]),
  });

  await h.sessions.startSend(ID);
  assert.equal(stage.cleared, 1);
});

// A save reads the stage on its way through and may delete what it read. These
// four are the whole of when it may, because the stage is both what this device
// still owes other people and what a resumed transfer answers from.
const FULL = new Uint8Array([0b111]);
const bitmaps = (per) => ({ getProgress: async (id, node) => per[node] ?? new Uint8Array(0) });

test('a save never spends the stage of a transfer this device is sending', async () => {
  // A transfer whose sealed metadata names no stage of its own is staged under
  // the transfer's own id, which is the same directory a save reads. Deleting
  // there destroys the only copy of what this device still owes.
  const info = { id: ID, sender: ME, to: [PEER], declined: [], cids: CIDS };
  assert.equal(await mayConsumeStage(bitmaps({ [PEER]: FULL }), ME, info), false);
});

test('a save spends a received stage only once every recipient holds the file', async () => {
  const info = { id: ID, sender: PEER, to: [ME, 'laptop'], declined: [], cids: CIDS };

  // The laptop is still owed, so this transfer is still in the sender's queue
  // and will be offered here again. An emptied stage answers that offer with
  // every position missing, so the whole file crosses the wire a second time and
  // lands beside the copy this save just assembled.
  assert.equal(
    await mayConsumeStage(bitmaps({ [ME]: FULL, laptop: new Uint8Array([0b001]) }), ME, info),
    false);

  // Delivered to everybody, so nothing will ever offer it again.
  assert.equal(
    await mayConsumeStage(bitmaps({ [ME]: FULL, laptop: FULL }), ME, info), true);

  // A decline is final, so a recipient that refused is owed nothing and its
  // empty bitmap does not hold the stage open forever.
  assert.equal(
    await mayConsumeStage(bitmaps({ [ME]: FULL }), ME,
      { ...info, declined: ['laptop'] }), true);
});

test('a stage is spared whenever the answer cannot be established', async () => {
  const info = { id: ID, sender: PEER, to: [ME], declined: [], cids: CIDS };
  const failing = { getProgress: async () => { throw new Error('the server is unreachable'); } };
  assert.equal(await mayConsumeStage(failing, ME, info), false);

  // An unaddressed transfer has no recipient set, so there is no point at which
  // it is provably delivered to everyone.
  assert.equal(
    await mayConsumeStage(bitmaps({}), ME, { ...info, to: null, declined: null }), false);
});

test('the sender reads the stage the sealed metadata names', async () => {
  // The sealed chunks are staged before the transfer exists, so the directory is
  // not named by the transfer's id. A sender that opened the transfer's id
  // instead would find an empty stage, offer a file whose every position answers
  // with nothing, and fail the session against a peer that was right there.
  const h = harness({ info: { ...SENDING, meta: META_STAGED } });
  await h.sessions.startSend(ID);
  assert.deepEqual(h.log.stages, [STAGE]);
});

test('a transfer whose metadata names no stage falls back to its own id', async () => {
  // What a transfer prepared before the field existed looks like.
  const h = harness({ info: SENDING });
  await h.sessions.startSend(ID);
  assert.deepEqual(h.log.stages, [ID]);
});

test('a refusal is final and is not offered again', async () => {
  const h = harness({
    info: SENDING,
    negotiate: async () => ({ accepted: false, sent: 0, held: 0, reason: 'not now' }),
  });

  await h.sessions.startSend(ID);
  await h.sessions.startSend(ID);
  // Re-offering would deliver a file the recipient said no to.
  assert.equal(h.log.opens.length, 1);
});

test('a refusal the peer marked retryable stays queued and is offered again', async () => {
  // A recipient with a full disk is not a recipient that said no. Treating the
  // two the same would let a disk that was briefly full kill the transfer for as
  // long as this page stays open, and freeing space would not bring it back.
  const h = harness({
    info: SENDING,
    negotiate: async () => ({
      accepted: false, sent: 0, held: 0,
      reason: 'the receiving device is out of space',
      retryable: true,
    }),
  });

  assert.equal(await h.sessions.startSend(ID), true, 'the recipient was left owed nothing');
  assert.equal(await h.sessions.startSend(ID), true);
  assert.equal(h.log.opens.length, 2);
});

test('a failure is retried where a refusal is not', async () => {
  let attempts = 0;
  const h = harness({
    info: SENDING,
    negotiate: async () => {
      attempts++;
      throw new Error('the connection dropped');
    },
  });

  await h.sessions.startSend(ID);
  await h.sessions.startSend(ID);
  assert.equal(attempts, 2);
});

test('a failed peer is left alone until its cooldown expires', async () => {
  let clock = 1000;
  const h = harness({
    info: SENDING,
    negotiate: async () => { throw new Error('the connection dropped'); },
    cooldownMs: 5000,
    now: () => clock,
  });

  await h.sessions.startSend(ID);
  const cooling = await h.sessions.startSend(ID);
  assert.equal(h.log.opens.length, 1);
  // The peer is present and cooling, so nothing external will ever say "now".
  // Reporting the transfer as still owed is what buys it another pass.
  assert.equal(cooling, true);

  clock += 5001;
  await h.sessions.startSend(ID);
  assert.equal(h.log.opens.length, 2);
});

test('a peer holding a session leaves the transfer owed', async () => {
  let release = null;
  const h = harness({
    info: SENDING,
    open: (node, id) => {
      h.log.opens.push({ node, id });
      return new Promise((resolve) => {
        release = () => resolve({ links: fakeLinks(h.channel), close: () => {} });
      });
    },
    handshakeMs: 0,
  });

  const first = h.sessions.startSend(ID);
  await settle();
  assert.equal(h.log.opens.length, 1);

  // While A is receiving from B, A's drain skips B. Nothing announces the end of
  // that session, so a skip that reported nothing would strand this transfer.
  const second = await h.sessions.startSend(ID);
  assert.equal(h.log.opens.length, 1);
  assert.equal(second, true);

  release();
  await first;
});

test('a drain comes back for a peer that stayed online and failed', async () => {
  let attempts = 0;
  const opts = {
    info: SENDING,
    queue: [{ id: ID, to: [PEER], declined: [] }],
    presencePollMs: 10,
    negotiate: async () => {
      attempts++;
      throw new Error('the connection dropped');
    },
  };
  const h = harness(opts);

  await h.sessions.drainQueue();
  assert.equal(attempts, 1);

  // The peer never went away, so its event stream never dropped and no inbox
  // event is coming. Without a scheduled pass the transfer sits here forever.
  await sleep(60);
  assert.ok(attempts > 1, 'the drain never came back for a peer that was present');

  // Emptying the queue is what stops the polling, which is the same thing that
  // ends it in the app once the transfer is gone.
  opts.queue = [];
  await sleep(40);
});

test('a handshake that never completes releases the peer', async () => {
  let working = false;
  const h = harness({
    info: SENDING,
    open: (node, id, signal) => {
      h.log.opens.push({ node, id });
      signal?.addEventListener('abort', () => { h.log.aborted++; });
      if (working) return Promise.resolve({ links: fakeLinks(h.channel), close: () => {} });
      // A peer that answered the signal and then went quiet.
      return new Promise(() => {});
    },
    handshakeMs: 30,
  });

  const outcome = await Promise.race([
    h.sessions.startSend(ID).then(() => 'settled'),
    sleep(1000).then(() => 'hung'),
  ]);
  assert.equal(outcome, 'settled');
  // The abandoned connection is told to close: nothing else ever will.
  assert.equal(h.log.aborted, 1);

  working = true;
  await h.sessions.startSend(ID);
  assert.equal(h.log.opens.length, 2);
});

test('an offer whose chunk list is not the transfer is refused', async () => {
  let handlers = null;
  const h = harness({
    receive: async (channel, given) => {
      handlers = given;
      return { accepted: false, received: 0 };
    },
  });

  await h.sessions.handleSignal(offerFrom());
  assert.deepEqual(await handlers.onOffer({ cids: CIDS }), { accept: true });

  const wrong = await handlers.onOffer({ cids: ['d'.repeat(64)] });
  assert.equal(wrong.accept, false);
});

test('an offer for a transfer this device already declined is refused', async () => {
  let handlers = null;
  const h = harness({
    info: { declined: [ME] },
    receive: async (channel, given) => {
      handlers = given;
      return { accepted: false, received: 0 };
    },
  });

  await h.sessions.handleSignal(offerFrom());
  const decision = await handlers.onOffer({ cids: CIDS });
  assert.equal(decision.accept, false);
});

test('an offer this device has no room for is refused before a chunk is staged', async () => {
  // The disk is the constraint the quota does not describe, so a transfer that
  // cannot fit is refused up front rather than failing at ninety percent.
  const stage = fakeStage();
  const asked = [];
  let handlers = null;
  const h = harness({
    stage,
    shortfall: async (bytes) => { asked.push(bytes); return 4096; },
    receive: async (channel, given) => {
      handlers = given;
      return { accepted: false, received: 0 };
    },
  });

  await h.sessions.handleSignal(offerFrom());
  const decision = await handlers.onOffer({ cids: CIDS, size: 9e12 });
  assert.equal(decision.accept, false);
  // Marked retryable, because a full disk is a condition of this moment and the
  // sender records anything else as a decision it must never re-offer.
  assert.equal(decision.retryable, true);
  assert.deepEqual(asked, [9e12]);
  assert.equal(stage.store.size, 0);
  // And the shortfall reaches the one surface the owner of this disk can see.
  // A console line would be a message to a developer.
  assert.equal(h.sessions.shortfallFor(ID), 4096);
});

test('an offer that fits is accepted, so the preflight is a bound and not a refusal', async () => {
  let handlers = null;
  const h = harness({
    shortfall: async () => 0,
    receive: async (channel, given) => {
      handlers = given;
      return { accepted: true, received: 0 };
    },
  });

  await h.sessions.handleSignal(offerFrom());
  assert.deepEqual(await handlers.onOffer({ cids: CIDS, size: 9 }), { accept: true });
  assert.equal(h.sessions.shortfallFor(ID), 0);
});

test('space freed after a refusal clears the note the row was showing', async () => {
  // The transfer is offered again on its own, so the row has to stop saying a
  // thing that is no longer true the moment it is taken.
  let short = 4096;
  let handlers = null;
  const h = harness({
    shortfall: async () => short,
    receive: async (channel, given) => {
      handlers = given;
      return { accepted: false, received: 0 };
    },
  });

  await h.sessions.handleSignal(offerFrom());
  await handlers.onOffer({ cids: CIDS, size: 9e12 });
  assert.equal(h.sessions.shortfallFor(ID), 4096);

  short = 0;
  await h.sessions.handleSignal(offerFrom());
  assert.deepEqual(await handlers.onOffer({ cids: CIDS, size: 9e12 }), { accept: true });
  assert.equal(h.sessions.shortfallFor(ID), 0);
});

test('a shortfall is announced when it appears and again when it is retired', async () => {
  // The row that carries this note is rendered on the inbox nudge, which the
  // server publishes once per transfer and always before the offer that
  // discovers the disk is full. Sampling alone would show the note never, then
  // keep showing it after the transfer had been taken, so the map has to say
  // when it moves in either direction.
  let short = 4096;
  let handlers = null;
  const h = harness({
    shortfall: async () => short,
    receive: async (channel, given) => {
      handlers = given;
      return { accepted: false, received: 0 };
    },
  });

  const seen = [];
  h.sessions.onStorageNote(() => seen.push(h.sessions.shortfallFor(ID)));

  await h.sessions.handleSignal(offerFrom());
  await handlers.onOffer({ cids: CIDS, size: 9e12 });
  assert.deepEqual(seen, [4096]);

  short = 0;
  await h.sessions.handleSignal(offerFrom());
  await handlers.onOffer({ cids: CIDS, size: 9e12 });
  // The listener reads the same answer the row will, so what it saw is what the
  // row would have painted: the note, then no note.
  assert.deepEqual(seen, [4096, 0]);
});

test('an offer this device always had room for announces nothing', async () => {
  // The clear runs on every accepted offer. A transfer that never claimed a
  // shortfall has nothing to retire, and a repaint per accepted offer would be
  // an inbox re-read per transfer for no change on screen.
  let handlers = null;
  const h = harness({
    shortfall: async () => 0,
    receive: async (channel, given) => {
      handlers = given;
      return { accepted: true, received: 0 };
    },
  });

  let announced = 0;
  h.sessions.onStorageNote(() => { announced++; });

  await h.sessions.handleSignal(offerFrom());
  await handlers.onOffer({ cids: CIDS, size: 9 });
  assert.equal(announced, 0);
});

test('a listener that throws does not fail the offer it was told about', async () => {
  // The listener is a view repainting. A fault in there is cosmetic, and letting
  // it out of the offer handler would turn it into a refused transfer.
  let handlers = null;
  const h = harness({
    shortfall: async () => 4096,
    receive: async (channel, given) => {
      handlers = given;
      return { accepted: false, received: 0 };
    },
  });

  h.sessions.onStorageNote(() => { throw new Error('the view fell over'); });

  await h.sessions.handleSignal(offerFrom());
  const decision = await handlers.onOffer({ cids: CIDS, size: 9e12 });
  assert.equal(decision.retryable, true);
  assert.equal(h.sessions.shortfallFor(ID), 4096);
});

test('a staged write refused for quota drops the partial stage and records nothing', async () => {
  // A stage that can never be completed holds exactly the disk that ran out, and
  // a bitmap written over it would claim positions this device no longer has.
  // Held from an earlier session, so the bitmap below has something to lose and
  // the order of the clear and the write is actually under test.
  const stage = fakeStage([0]);
  const quota = new Error('the quota has been exceeded');
  quota.name = 'QuotaExceededError';
  stage.put = async () => { throw quota; };

  let handlers = null;
  const h = harness({
    stage,
    receive: async (channel, given) => {
      handlers = given;
      // The write rejects, which is what ends the session in production too.
      await assert.rejects(handlers.onChunk(1, new Uint8Array([1])), /quota/);
      throw new Error('the connection dropped mid-transfer');
    },
  });

  await h.sessions.handleSignal(offerFrom());
  assert.equal(stage.cleared, 1);
  // Written after the stage was emptied, so it reports what is actually held.
  assert.equal(h.log.progress.length, 1);
  assert.deepEqual([...h.log.progress[0].bitmap], [0]);
});

test('a staged write that failed for any other reason keeps the stage to resume from', async () => {
  const stage = fakeStage();
  stage.put = async () => { throw new Error('the staging worker stopped'); };

  let handlers = null;
  const h = harness({
    stage,
    receive: async (channel, given) => {
      handlers = given;
      await assert.rejects(handlers.onChunk(0, new Uint8Array([1])), /worker/);
      throw new Error('the connection dropped mid-transfer');
    },
  });

  await h.sessions.handleSignal(offerFrom());
  assert.equal(stage.cleared, 0);
});

test('a chunk index outside the transfer is not staged', async () => {
  const stage = fakeStage();
  let handlers = null;
  const h = harness({
    stage,
    receive: async (channel, given) => {
      handlers = given;
      return { accepted: true, received: 0 };
    },
  });

  await h.sessions.handleSignal(offerFrom());
  await handlers.onChunk(CIDS.length, new Uint8Array([1]));
  await handlers.onChunk(-1, new Uint8Array([1]));
  await handlers.onChunk(1.5, new Uint8Array([1]));
  assert.equal(stage.store.size, 0);

  await handlers.onChunk(2, new Uint8Array([1]));
  assert.equal(stage.store.size, 1);
});

test('an offer from anyone but the transfer sender is ignored', async () => {
  const h = harness({});
  // The relay hands the payload over without stamping an identity onto it, so
  // the claim is checked against the server's own record of who sent this.
  await h.sessions.handleSignal(offerFrom('laptop'));
  assert.equal(h.log.accepts.length, 0);
  assert.equal(h.log.progress.length, 0);
});

test('a malformed signalling payload is dropped rather than acted on', async () => {
  const h = harness({});
  await h.sessions.handleSignal('not base64 at all !!');
  await h.sessions.handleSignal(b64encode(new TextEncoder().encode('{')));
  // A transfer id that would become a path segment if it were ever trusted.
  await h.sessions.handleSignal(b64encode(new TextEncoder().encode(JSON.stringify({
    kind: 'offer', from: PEER, transfer: '../../etc', sdps: ['v=0'],
  }))));
  assert.equal(h.log.accepts.length, 0);
});

test('an offer naming more connections than this device opens is dropped', async () => {
  // The relay hands the payload over unread, so the list length is a peer's
  // claim. Without the bound a peer could ask this browser tab to open a
  // thousand connections, and it would try.
  const h = harness({});
  const offer = (sdps) => b64encode(new TextEncoder().encode(JSON.stringify({
    kind: 'offer', from: PEER, transfer: ID, sdps,
  })));

  await h.sessions.handleSignal(offer(Array.from({ length: 64 }, () => 'v=0')));
  await h.sessions.handleSignal(offer([]));
  await h.sessions.handleSignal(offer(['v=0', 17]));
  assert.equal(h.log.accepts.length, 0);

  // And the shape it does accept still gets through, so the bound is a bound
  // and not a refusal of everything.
  await h.sessions.handleSignal(offer(['v=0', 'v=0']));
  assert.equal(h.log.accepts.length, 1);
});

test('an answer is handed to the transport and starts no session', async () => {
  const h = harness({});
  await h.sessions.handleSignal(b64encode(new TextEncoder().encode(JSON.stringify({
    kind: 'answer', from: PEER, transfer: ID, sdps: ['v=0'],
  }))));
  assert.equal(h.log.answers.length, 1);
  assert.equal(h.log.accepts.length, 0);
});

test('a drain offers every queued transfer and survives one that fails', async () => {
  const second = 'b'.repeat(32);
  let calls = 0;
  const h = harness({
    info: SENDING,
    queue: [{ id: ID, to: [PEER], declined: [] }, { id: second, to: [PEER], declined: [] }],
    negotiate: async () => {
      calls++;
      if (calls === 1) throw new Error('the connection dropped');
      return { accepted: true, sent: 0, held: CIDS.length };
    },
  });

  await h.sessions.drainQueue();
  assert.equal(h.log.opens.length, 2);
});

test('a list the server never allocated arrives as null and is still a list', async () => {
  // Go marshals a slice it never allocated as null, so "declined" on a transfer
  // nobody has refused is literally null on the wire. Reading it as an array
  // without this is a crash on the first transfer anyone ever sends.
  const stage = fakeStage([0, 1, 2]);
  const h = harness({
    info: { sender: ME, to: [PEER], declined: null },
    stage,
    queue: [{ id: ID, to: null, declined: null }],
    progressOf: () => new Uint8Array([0b111]),
  });

  await h.sessions.drainQueue();
  assert.equal(h.log.opens.length, 1);
  assert.equal(stage.cleared, 1);
});

test('a locked device offers nothing, because it cannot open the metadata', async () => {
  const h = harness({ info: SENDING, locked: true });
  await h.sessions.startSend(ID);
  assert.equal(h.log.opens.length, 0);
});

test('a malformed transfer id never reaches a URL', async () => {
  const h = harness({ info: SENDING });
  await assert.rejects(() => h.sessions.startSend('../../etc/passwd'));
  await assert.rejects(() => h.sessions.startSend('A'.repeat(32)));
  await assert.rejects(() => h.sessions.startSend(''));
});

// The smallest connection the handshake can talk to. Everything below the
// channels is answered flatly, because what this is here to exercise is which
// links survive, not what WebRTC does with a session description.
function fakeConnection(opens) {
  const channels = [];
  return {
    channels,
    closed: false,
    iceGatheringState: 'complete',
    localDescription: { sdp: 'v=0' },
    createDataChannel(label) {
      // A channel that is not going to open stays in 'connecting' and never
      // fires anything, which is how a browser reports a connection whose
      // candidates never paired: silence, until it gives up far later.
      const channel = { label, readyState: opens ? 'open' : 'connecting', addEventListener() {} };
      channels.push(channel);
      return channel;
    },
    createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    addEventListener() {},
    removeEventListener() {},
    close() { this.closed = true; },
  };
}

// The timeout is the assertion. Before the per-link deadline existed this hung
// on Promise.allSettled until the session's handshake deadline took the whole
// transfer down with it, which is the failure the link deadline exists to stop.
test('a link that never opens is dropped, and the rest of the transfer goes', { timeout: 5000 }, async () => {
  const made = [];
  const realConnection = globalThis.RTCPeerConnection;
  const realSignal = api.signal;
  globalThis.RTCPeerConnection = function RTCPeerConnectionStub() {
    // The first connection stalls; the others open normally.
    const pc = fakeConnection(made.length > 0);
    made.push(pc);
    return pc;
  };
  api.signal = async () => {};

  try {
    const transport = liveTransport({ identity: async () => ME, gatherMs: 0, linkMs: 20 });
    const opening = transport.open(PEER, ID);
    await settle();
    assert.equal(made.length, LINK_COUNT);
    await transport.answer({ from: PEER, transfer: ID, sdps: made.map(() => 'v=0') });

    const { links } = await opening;
    assert.equal(links.length, LINK_COUNT - 1, 'the stalled link was not dropped');
    assert.ok(made[0].closed, 'the dropped link was left holding a connection');
    for (const pc of made.slice(1)) assert.ok(!pc.closed, 'a working link was closed');
  } finally {
    globalThis.RTCPeerConnection = realConnection;
    api.signal = realSignal;
  }
});
