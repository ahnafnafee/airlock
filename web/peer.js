// Direct transfer over WebRTC data channels. Chunks arrive here already sealed,
// so this module moves opaque bytes and never touches a key.
//
// The negotiation is deliberately the same question the server is asked: which
// of these chunks do you already have. A peer holding an earlier version of a
// file answers with only what changed, so delta sync works on the direct path
// with no extra machinery.
//
// Three facts shape the transport.
//
// A data channel refuses a message larger than the connection's negotiated
// maximum, so a multi-megabyte chunk cannot be one message. Chunks travel as
// fragments and are reassembled here.
//
// Throughput comes from several connections, not from several channels.
// Channels on one RTCPeerConnection are SCTP streams inside a single
// association: they share one congestion window, one DTLS transport and one UDP
// socket, so striping across them buys no bandwidth. Separate connections are
// separate associations, and those do add up.
//
// Channels within a connection earn their place for head-of-line blocking
// instead. They are unordered, so a fragment waiting on a retransmit does not
// hold up everything queued behind it.
//
// ponytail: the remaining ceiling is usrsctp, which is single threaded and CPU
// bound inside the browser, and it is not a setting. On a gigabit link this
// approaches it; on 10 GbE no browser tab will saturate the wire. Lift it only
// with a native peer, at the cost of a second implementation of the crypto.

import { isIOS } from './ios.js';

export const WIRE = {
  OFFER: 'offer',
  DECLINE: 'decline',
  NEED: 'need',
  DONE: 'done',
};

// How many connections a transfer opens, and how many channels each carries.
// Both are named because they are what a throughput measurement varies, and
// either may turn out to be 1. docs/benchmarks.md section 5 holds that sweep,
// including what its result has to decide and how to keep a relayed run or a
// receiver that already holds the file from answering the question wrongly.
export const LINK_COUNT = 4;
export const CHANNELS_PER_LINK = 2;

// 64 KiB is the safe interop maximum for a data channel message. The real limit
// is pc.sctp.maxMessageSize and is read at runtime; this is the fragment size
// used within it. An 8 MiB chunk sent as one message does not run slowly, it
// fails outright.
export const FRAGMENT = 16 << 10;
const SAFE_MAX_MESSAGE = 64 << 10;

// Every fragment says where it belongs: chunk index, byte offset, and the whole
// chunk's length, big endian. A fragment that only meant "the next piece" would
// be wrong here twice over, because the channels are unordered and because one
// chunk's fragments are spread across a link's channels. Neither delivery order
// is promised, so position travels with the bytes.
const HEADER = 12;

// The largest chunk length a peer may declare, matching the server's own per
// chunk ceiling: a chunk larger than that could not have been stored, so it is
// not one this device is going to be asked for. The cap exists so a peer cannot
// make this device allocate an arbitrary buffer by naming a length it never
// intends to fill. The other half of that bound is the index check on arrival,
// which keeps a fragment from opening a buffer for a chunk this side never
// agreed to take.
const MAX_CHUNK = 16 << 20;

// A data channel's send buffer is finite, and there are now several of them.
// Pushing into a full one throws or silently drops. Held low enough that the
// whole fan-out costs about what one channel used to.
const HIGH_WATER = 1 << 20;

function waitForDrain(channel) {
  if (channel.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = HIGH_WATER / 2;
    channel.addEventListener('bufferedamountlow', () => resolve(), { once: true });
  });
}

