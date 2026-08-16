// Direct transfer over a WebRTC data channel. Chunks arrive here already sealed,
// so this module moves opaque bytes and never touches a key.
//
// The negotiation is deliberately the same question the server is asked: which
// of these chunks do you already have. A peer holding an earlier version of a
// file answers with only what changed, so delta sync works on the direct path
// with no extra machinery.
//
// ponytail: one data channel carries the whole transfer and every chunk is sent
// as a single message, so the link runs at the rate of one connection and a
// chunk larger than the peer's maximum message size cannot be sent at all. The
// ceiling is the single channel and the whole-chunk frame. Lift it by opening
// several channels and splitting each chunk across numbered frames the
// receiving side reassembles before it calls onChunk.

export const WIRE = {
  OFFER: 'offer',
  DECLINE: 'decline',
  NEED: 'need',
  CHUNK: 'chunk',
  DONE: 'done',
};

// A data channel's send buffer is finite. Pushing a multi-megabyte chunk into a
// full one throws or silently drops it.
const HIGH_WATER = 4 << 20;

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

// negotiate drives the sending half and resolves when the transfer ends, either
// because it finished or because the peer refused it.
export function negotiate(channel, manifest, readChunk) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    channel.onmessage = async (event) => {
      if (typeof event.data !== 'string') return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }

      if (frame.type === WIRE.DECLINE) {
        finish({ accepted: false, sent: 0, held: 0, reason: frame.reason || '' });
        return;
      }
      if (frame.type !== WIRE.NEED) return;

      try {
        const wanted = new Set(frame.indexes || []);
        let sent = 0;
        for (let i = 0; i < manifest.cids.length; i++) {
          if (!wanted.has(i)) continue;
          const bytes = await readChunk(i);
          await send(channel, JSON.stringify({ type: WIRE.CHUNK, index: i }));
          await send(channel, bytes);
          sent++;
        }
        await send(channel, JSON.stringify({ type: WIRE.DONE }));
        finish({ accepted: true, sent, held: manifest.cids.length - sent });
      } catch (err) {
        if (!settled) { settled = true; reject(err); }
      }
    };

    // The offer names the file and its chunks. It carries no hashes: those are
    // the per-chunk key material and they live only in the sealed chunk list.
    send(channel, JSON.stringify({
      type: WIRE.OFFER,
      name: manifest.name,
      size: manifest.size,
      mime: manifest.mime,
      cids: manifest.cids,
    })).catch(reject);
  });
}

// receive drives the receiving half. onOffer decides whether to take it, has()
// answers the dedup question per index, and onChunk is handed each sealed chunk.
export function receive(channel, { onOffer, has, onChunk }) {
  return new Promise((resolve, reject) => {
    let pending = null;
    let received = 0;

    channel.onmessage = async (event) => {
      try {
        if (typeof event.data !== 'string') {
          // A body with no header is not ours to keep. Writing it under
          // whatever index was last seen would corrupt the file silently.
          if (pending === null) return;
          const bytes = event.data instanceof Uint8Array
            ? event.data
            : new Uint8Array(event.data);
          const index = pending;
          pending = null;
          await onChunk(index, bytes);
          received++;
          return;
        }

        const frame = JSON.parse(event.data);
        if (frame.type === WIRE.OFFER) {
          const decision = await onOffer(frame);
          if (!decision.accept) {
            channel.send(JSON.stringify({ type: WIRE.DECLINE, reason: decision.reason || '' }));
            resolve({ accepted: false, received: 0 });
            return;
          }
          const need = [];
          for (let i = 0; i < frame.cids.length; i++) {
            if (!await has(i)) need.push(i);
          }
          channel.send(JSON.stringify({ type: WIRE.NEED, indexes: need }));
          return;
        }
        if (frame.type === WIRE.CHUNK) {
          pending = frame.index;
          return;
        }
        if (frame.type === WIRE.DONE) {
          resolve({ accepted: true, received });
        }
      } catch (err) {
        reject(err);
      }
    };
  });
}

// On a tailnet ICE finds the 100.x addresses as host candidates, so there is no
// STUN and no TURN to configure. An empty server list is correct here rather
// than an oversight.
export function newConnection() {
  return new RTCPeerConnection({ iceServers: [] });
}
