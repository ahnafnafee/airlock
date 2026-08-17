// Hashes and seals one chunk, and stages it. Cutting stays on the main thread
// because a content-defined boundary depends on the bytes before it; nothing
// here depends on anything but its own chunk, which is what makes it
// parallelizable.
//
// The sealed bytes are written from here rather than sent back. The synchronous
// access handle is only available in a worker and is much faster than
// createWritable, and writing where the bytes already are means a chunk crosses
// a thread boundary once, going in, and never comes back.

import { chunkIdentity, sealChunk } from './crypto.js';
import { writeStaged } from './staging.js';

let master = null;
let mode = null;
let transferId = null;

self.addEventListener('message', async (event) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    // A non-extractable CryptoKey survives structured clone, so no key material
    // is serialized to get here.
    master = msg.mk;
    mode = msg.mode;
    transferId = msg.transferId;
    self.postMessage({ type: 'ready' });
    return;
  }
  try {
    const { h, cid } = await chunkIdentity(master, mode, msg.plain);
    const sealed = await sealChunk(master, mode, h, cid, msg.plain);
    await writeStaged(transferId, msg.index, sealed);
    // Only the identity comes back. The sealed bytes stay on disk, which is
    // where the sender reads them from when the peer is reachable.
    self.postMessage({ index: msg.index, h, cid });
  } catch (err) {
    // The message crosses rather than the error, for the same reason the staging
    // worker sends one: an Error carrying a DOMException name is not clonable
    // everywhere.
    self.postMessage({ index: msg.index, error: String(err?.message || err) });
  }
});
