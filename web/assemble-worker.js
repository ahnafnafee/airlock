// The worker one assembly runs in. It exists because createSyncAccessHandle is
// callable only from a dedicated worker global scope, and because Safari shipped
// no other way to write into the origin private file system before 26.0, so one
// write path serves every browser.
//
// It is its own worker rather than the staging one for a reason that only shows
// up on a large file: assembling reads and decrypts every chunk of a transfer,
// which runs for minutes on a multi-gigabyte file, and the staging worker is the
// thing incoming chunks are written through. Sharing would hold up a live
// receive behind a save.
//
// The protocol is one message in and one reply out, carrying either the
// assembled File or the reason there is none. The page spawns a worker per save
// and tears it down after, so there are no tickets to match.

import { assemble, assembledFile, chunkSource } from './assemble.js';
import { stageDir } from './staging.js';
import { MODE_SEALED, loadMaster } from './crypto.js';

const TRANSFER_ID = /^[0-9a-f]{32}$/;
const CHUNK_ID = /^[0-9a-f]{64}$/;

// A chunk the stage does not hold comes from the server. The id is checked
// before it reaches a URL, because the server chose it.
async function fetchChunk(cid) {
  if (!CHUNK_ID.test(cid || '')) throw new Error('the server named a malformed chunk id');
  const res = await fetch(`/api/chunk/${cid}`);
  if (!res.ok) throw new Error(`the server answered ${res.status} for a chunk`);
  return new Uint8Array(await res.arrayBuffer());
}

self.addEventListener('message', async (event) => {
  const { transfer, meta, hashes, cids, consume, replaceable } = event.data || {};
  try {
    // Checked again on this side of the message, because a path is built from it
    // here as well as there.
    if (!TRANSFER_ID.test(transfer || '')) {
      throw new Error('a malformed transfer id has nothing to assemble');
    }
    const mk = await loadMaster();
    // Chunks arrive sealed and are opened here, so an assembly on a locked
    // device would write a file of ciphertext. It refuses instead.
    if (!mk) throw new Error('Locked. Unlock this device first.');

    // A save that has already assembled reuses what is on disk. It has to: the
    // staged chunks were consumed by the first pass, and the gesture a share
    // sheet needs is exactly what a first pass on a large file spends.
    const existing = await assembledFile(transfer, meta);
    if (existing) {
      self.postMessage({ file: existing });
      return;
    }

    // ponytail: resolving the stage creates its directory, so a transfer that
    // never arrived peer to peer leaves an empty one behind on every save from
    // the server. The ceiling is one directory entry per such save, and it is
    // the ceiling staging.js already names: nothing sweeps stages. Lift it with
    // that sweep rather than with a second, non-creating way to name a stage,
    // which would put the path this device builds in two places.
    const stage = chunkSource(await stageDir(transfer), cids, { fetchChunk, consume, replaceable });
    // The mode is a constant rather than anything that crossed a wire. Every
    // record this transfer rests on was required to be sealed before its Save
    // was offered, and a plaintext chunk carries no tag to verify.
    // A save on a large file runs for minutes, and a button that only greys out
    // is indistinguishable from one that did nothing. Progress crosses as whole
    // percents: a fifty gigabyte transfer is tens of thousands of chunks, and a
    // message per chunk would spend more effort narrating the work than doing
    // it, while a hundred messages is the most a person can read anyway.
    let said = -1;
    const onChunk = (done, total) => {
      const percent = Math.floor((done * 100) / total);
      if (percent === said) return;
      said = percent;
      self.postMessage({ percent });
    };
    const file = await assemble(transfer, meta, {
      mk, mode: MODE_SEALED, hashes, cids, stage, onChunk,
    });
    self.postMessage({ file });
  } catch (err) {
    // The message crosses rather than the error, for the reason the staging
    // worker gives: an Error carrying a DOMException name is not clonable
    // everywhere.
    self.postMessage({ error: String(err?.message || err) });
  }
});