async function send(channel, value) {
  await waitForDrain(channel);
  channel.send(value);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

function packFragment(index, offset, total, payload) {
  const message = new Uint8Array(HEADER + payload.length);
  const view = new DataView(message.buffer);
  view.setUint32(0, index);
  view.setUint32(4, offset);
  view.setUint32(8, total);
  message.set(payload, HEADER);
  return message;
}

function unpackFragment(data) {
  const bytes = asBytes(data);
  if (bytes.length < HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(8);
  if (total > MAX_CHUNK) return null;
  const payload = bytes.subarray(HEADER);
  const offset = view.getUint32(4);
  if (offset + payload.length > total) return null;
  return { index: view.getUint32(0), offset, total, payload };
}

// The payload budget for one message, which is the connection's limit less the
// header. The floor keeps a nonsensical limit from producing a zero-length
// fragment, which would loop forever.
function fragmentSize(pc) {
  const limit = pc?.sctp?.maxMessageSize;
  const room = limit && limit < SAFE_MAX_MESSAGE ? limit : SAFE_MAX_MESSAGE;
  return Math.max(512, Math.min(FRAGMENT, room - HEADER));
}

export function openChannels(pc, count = CHANNELS_PER_LINK) {
  return Array.from({ length: count }, (_, i) => {
    const channel = pc.createDataChannel(`airlock-${i}`, { ordered: false });
    // Without this, Safari hands back a Blob and every chunk needs an extra
    // async read before it can be decrypted.
    channel.binaryType = 'arraybuffer';
    return channel;
  });
}

// WebKit publishes no per-page connection limit and practitioner reports have
// iOS being both more resource constrained and less reliable with several
// connections at once. Opening four there risks trading a working transfer for
// throughput that a phone's link cannot use anyway.
export function linkCountFor(navigatorLike = navigator) {
  return isIOS(navigatorLike) ? 1 : LINK_COUNT;
}

// Chunk i belongs to link i % linkCount, which is what spreads the transfer
// across every association rather than filling one.
function indexesFor(wanted, linkCount, link) {
  return wanted.filter((i) => i % linkCount === link);
}

async function sendChunks(link, indexes, readChunk) {
  const { channels } = link;
  const size = fragmentSize(link.pc);
  let turn = 0;
  // The next chunk is read while this one is on the wire. Reading it only after
  // the last fragment of its predecessor had been handed over left the link idle
  // for the length of a storage read, once per chunk, and a chunk is megabytes.
  //
  // Exactly one read runs ahead: a second buys nothing, because one is already
  // enough to cover a send, and it would double what a link holds in memory.
  // readChunk may answer synchronously, so its result is normalized first, and
  // a read that fails while nothing awaits it would surface as an unhandled
  // rejection rather than as the transfer failure it is.
  const runAhead = (i) => {
    if (i >= indexes.length) return null;
    const p = Promise.resolve(readChunk(indexes[i]));
    p.catch(() => {});
    return p;
  };
  let ahead = runAhead(0);
  for (let i = 0; i < indexes.length; i++) {
    const index = indexes[i];
    const pending = ahead;
    ahead = runAhead(i + 1);
    const bytes = asBytes(await pending);
    const total = bytes.length;
    if (total === 0) {
      await send(channels[turn++ % channels.length], packFragment(index, 0, 0, bytes));
      continue;
    }
    for (let offset = 0; offset < total; offset += size) {
      const channel = channels[turn++ % channels.length];
      const end = Math.min(offset + size, total);
      await send(channel, packFragment(index, offset, total, bytes.subarray(offset, end)));
    }
  }
}

// negotiate drives the sending half and resolves when the transfer ends, either
// because it finished or because the peer refused it. Control frames travel on
// one channel; bodies travel on all of them.
export function negotiate(links, manifest, readChunk) {
  if (!links.length) return Promise.reject(new Error('a transfer needs at least one link'));
  return new Promise((resolve, reject) => {
    const control = links[0].channels[0];
    let settled = false;
    let started = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    control.onmessage = async (event) => {
      if (typeof event.data !== 'string') return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }

      if (frame.type === WIRE.DECLINE) {
        // Two different refusals travel on this frame and the sender treats them
        // oppositely. A decision is final and must never be re-offered; a
        // condition of the moment, such as a disk with no room left on it, has
        // to stay queued or freeing space would never let the file land.
        finish({
          accepted: false, sent: 0, held: 0,
          reason: frame.reason || '',
          retryable: frame.retry === true,
        });
        return;
      }
      if (frame.type !== WIRE.NEED) return;
      // A peer that asks twice gets one answer. Reading and sending the file a
      // second time is a cost it should not be able to ask this device to pay.
      if (started) return;
      started = true;

      try {
        const asked = new Set(frame.indexes || []);
        const wanted = [];
        for (let i = 0; i < manifest.cids.length; i++) {
          if (asked.has(i)) wanted.push(i);
        }
        // One worker per link, because the point of several connections is that
        // a link waiting on its own send buffer does not stop the others.
        await Promise.all(links.map((link, l) =>
          sendChunks(link, indexesFor(wanted, links.length, l), readChunk)));
        // The count is what lets the far side know it has everything. DONE
        // travels on one channel and the last body may be on another, so
        // arriving first says nothing about what is still in flight.
        await send(control, JSON.stringify({ type: WIRE.DONE, count: wanted.length }));
        finish({ accepted: true, sent: wanted.length, held: manifest.cids.length - wanted.length });
      } catch (err) {
        fail(err);
      }
    };

    // The offer names the file and its chunks. It carries no hashes: those are
    // the per-chunk key material and they live only in the sealed chunk list.
    send(control, JSON.stringify({
      type: WIRE.OFFER,
      name: manifest.name,
      size: manifest.size,
      mime: manifest.mime,
      cids: manifest.cids,
    })).catch(fail);
  });
}

// receive drives the receiving half. onOffer decides whether to take it, has()
// answers the dedup question per index, and onChunk is handed each sealed chunk
// once every one of its fragments has landed.
export function receive(links, { onOffer, has, onChunk }) {
  if (!links.length) return Promise.reject(new Error('a transfer needs at least one link'));
  return new Promise((resolve, reject) => {
    let received = 0;
    // How many chunks the sender says it sent, known only once DONE arrives.
    let expected = null;
    // How many chunks this side agreed to take, from the offer it accepted.
    let count = 0;
    let settled = false;
    // The event dispatcher does not await this handler, so frames keep arriving
    // while an onChunk write is still in flight. Every write is chained onto
    // this promise, which keeps them in completion order and gives the end of
    // the transfer something to wait on.
    let writes = Promise.resolve();

    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const complete = () => {
      if (expected !== null && received >= expected) finish({ accepted: true, received });
    };

    const handle = async (pending, channel, event) => {
      try {
        if (typeof event.data !== 'string') {
          const piece = unpackFragment(event.data);
          // A fragment that does not describe a place in a chunk of this
          // transfer is not ours to keep. Guessing where it went would corrupt
          // the file silently, and holding a buffer for it would be work this
          // side never agreed to.
          if (!piece || piece.index >= count) return;
          let slot = pending.get(piece.index);
          if (!slot) {
            slot = { bytes: new Uint8Array(piece.total), seen: new Set(), filled: 0 };
            pending.set(piece.index, slot);
          }
          // Two fragments disagreeing about the chunk's length cannot both be
          // right, and the one already being assembled is the one to trust.
          if (slot.bytes.length !== piece.total) return;
          // Counting a repeat would complete the chunk with a hole in it.
          if (slot.seen.has(piece.offset)) return;
          slot.seen.add(piece.offset);
          slot.bytes.set(piece.payload, piece.offset);
          slot.filled += piece.payload.length;
          if (slot.filled < piece.total) return;
          pending.delete(piece.index);
          writes = writes
            .then(() => onChunk(piece.index, slot.bytes))
            .then(() => { received++; complete(); });
          await writes;
          return;
        }

        const frame = JSON.parse(event.data);
        if (frame.type === WIRE.OFFER) {
          count = Array.isArray(frame.cids) ? frame.cids.length : 0;
          const decision = await onOffer(frame);
          if (!decision.accept) {
            // retry says the refusal can change on its own. Without it the
            // sender is right to give up, and with it wrongly set a file the
            // recipient said no to would be offered again.
            channel.send(JSON.stringify({
              type: WIRE.DECLINE,
              reason: decision.reason || '',
              retry: decision.retryable === true,
            }));
            finish({ accepted: false, received: 0 });
            return;
          }
          const need = [];
          for (let i = 0; i < frame.cids.length; i++) {
            if (!await has(i)) need.push(i);
          }
          channel.send(JSON.stringify({ type: WIRE.NEED, indexes: need }));
          return;
        }
        if (frame.type === WIRE.DONE) {
          expected = Number.isInteger(frame.count) ? frame.count : 0;
          // The transfer is not done until the last body is written. Resolving
          // ahead of the writes would report a short count and would let a
          // failed write be swallowed by an already settled promise.
          await writes;
          complete();
        }
      } catch (err) {
        fail(err);
      }
    };

    // Reassembly state is per link, not global. Chunk indexes are dealt out by
    // link, so a link's pending map can never collide with another's, and a
    // single shared map would be one more thing for four connections to race
    // over for no gain.
    for (const link of links) {
      const pending = new Map();
      for (const channel of link.channels) {
        channel.onmessage = (event) => handle(pending, channel, event);
      }
    }
  });
}

// Whether this browser will make a peer connection at all. WebRTC is the first
// thing a VPN client or a privacy extension turns off, because a peer connection
// is what reveals a local address, and turning it off removes the constructor
// from the global scope rather than making it fail. Asked as a capability
// question, like everything else here, and never as a question about which
// browser this is.
export function peerToPeerAvailable(scope = globalThis) {
  return typeof scope.RTCPeerConnection === 'function';
}

// The ICE servers a connection is built with. Airlock answers STUN itself, on
// the address the client already reached it at, because of what a browser does
// to host candidates: a private one is replaced by a random .local name so a
// page cannot read the local network layout, and resolving that needs multicast
// DNS on a shared link. A tailnet is a routed tunnel with no multicast, so two
// devices on one exchange candidates neither can resolve and no pair is ever
// checked. A server-reflexive candidate is not obfuscated, so asking a server
// both devices can already reach is what turns the tailnet address into a
// candidate the other side can use.
//
// No public STUN server is contacted. The one host in the path is the one the
// product already depends on.
let iceServers = [];

export function useStun(port, host) {
  iceServers = port > 0 && host
    ? [{ urls: `stun:${host}:${port}` }]
    : [];
  return iceServers;
}

export function newConnection(scope = globalThis) {
  // Without this the missing constructor surfaces as a bare ReferenceError from
  // inside a handshake, several frames from anything that could explain it, and
  // the transfer simply sits at zero chunks forever.
  if (!peerToPeerAvailable(scope)) {
    throw new Error('this browser has WebRTC turned off, so a direct transfer'
      + ' cannot be sent or received here');
  }
  return new scope.RTCPeerConnection({ iceServers });
}
