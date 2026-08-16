// Where the pieces meet. Presence and the signalling relay say who can be
// reached, the queue says what this device still owes, staging holds the sealed
// chunks between sessions, and the data channels move them.
//
// Two rules shape everything else here. A staged chunk is deleted only once the
// recipient's own progress bitmap says it landed, because deleting when the last
// frame left this device would lose a chunk whose delivery failed after it left.
// And the receiver writes that bitmap after every session including a failed
// one, because a transfer that moved 400 of 500 chunks before the network
// dropped has to resume at 400 and only the written bitmap can say so.

import { api } from './api.js';
import {
  CHANNELS_PER_LINK, LINK_COUNT, linkCountFor, negotiate, newConnection, openChannels, receive,
} from './peer.js';
import { openStage, indexesFrom } from './staging.js';
import { transfersActive } from './wake.js';
import { roomShortfall } from './ios.js';
import {
  DOMAIN, MODE_SEALED, modeOf, openRecord, unpackHashes, loadMaster, b64decode, b64encode,
} from './crypto.js';

// Every id is checked before it reaches a URL. The one that arrives through the
// relay is the least trustworthy string this module sees, because the server
// hands it over without looking inside.
const TRANSFER_ID = /^[0-9a-f]{32}$/;
const CHUNK_ID = /^[0-9a-f]{64}$/;

// A peer that answered the signal but never opened a channel must not hold the
// queue behind it.
const HANDSHAKE_MS = 20000;
// One link's own deadline, deliberately well inside the handshake's. A browser
// reports a failed connection as a channel close on the order of thirty
// seconds, so a link whose candidates never pair up neither opens nor errors in
// time to be dropped by its own rejection. Without a bound here the slowest link
// decides the whole handshake, and opening four connections instead of one would
// make a stalled transfer four times as likely rather than degrading to three
// working links.
const LINK_MS = 8000;
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

const channelsOf = (links) => links.flatMap((link) => link.channels);

// A link that has not opened by its deadline is treated exactly as one that
// rejected: dropped from the array, its connection closed. Waiting on the link
// itself rather than on the whole handshake is the point, because the failure
// this guards against is a connection that stays silent rather than one that
// says no.
function withinDeadline(ready, linkMs) {
  if (!(linkMs > 0)) return ready;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the link never opened')), linkMs);
    ready.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); });
  });
}

// A link whose channels failed to open is dropped rather than failing the whole
// transfer, so a device that manages two of its four connections still sends at
// two connections' worth instead of not sending at all. The pcs behind the
// dropped ones are closed here because nothing else will, and closing one is
// also what tells the far side to drop the same link: its channels for that
// connection close, their whenOpen rejects, and both sides reach negotiate and
// receive holding link arrays that agree.
async function usableLinks(opening, linkMs) {
  const settled = await Promise.allSettled(
    opening.map((link) => withinDeadline(link.ready, linkMs)));
  const links = [];
  opening.forEach((link, i) => {
    if (settled[i].status === 'fulfilled') links.push({ pc: link.pc, channels: [...link.channels] });
    else link.pc.close();
  });
  if (links.length === 0) throw new Error('no link opened');
  return links;
}

