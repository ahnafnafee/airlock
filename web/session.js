// Where the pieces meet. Presence and the signalling relay say who can be
// reached, the queue says what this device still owes, staging holds the sealed
// chunks between sessions, and the data channel moves them.
//
// Two rules shape everything else here. A staged chunk is deleted only once the
// recipient's own progress bitmap says it landed, because deleting when the last
// frame left this device would lose a chunk whose delivery failed after it left.
// And the receiver writes that bitmap after every session including a failed
// one, because a transfer that moved 400 of 500 chunks before the network
// dropped has to resume at 400 and only the written bitmap can say so.

import { api } from './api.js';
import { newConnection, negotiate, receive } from './peer.js';
import { openStage, indexesFrom } from './staging.js';
import {
  DOMAIN, MODE_SEALED, modeOf, openRecord, loadMaster, b64decode, b64encode,
} from './crypto.js';

// Every id is checked before it reaches a URL. The one that arrives through the
// relay is the least trustworthy string this module sees, because the server
// hands it over without looking inside.
const TRANSFER_ID = /^[0-9a-f]{32}$/;

// A peer that answered the signal but never opened a channel must not hold the
// queue behind it.
const HANDSHAKE_MS = 20000;
// On a tailnet ICE has nothing to ask a STUN server about, so gathering ends
// almost at once. This only bounds the wait for the case where it does not.
const GATHER_MS = 4000;
// The tail of a transfer is still in the send buffer when the last frame is
// queued, and closing a connection discards what it holds.
const FLUSH_MS = 10000;
// A failure is retryable, but not instantly: a peer that is present and failing
// would otherwise spin through the queue as fast as the network allows.
const COOLDOWN_MS = 15000;
// The recipient writes its bitmap once the session has ended, so the sender's
// first read of it is legitimately too early. Nothing is deleted until it is not.
const CONFIRM_TRIES = 6;
const CONFIRM_GAP_MS = 500;
// The event stream carries an arrival and a signalling payload, and nothing
// about a peer appearing, so a device that still owes something asks.
const PRESENCE_POLL_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// whenOpen and whenGathered are the two waits a handshake is made of. Neither
// carries its own deadline: the session owns that, so a fake transport in a test
// cannot be the thing that decides a stalled peer is released.
function whenOpen(channel) {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    channel.addEventListener('open', () => resolve(), { once: true });
    channel.addEventListener('close', () => reject(new Error('the channel closed before it opened')), { once: true });
    channel.addEventListener('error', () => reject(new Error('the channel failed before it opened')), { once: true });
  });
}

// ponytail: the whole candidate set is gathered before one session description
// is sent, rather than trickling candidates as they are found. The ceiling is
// this wait, which is nothing on a tailnet full of host candidates and the
// gather timeout on a network that needs STUN. Lift it by relaying each
// candidate as its own signalling message and adding them as they arrive.
function whenGathered(pc, gatherMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, gatherMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

// A connection closed with bytes still buffered discards them, and the last
// chunk of a transfer is the one most likely to still be there.
function flushed(channel) {
  if (!channel.bufferedAmount) return Promise.resolve();
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = 0;
    channel.addEventListener('bufferedamountlow', () => resolve(), { once: true });
    channel.addEventListener('close', () => resolve(), { once: true });
  });
}

