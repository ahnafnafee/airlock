// The one place chunks are written to disk. createSyncAccessHandle is callable
// only from a dedicated worker global scope, and it is the only write path that
// exists on Safari before 26.0, so every staged byte in the app arrives through
// this file.
//
// The protocol is one message per chunk carrying a ticket, and one reply per
// ticket carrying either nothing or an error message. Tickets rather than order
// because several writes may be in flight and replies are not promised in the
// order the writes were posted.

import { stageDir } from './staging.js';

async function put(transferId, index, bytes) {
  // The directory is resolved per write rather than held, because a stage
  // cleared between two writes would leave a cached handle naming a directory
  // that no longer exists, and the write would land nowhere.
  const dir = await stageDir(transferId);
  const handle = await dir.getFileHandle(String(index), { create: true });
  // The spec permits one open sync handle per file at a time, so the handle is
  // opened and closed around each write rather than held, since chunks are
  // separate files and several may be written concurrently.
  const access = await handle.createSyncAccessHandle();
  try {
    access.write(bytes, { at: 0 });
    // A rewrite of an index whose file was left longer by an interrupted
    // earlier write would otherwise keep the stale tail and read back as a
    // chunk that is not the one written.
    access.truncate(bytes.byteLength);
    access.flush();
  } finally {
    access.close();
  }
}

self.addEventListener('message', async (event) => {
  const { ticket, transfer, index, bytes } = event.data || {};
  try {
    await put(transfer, index, bytes);
    self.postMessage({ ticket });
  } catch (err) {
    // The message crosses rather than the error, because what a failed write
    // owes the page is a reason, and an Error carrying a DOMException name is
    // not clonable everywhere.
    self.postMessage({ ticket, error: String(err?.message || err) });
  }
});