// The transport is every part of this module that touches WebRTC or the relay,
// kept behind three calls so the rest of the file is about queues and bitmaps.
//
// The signalling messages are two shapes, offer and answer, each carrying the
// sender's node name. The relay does not stamp an identity onto what it passes,
// so `from` is the peer's own claim: it decides where an answer is addressed and
// nothing else, and every claim about the transfer itself is checked against the
// server's record instead.
//
// A transfer runs over several connections, so each message carries a list of
// session descriptions rather than one. The two sides pair them by position,
// which is why they travel together: one relay round trip and no way for two
// halves of the same handshake to be matched up wrongly.
export function liveTransport({ identity, gatherMs = GATHER_MS, linkMs = LINK_MS } = {}) {
  const encoder = new TextEncoder();
  // One outstanding answer per peer, which is all one session per peer allows.
  const awaiting = new Map();

  const post = (to, message) =>
    api.signal(to, b64encode(encoder.encode(JSON.stringify(message))));

  // Every channel a link owns has to be open before the link can carry
  // anything, because the sender spreads one chunk's fragments across all of
  // them. A rejection here is what marks the link droppable.
  function openingLink(pc, channels) {
    const ready = Promise.all(channels.map(whenOpen));
    // Closing the connection after an earlier step failed rejects this too, and
    // by then nothing is waiting on it. The failure that got us there is the one
    // worth reporting.
    ready.catch(() => {});
    return { pc, channels, ready };
  }

  async function open(node, transferId, signal) {
    const pcs = Array.from({ length: linkCountFor() }, () => newConnection());
    const closeAll = () => { for (const pc of pcs) pc.close(); };
    signal?.addEventListener('abort', closeAll, { once: true });
    const opening = pcs.map((pc) => openingLink(pc, openChannels(pc)));
    const answered = new Promise((resolve, reject) => {
      awaiting.set(node, { pcs, resolve, reject });
    });
    try {
      // Gathering is per connection and none of them waits on another.
      const sdps = await Promise.all(pcs.map(async (pc) => {
        await pc.setLocalDescription(await pc.createOffer());
        await whenGathered(pc, gatherMs);
        return pc.localDescription.sdp;
      }));
      await post(node, {
        kind: 'offer',
        from: await identity(),
        transfer: transferId,
        channels: CHANNELS_PER_LINK,
        sdps,
      });
      await answered;
      return { links: await usableLinks(opening, linkMs), close: closeAll };
    } catch (err) {
      closeAll();
      throw err;
    } finally {
      awaiting.delete(node);
    }
  }

  async function accept(msg, signal) {
    // How many connections and channels to build is the peer's claim, and the
    // relay does not vouch for it. decode() is the gate; the bounds are repeated
    // here because a transport that trusts its own input is one refactor away
    // from a browser tab opening connections until it falls over.
    const sdps = msg.sdps.slice(0, LINK_COUNT);
    const perLink = Number.isInteger(msg.channels) && msg.channels > 0
      ? Math.min(msg.channels, CHANNELS_PER_LINK * 2)
      : CHANNELS_PER_LINK;
    const pcs = sdps.map(() => newConnection());
    const closeAll = () => { for (const pc of pcs) pc.close(); };
    signal?.addEventListener('abort', closeAll, { once: true });

    // The offering side creates the channels, so this side waits for them to
    // arrive rather than making any of its own. They are sorted by label
    // because arrival order is the peer's business, and both sides have to
    // agree which channel carries the control frames.
    const opening = pcs.map((pc) => {
      const channels = [];
      const ready = new Promise((resolve, reject) => {
        pc.ondatachannel = (event) => {
          event.channel.binaryType = 'arraybuffer';
          channels.push(event.channel);
          if (channels.length < perLink) return;
          channels.sort((a, b) => (a.label < b.label ? -1 : 1));
          Promise.all(channels.map(whenOpen)).then(resolve, reject);
        };
      });
      ready.catch(() => {});
      return { pc, channels, ready };
    });

    try {
      const answers = await Promise.all(pcs.map(async (pc, i) => {
        await pc.setRemoteDescription({ type: 'offer', sdp: sdps[i] });
        await pc.setLocalDescription(await pc.createAnswer());
        await whenGathered(pc, gatherMs);
        return pc.localDescription.sdp;
      }));
      await post(msg.from, {
        kind: 'answer',
        from: await identity(),
        transfer: msg.transfer,
        sdps: answers,
      });
      return { links: await usableLinks(opening, linkMs), close: closeAll };
    } catch (err) {
      closeAll();
      throw err;
    }
  }

  async function answer(msg) {
    const waiting = awaiting.get(msg.from);
    // An answer for a handshake this device is not running is not an error. It
    // is a peer that gave up and a reply that arrived after it.
    if (!waiting) return;
    try {
      const sdps = msg.sdps.slice(0, waiting.pcs.length);
      await Promise.all(sdps.map((sdp, i) =>
        waiting.pcs[i].setRemoteDescription({ type: 'answer', sdp })));
      // A peer that answered fewer connections than were offered is not going
      // to answer the rest. Closing them turns a wait that would run to the
      // handshake deadline into a link dropped in the ordinary way.
      for (let i = sdps.length; i < waiting.pcs.length; i++) waiting.pcs[i].close();
      waiting.resolve();
    } catch (err) {
      waiting.reject(err);
    }
  }

  return { open, accept, answer };
}