// The transport is every part of this module that touches WebRTC or the relay,
// kept behind three calls so the rest of the file is about queues and bitmaps.
//
// The signalling messages are two shapes, offer and answer, each carrying the
// sender's node name. The relay does not stamp an identity onto what it passes,
// so `from` is the peer's own claim: it decides where an answer is addressed and
// nothing else, and every claim about the transfer itself is checked against the
// server's record instead.
export function liveTransport({ identity, gatherMs = GATHER_MS } = {}) {
  const encoder = new TextEncoder();
  // One outstanding answer per peer, which is all one session per peer allows.
  const awaiting = new Map();

  const post = (to, message) =>
    api.signal(to, b64encode(encoder.encode(JSON.stringify(message))));

  // Ordered, and deliberately so. A chunk travels as a header frame naming its
  // index followed by a separate body frame, so two chunks that overtook each
  // other would have their bodies written under the wrong index and the file
  // would be corrupted silently. The DONE sentinel depends on the same
  // guarantee.
  const dataChannel = (pc) => {
    const channel = pc.createDataChannel('airlock', { ordered: true });
    channel.binaryType = 'arraybuffer';
    return channel;
  };

  async function open(node, transferId, signal) {
    const pc = newConnection();
    signal?.addEventListener('abort', () => pc.close(), { once: true });
    const channel = dataChannel(pc);
    const opened = whenOpen(channel);
    // Closing the connection after an earlier step failed rejects this too, and
    // by then nothing is waiting on it. The failure that got us there is the one
    // worth reporting.
    opened.catch(() => {});
    const answered = new Promise((resolve, reject) => {
      awaiting.set(node, { pc, resolve, reject });
    });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await whenGathered(pc, gatherMs);
      await post(node, {
        kind: 'offer',
        from: await identity(),
        transfer: transferId,
        sdp: pc.localDescription.sdp,
      });
      await answered;
      await opened;
      return { channel, close: () => pc.close() };
    } catch (err) {
      pc.close();
      throw err;
    } finally {
      awaiting.delete(node);
    }
  }

  async function accept(msg, signal) {
    const pc = newConnection();
    signal?.addEventListener('abort', () => pc.close(), { once: true });
    // The offering side creates the channel, so this side waits for it to
    // arrive rather than making one of its own.
    const arrived = new Promise((resolve) => {
      pc.ondatachannel = (event) => {
        event.channel.binaryType = 'arraybuffer';
        resolve(event.channel);
      };
    });
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await whenGathered(pc, gatherMs);
      await post(msg.from, {
        kind: 'answer',
        from: await identity(),
        transfer: msg.transfer,
        sdp: pc.localDescription.sdp,
      });
      const channel = await arrived;
      await whenOpen(channel);
      return { channel, close: () => pc.close() };
    } catch (err) {
      pc.close();
      throw err;
    }
  }

  async function answer(msg) {
    const waiting = awaiting.get(msg.from);
    // An answer for a handshake this device is not running is not an error. It
    // is a peer that gave up and a reply that arrived after it.
    if (!waiting) return;
    try {
      await waiting.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      waiting.resolve();
    } catch (err) {
      waiting.reject(err);
    }
  }

  return { open, accept, answer };
}