// The two readings of a transfer's own record that both a session and a save
// need, so they sit outside makeSessions rather than being reachable only from
// inside one device's session state.
async function openMeta(mk, info) {
  const record = b64decode(info.meta);
  // The mode byte decides whether the record is authenticated at all. An
  // unsealed one names the file whatever its writer chose, and that name is
  // what the offer puts in front of the recipient, and what a save writes into
  // the operating system.
  if (modeOf(record) !== MODE_SEALED) throw new Error('this transfer is not sealed');
  return JSON.parse(new TextDecoder().decode(
    await openRecord(mk, DOMAIN.META, info.id, record)));
}

// A list the server has never had a reason to allocate arrives as null rather
// than as an empty array, which is what a transfer nobody has declined looks
// like on the wire. Normalized once here, so no later line has to remember.
const listOf = (value) => (Array.isArray(value) ? value : []);

// Whether every recipient's own progress bitmap says it holds the whole
// transfer. Nothing is decided on the strength of what a device sent: a chunk
// whose delivery failed after it left is exactly the case the sender's own
// record cannot see, so the answer is read back from the server per recipient.
//
// It sits outside makeSessions for the reason openMeta does, that a save needs
// the same answer a session does, and it takes its api as an argument rather
// than closing over one so an injected fake still decides it in a test.
async function deliveredToEveryone(api, info) {
  const to = listOf(info.to);
  // An unaddressed transfer has no fixed recipient set, so there is no point at
  // which it is provably delivered to everyone and nothing here may drop its
  // chunks.
  if (to.length === 0) return false;
  const declined = listOf(info.declined);
  const count = listOf(info.cids).length;
  for (const node of to) {
    if (declined.includes(node)) continue;
    const bitmap = await api.getProgress(info.id, node);
    if (indexesFrom(bitmap, count).length !== count) return false;
  }
  return true;
}

// Whether a save may delete the staged chunks it reads on its way through.
//
// Two questions, and both have to answer yes. The first is whose stage it is: a
// device sees the transfers it sent as well as the ones it was sent, and a
// transfer whose sealed metadata names no stage of its own staged under the
// transfer's own id, so a save on the sending side would be deleting the only
// copy of what this device still owes.
//
// The second is whether anyone is still owed at all, and it is what makes the
// pruning final rather than temporary. A receiver's stage is also what its
// resume answers from, and a transfer leaves the sender's queue only once every
// recipient's bitmap is full. Empty a receiving stage while another addressee is
// still short and the next offer finds every position missing, so the whole file
// crosses the wire again and lands back on disk beside the copy just assembled.
// A transfer already delivered to everyone is never offered again, so there is
// nothing left to refill it.
//
// Either question failing to answer leaves the stage alone. The wrong guess in
// that direction costs disk; the other one is unrecoverable.
export async function mayConsumeStage(api, me, info) {
  try {
    return info.sender !== me && await deliveredToEveryone(api, info);
  } catch {
    return false;
  }
}

// Turning a received transfer into one file the operating system can hold.
//
// This is not part of receiving. The chunks are already on this device or on the
// server and every tag is verified during assembly, so a save is a separate
// action that can be retried as often as it takes. What it answers with is a
// disk-backed File, which is what lets the export cascade stay memory-flat on a
// file of any size.
//
// The work happens in a worker because createSyncAccessHandle is callable only
// from a dedicated worker global scope, and the worker is spawned per save and
// torn down with it: one long job, no protocol to keep straight.
const spawnAssembler = () => new Worker(
  new URL('./assemble-worker.js', import.meta.url), { type: 'module' });

export async function assembleTransfer(transferId, { spawn = spawnAssembler } = {}) {
  if (!TRANSFER_ID.test(transferId || '')) {
    throw new Error('a malformed transfer id has nothing to assemble');
  }
  const mk = await loadMaster();
  if (!mk) throw new Error('Locked. Unlock this device first.');

  const info = await api.transfer(transferId);
  const meta = await openMeta(mk, info);

  // The chunk list is what keys every chunk to its position, and it is sealed
  // for that reason: an unsealed one would let the server choose which bytes go
  // where. Its hashes never leave this device.
  const listRecord = await api.getRecord(transferId, 'chunklist');
  if (modeOf(listRecord) !== MODE_SEALED) throw new Error('this transfer is not sealed');
  const hashes = unpackHashes(await openRecord(mk, DOMAIN.LIST, transferId, listRecord));

  const cids = listOf(info.cids);
  if (hashes.length !== cids.length) {
    throw new Error('the chunk list and the server record disagree on length');
  }
  if (!cids.every((cid) => CHUNK_ID.test(cid))) {
    throw new Error('the server named a malformed chunk id');
  }

  // Reading the staged chunks costs nothing. Deleting them as they are read is
  // the decision, and mayConsumeStage above is where it is made. An identity
  // that cannot be established spares the stage for the same reason everything
  // else in that answer does.
  const consume = await identity().then((me) => mayConsumeStage(api, me, info), () => false);

  const worker = spawn();
  try {
    return await new Promise((resolve, reject) => {
      // A worker that failed to load or died mid assembly would otherwise leave
      // this waiting on a reply that is never coming, and a save that never
      // settles is a button that never comes back.
      const lost = () => reject(new Error('the assembly worker stopped'));
      worker.addEventListener('message', (event) => {
        const { file, error } = event.data || {};
        if (error) reject(new Error(error));
        else resolve(file);
      }, { once: true });
      worker.addEventListener('error', lost, { once: true });
      worker.addEventListener('messageerror', lost, { once: true });
      worker.postMessage({ transfer: transferId, meta, hashes, cids, consume });
    });
  } finally {
    // One job per worker. Terminating with the job is what keeps a save from
    // leaving a thread and an open directory handle behind for the life of the
    // page.
    worker.terminate();
  }
}