// makeSessions holds the state that belongs to one device: which peers have a
// session open, which are cooling off after a failure, and which have refused
// what. The live instance below is the app's; a test builds its own so those
// facts do not leak between them.
export function makeSessions(deps) {
  const {
    api, openStage, transport, negotiate, receive, loadMaster, identity,
    handshakeMs = HANDSHAKE_MS,
    flushMs = FLUSH_MS,
    cooldownMs = COOLDOWN_MS,
    confirmTries = CONFIRM_TRIES,
    confirmGapMs = CONFIRM_GAP_MS,
    presencePollMs = PRESENCE_POLL_MS,
    wait = sleep,
    now = () => Date.now(),
  } = deps;

  const sessions = new Map();
  const cooling = new Map();
  const refused = new Set();

  // The one place a peer slot is taken. Two channels to the same device would
  // interleave chunk frames and corrupt both transfers, so a peer that is
  // already busy is skipped rather than queued behind. The map is written before
  // the body starts, so a second caller in the same turn sees the slot taken.
  function claim(node, body) {
    if (sessions.has(node)) return null;
    const session = Promise.resolve().then(body).finally(() => {
      if (sessions.get(node) === session) sessions.delete(node);
    });
    sessions.set(node, session);
    return session;
  }

  // A handshake that lands after its deadline still holds a live connection, and
  // by then nothing else will ever close it.
  function withTimeout(promise, ms, message, onExpiry) {
    if (!(ms > 0)) return promise;
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        onExpiry?.();
        reject(new Error(message));
      }, ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          if (expired) value?.close?.();
          else resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          if (!expired) reject(err);
        })
        // The late failure of something already given up on has nowhere to go.
        .catch(() => {});
    });
  }

  // negotiate and receive both end on a frame from the other side, so a
  // connection that drops mid-transfer leaves them waiting for one that will
  // never come. Racing the close is what turns that into a failed session with
  // a progress bitmap rather than a promise nobody ever settles.
  function untilClosed(channel, promise, message) {
    const dropped = new Promise((resolve, reject) => {
      const fail = () => reject(new Error(message));
      channel.addEventListener('close', fail, { once: true });
      channel.addEventListener('error', fail, { once: true });
    });
    return Promise.race([promise, dropped]);
  }

  async function openMeta(mk, info) {
    const record = b64decode(info.meta);
    // The mode byte decides whether the record is authenticated at all. An
    // unsealed one names the file whatever its writer chose, and that name is
    // what the offer puts in front of the recipient.
    if (modeOf(record) !== MODE_SEALED) throw new Error('this transfer is not sealed');
    return JSON.parse(new TextDecoder().decode(
      await openRecord(mk, DOMAIN.META, info.id, record)));
  }

  function sameList(a, b) {
    return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
  }

  // A list the server has never had a reason to allocate arrives as null rather
  // than as an empty array, which is what a transfer nobody has declined looks
  // like on the wire. Normalized once here, so no later line has to remember.
  const listOf = (value) => (Array.isArray(value) ? value : []);

  function normalize(info) {
    return {
      ...info,
      to: listOf(info.to),
      declined: listOf(info.declined),
      cids: listOf(info.cids),
    };
  }

  // Nothing is deleted on the strength of what this device sent. Only the
  // recipient's own bitmap, read back from the server, says a chunk landed.
  async function deliveredToEveryone(info) {
    // An unaddressed transfer has no fixed recipient set, so there is no point
    // at which it is provably delivered to everyone and nothing here may drop
    // its chunks.
    if (info.to.length === 0) return false;
    const count = info.cids.length;
    for (const node of info.to) {
      if (info.declined.includes(node)) continue;
      const bitmap = await api.getProgress(info.id, node);
      if (indexesFrom(bitmap, count).length !== count) return false;
    }
    return true;
  }

  async function confirmAndClear(info, stage) {
    for (let attempt = 0; attempt < confirmTries; attempt++) {
      if (attempt > 0) await wait(confirmGapMs);
      if (await deliveredToEveryone(info)) {
        await stage.clear();
        return true;
      }
    }
    return false;
  }

  async function sendTo(info, mk, node) {
    const stage = await openStage(info.id);
    const meta = await openMeta(mk, info);
    const controller = new AbortController();
    const { channel, close } = await withTimeout(
      transport.open(node, info.id, controller.signal),
      handshakeMs, 'the peer never opened a channel', () => controller.abort());

    try {
      // The offer names the file and its chunk positions. The hashes that key
      // each chunk stay in the sealed chunk list and never enter a control frame.
      const result = await untilClosed(channel, negotiate(channel, {
        name: meta.name, size: meta.size, mime: meta.mime, cids: info.cids,
      }, (i) => stage.get(i)), 'the connection dropped mid-transfer');

      if (!result.accepted) {
        // A refusal is final. Re-offering would deliver a file the recipient
        // said no to. The recipient records it on the server as well, which is
        // what keeps it final once this page is gone.
        refused.add(`${info.id}|${node}`);
        return result;
      }
      // Best effort, because the confirmation below is what actually decides
      // whether anything may be deleted. A buffer that never drains costs a
      // resend of the tail on the next session, not a lost chunk.
      await withTimeout(flushed(channel), flushMs, 'the send buffer never drained')
        .catch(() => {});
      await confirmAndClear(info, stage);
      return result;
    } finally {
      close();
    }
  }

  // startSend offers one queued transfer to each of its recipients that is here
  // to take it. A per-peer failure is caught and cooled off rather than thrown,
  // so one unreachable device does not stop the rest of the queue.
  //
  // It answers whether it left anyone owed, which is the only place that can be
  // known: four of the five ways a recipient is skipped are still reachable
  // later, and the caller has to come back for them. Away, cooling off after a
  // failure, holding this device's one session slot, and failing outright all
  // say "later"; a decline says never. Reporting only the absent ones would
  // leave a transfer that failed against a peer who stayed online with nothing
  // scheduled to try it again.
  async function startSend(transferId, online = null) {
    if (!TRANSFER_ID.test(transferId || '')) {
      throw new Error('a malformed transfer id has nothing to send');
    }
    const mk = await loadMaster();
    // The sealed metadata names the file the offer describes, and it opens only
    // on an unlocked device. Unlocking is itself what starts the drain, so a
    // locked device has nothing to schedule.
    if (!mk) return false;

    const info = normalize(await api.transfer(transferId));
    const here = online || new Set(await api.presence());

    let owed = false;
    for (const node of info.to) {
      // Both finals. Neither a decline recorded on the server nor a refusal
      // heard on the wire is undone by waiting.
      if (info.declined.includes(node)) continue;
      if (refused.has(`${info.id}|${node}`)) continue;

      if (!here.has(node)) { owed = true; continue; }
      if ((cooling.get(node) || 0) > now()) { owed = true; continue; }

      const session = claim(node, () => sendTo(info, mk, node));
      // The slot is held by a session already running against this peer, quite
      // possibly a receive. When it ends nothing announces it, so this transfer
      // waits on the poll rather than on an event.
      if (!session) { owed = true; continue; }
      try {
        await session;
      } catch (err) {
        cooling.set(node, now() + cooldownMs);
        owed = true;
        console.warn(`sending to ${node} failed`, err);
      }
    }
    return owed;
  }

  // The bitmap is written after every session, including one that ended badly,
  // and including one that was declined. It is the only thing that tells the
  // sender where to pick up.
  async function writeProgress(info, stage) {
    try {
      await api.putProgress(info.id, await stage.bitmap(info.cids.length));
    } catch (err) {
      console.warn('progress was not recorded', err);
    }
  }

  async function acceptFrom(msg) {
    const me = await identity();
    const info = normalize(await api.transfer(msg.transfer));
    // Two claims the relay cannot vouch for, checked against the server's own
    // record: the offering peer has to be this transfer's sender, and this
    // device has to be one of its recipients.
    if (info.sender !== msg.from || info.sender === me) return;
    if (info.to.length > 0 && !info.to.includes(me)) return;

    // No master key is needed to receive. Chunks arrive sealed and go to staging
    // as opaque bytes, so a locked device still takes delivery.
    const stage = await openStage(info.id);
    const controller = new AbortController();
    const { channel, close } = await withTimeout(
      transport.accept(msg, controller.signal),
      handshakeMs, 'the peer never opened a channel', () => controller.abort());

    try {
      await untilClosed(channel, receive(channel, {
        onOffer: async (frame) => {
          if (info.declined.includes(me)) return { accept: false, reason: 'declined' };
          // The offered chunk list has to be the one the server recorded for
          // this transfer. A peer offering a different one would have this
          // device stage bytes belonging to nothing it agreed to take.
          if (!sameList(frame.cids, info.cids)) {
            return { accept: false, reason: 'that is not this transfer' };
          }
          return { accept: true };
        },
        has: (i) => stage.has(i),
        onChunk: async (i, bytes) => {
          // An index outside the chunk list names no position in the bitmap, so
          // storing it would leave a file in the stage that nothing ever reads.
          if (!Number.isInteger(i) || i < 0 || i >= info.cids.length) return;
          // ponytail: this is the one call in the module that writes to the
          // origin private file system, and openStage writes through
          // createSyncAccessHandle, which a browser only allows inside a
          // dedicated worker. The ceiling is that the receiving half does not
          // run in the page at all: the first chunk to arrive rejects with
          // InvalidStateError, while every read the sending half makes stays
          // main-thread safe. Lift it by moving the stage's writes into a
          // worker behind a message protocol, keeping openStage's signature, so
          // this line is the only one that has to stay exactly as it is.
          await stage.put(i, bytes);
        },
      }), 'the connection dropped mid-transfer');
    } finally {
      close();
      await writeProgress(info, stage);
    }
  }

  function decode(payload) {
    let msg;
    try {
      msg = JSON.parse(new TextDecoder().decode(b64decode(payload)));
    } catch {
      return null;
    }
    if (!msg || typeof msg.from !== 'string' || msg.from === '') return null;
    if (typeof msg.sdp !== 'string') return null;
    if (!TRANSFER_ID.test(msg.transfer || '')) return null;
    return msg;
  }

  async function handleSignal(payload) {
    const msg = decode(payload);
    if (!msg) return;
    if (msg.kind === 'answer') {
      await transport.answer(msg);
      return;
    }
    if (msg.kind !== 'offer') return;

    // A peer that offers while this device is already busy with it is ignored.
    // It offers again on its own next drain, which is a shorter wait than
    // tearing down a transfer that is already moving.
    const session = claim(msg.from, () => acceptFrom(msg));
    if (!session) return;
    try {
      await session;
    } catch (err) {
      console.warn(`receiving from ${msg.from} failed`, err);
    }
  }

  let pollTimer = null;

  // ponytail: a peer coming back is noticed by asking rather than by being told,
  // because the event stream carries no presence change. The ceiling is one poll
  // interval of delay, paid only while this device owes something to a recipient
  // that is away. Lift it by publishing a presence change on the event stream,
  // at which point this timer goes.
  function schedulePoll(owed) {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (!owed || !(presencePollMs > 0)) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      drainQueue();
    }, presencePollMs);
  }

  async function drainOnce() {
    let queued;
    let here;
    try {
      queued = await api.queue();
      if (queued.length === 0) {
        schedulePoll(false);
        return;
      }
      here = new Set(await api.presence());
    } catch (err) {
      // The server was unreachable, which says nothing about whether this device
      // still owes something. Keep asking rather than going quiet until the next
      // nudge, because a nudge is exactly what an unreachable server cannot send.
      console.warn('the queue did not load', err);
      schedulePoll(true);
      return;
    }

    // Whether anything is still owed is startSend's answer rather than a second
    // reading of the same conditions here, because a copy of them would go stale
    // against the one that decides. The call comes first in the expression so
    // that a transfer is always offered, never short circuited past.
    let owed = false;
    for (const raw of queued) {
      const info = normalize(raw);
      try {
        owed = (await startSend(info.id, here)) || owed;
      } catch (err) {
        // The transfer could not even be read. That is a condition of this
        // moment, not of the transfer, so it is worth coming back for.
        console.warn(`transfer ${info.id} could not be offered`, err);
        owed = true;
      }
    }
    schedulePoll(owed);
  }

  // drainQueue runs on app open and on every nudge, which is what makes "open
  // the app and it sends" true rather than "keep the app open". Two of them at
  // once would read the same queue twice, so a call that arrives mid-drain is
  // collapsed into one more pass at the end.
  let draining = false;
  let again = false;

  async function drainQueue() {
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    try {
      do {
        again = false;
        await drainOnce();
      } while (again);
    } finally {
      draining = false;
    }
  }

  return { startSend, handleSignal, drainQueue };
}

// The app's own instance. Its identity is read once and cached: it names this
// device in every signalling message and decides which side of a transfer it is
// on, and it cannot change while the page is open.
let mine = null;
function identity() {
  if (!mine) {
    mine = api.whoami().then((who) => who.node).catch((err) => {
      mine = null;
      throw err;
    });
  }
  return mine;
}

const live = makeSessions({
  api,
  openStage,
  transport: liveTransport({ identity }),
  negotiate,
  receive,
  loadMaster,
  identity,
});

export const { startSend, handleSignal, drainQueue } = live;