// makeSessions holds the state that belongs to one device: which peers have a
// session open, which are cooling off after a failure, and which have refused
// what. The live instance below is the app's; a test builds its own so those
// facts do not leak between them.
export function makeSessions(deps) {
  const {
    api, openStage, transport, negotiate, receive, loadMaster, identity,
    shortfall = roomShortfall,
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

  // What a row has to say about a transfer this device could not take. Running
  // out of disk is the one failure nobody but the person holding this device can
  // undo, so the shortfall is kept where a view can read it instead of being
  // spent on a console line that owner never sees.
  //
  // Bytes rather than a sentence, because the two places that render a size
  // already know how to write one and this module does not.
  const shortfalls = new Map();

  // The one place a peer slot is taken. Two channels to the same device would
  // interleave chunk frames and corrupt both transfers, so a peer that is
  // already busy is skipped rather than queued behind. The map is written before
  // the body starts, so a second caller in the same turn sees the slot taken.
  function claim(node, body) {
    if (sessions.has(node)) return null;
    const session = Promise.resolve().then(() => awake(body)).finally(() => {
      if (sessions.get(node) === session) sessions.delete(node);
    });
    sessions.set(node, session);
    return session;
  }

  // The screen is kept on for exactly as long as a session is running, and the
  // claim above is the one place every session of either direction passes
  // through. The release is in a finally because a session that fails is the
  // ordinary case: without it the device would never sleep again while the tab
  // is open, which is the sort of battery complaint nobody thinks to report.
  async function awake(body) {
    await transfersActive(1);
    try {
      return await body();
    } finally {
      await transfersActive(-1);
    }
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
  // Every channel is watched, not only the one carrying control frames. A link
  // that drops once the transfer is running takes its share of the chunks with
  // it, and the session has to end so the progress bitmap is written and the
  // rest is picked up next time.
  function untilClosed(channels, promise, message) {
    const dropped = new Promise((resolve, reject) => {
      const fail = () => reject(new Error(message));
      for (const channel of channels) {
        channel.addEventListener('close', fail, { once: true });
        channel.addEventListener('error', fail, { once: true });
      }
    });
    return Promise.race([promise, dropped]);
  }

  function sameList(a, b) {
    return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
  }

  function normalize(info) {
    return {
      ...info,
      to: listOf(info.to),
      declined: listOf(info.declined),
      cids: listOf(info.cids),
    };
  }

  async function confirmAndClear(info, stage) {
    for (let attempt = 0; attempt < confirmTries; attempt++) {
      if (attempt > 0) await wait(confirmGapMs);
      // Nothing is deleted on the strength of what this device sent. Only the
      // recipient's own bitmap, read back from the server, says a chunk landed.
      if (await deliveredToEveryone(api, info)) {
        await stage.clear();
        return true;
      }
    }
    return false;
  }

  // Where this device staged the sealed chunks. They are written before the
  // transfer exists, because the ids that name a transfer come from the same
  // pass that seals them, so the directory is named by an id minted during that
  // pass and the sealed metadata carries it. A transfer prepared before that
  // field existed staged under the transfer's own id, which is also what a
  // malformed field falls back to rather than building a path out of it.
  function stageOf(meta, transferId) {
    return TRANSFER_ID.test(meta.stage || '') ? meta.stage : transferId;
  }

  async function sendTo(info, mk, node) {
    const meta = await openMeta(mk, info);
    const stage = await openStage(stageOf(meta, info.id));
    const controller = new AbortController();
    const { links, close } = await withTimeout(
      transport.open(node, info.id, controller.signal),
      handshakeMs, 'the peer never opened a channel', () => controller.abort());
    const channels = channelsOf(links);

    try {
      // The offer names the file and its chunk positions. The hashes that key
      // each chunk stay in the sealed chunk list and never enter a control frame.
      const result = await untilClosed(channels, negotiate(links, {
        name: meta.name, size: meta.size, mime: meta.mime, cids: info.cids,
      }, (i) => stage.get(i)), 'the connection dropped mid-transfer');

      if (!result.accepted) {
        // A refusal that was a decision is final: re-offering would deliver a
        // file the recipient said no to, and the recipient records that decision
        // on the server as well, which is what keeps it final once this page is
        // gone. A refusal the recipient marked retryable is not a decision. It
        // is a condition of the moment, nothing about it is written down
        // anywhere, and treating it as final would mean a disk that was briefly
        // full killed the transfer for as long as this page stays open.
        if (!result.retryable) refused.add(`${info.id}|${node}`);
        else console.warn(`${node} cannot take ${info.id} yet: ${result.reason}`);
        return result;
      }
      // Best effort, because the confirmation below is what actually decides
      // whether anything may be deleted. A buffer that never drains costs a
      // resend of the tail on the next session, not a lost chunk.
      await withTimeout(
        Promise.all(channels.map(flushed)), flushMs, 'the send buffer never drained')
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
        const result = await session;
        // A recipient that refused for a reason which can change is still owed
        // this transfer, and is cooled off first so the retry is not a tight
        // loop against a disk nobody has emptied yet.
        if (result?.accepted === false && result.retryable) {
          cooling.set(node, now() + cooldownMs);
          owed = true;
        }
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
    const { links, close } = await withTimeout(
      transport.accept(msg, controller.signal),
      handshakeMs, 'the peer never opened a channel', () => controller.abort());

    // Set by a write the disk had no room for, and read once the session has
    // ended. A partial stage that can never be completed holds exactly the disk
    // that ran out, so it goes rather than waiting for a resume that would fail
    // at the same byte.
    let outOfRoom = false;

    try {
      await untilClosed(channelsOf(links), receive(links, {
        onOffer: async (frame) => {
          if (info.declined.includes(me)) return { accept: false, reason: 'declined' };
          // The offered chunk list has to be the one the server recorded for
          // this transfer. A peer offering a different one would have this
          // device stage bytes belonging to nothing it agreed to take.
          if (!sameList(frame.cids, info.cids)) {
            return { accept: false, reason: 'that is not this transfer' };
          }
          // Refused up front rather than at ninety percent, and marked as a
          // condition rather than a decision so the sender keeps it queued. The
          // shortfall is recorded against the transfer, because this is the
          // device whose disk it is and the person who can free the space is
          // sitting in front of it: the inbox row is where that lands. The
          // sender is told only that there is no room, which is all it can act
          // on and all a peer is owed about how full this disk is.
          const short = await shortfall(frame.size);
          if (short > 0) {
            shortfalls.set(info.id, short);
            return {
              accept: false,
              reason: 'the receiving device is out of space',
              retryable: true,
            };
          }
          // Cleared on the way in rather than on the way out, so a transfer that
          // is being taken stops claiming a shortfall from the moment it is
          // accepted rather than when it finishes.
          shortfalls.delete(info.id);
          return { accept: true };
        },
        has: (i) => stage.has(i),
        onChunk: async (i, bytes) => {
          // An index outside the chunk list names no position in the bitmap, so
          // storing it would leave a file in the stage that nothing ever reads.
          if (!Number.isInteger(i) || i < 0 || i >= info.cids.length) return;
          // This is the one call in the module that writes to the origin private
          // file system. The stage answers it from a dedicated worker, since
          // createSyncAccessHandle is not callable from the page, so the bytes
          // are handed over here and the write is done by the time it resolves.
          try {
            await stage.put(i, bytes);
          } catch (err) {
            // A full disk is not a retryable write, and it is the one failure
            // the browser reports with no prompt and no way for the owner to
            // grant more. Failing the session here is what turns it into a
            // transfer that stopped rather than one that silently held nothing.
            if (err?.name === 'QuotaExceededError') outOfRoom = true;
            throw err;
          }
        },
      }), 'the connection dropped mid-transfer');
    } finally {
      close();
      // Emptied before the bitmap is written, so what is recorded is what this
      // device actually still holds. The other order would tell the sender that
      // positions are landed and then delete them.
      if (outOfRoom) {
        await stage.clear().catch(
          (err) => console.warn('the partial stage was not cleared', err));
      }
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
    // A transfer runs over several connections, so a handshake carries a list.
    // The length is bounded here rather than at the point of use, because this
    // is the last place the payload is anything but trusted: without the bound
    // a peer could name a thousand descriptions and have this device try to
    // open a thousand connections.
    if (!Array.isArray(msg.sdps) || msg.sdps.length === 0) return null;
    if (msg.sdps.length > LINK_COUNT) return null;
    if (!msg.sdps.every((sdp) => typeof sdp === 'string')) return null;
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

  // How many bytes short this device was the last time it refused this transfer
  // for want of room, or 0 if it never did. Read by the inbox row, which is the
  // one surface the transfer already has on the device that has to act.
  function shortfallFor(transferId) {
    return shortfalls.get(transferId) || 0;
  }

  return { startSend, handleSignal, drainQueue, shortfallFor };
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

export const { startSend, handleSignal, drainQueue, shortfallFor } = live;
