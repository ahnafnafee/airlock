// Turning a transfer the server holds back into a file on this device.
//
// Everything moves through the server. That is the whole delivery model: a
// sender seals its chunks and uploads them, and a recipient reads them back and
// opens them. Nothing here is a fallback for a faster path, because there is no
// faster path. The one that existed, peer to peer over WebRTC, was removed
// after measurement: it ran at roughly a quarter of the throughput of the
// server path, needed both devices awake and reachable at the same instant, and
// spent its effort rediscovering an address the tailnet had already assigned.
//
// The server is not trusted with any of this. Chunks arrive sealed, the chunk
// list that keys them to their positions is sealed, and the name and size are
// sealed. What the server holds is ciphertext and an ordering of opaque ids.

import { api } from './api.js';
import {
  DOMAIN, MODE_SEALED, modeOf, openRecord, unpackHashes, loadMaster, b64decode,
} from './crypto.js';
import { assembledFile } from './assemble.js';

// Checked before either reaches a URL.
const TRANSFER_ID = /^[0-9a-f]{32}$/;
const CHUNK_ID = /^[0-9a-f]{64}$/;

// A list the server has never had a reason to allocate arrives as null rather
// than as an empty array, which is what a transfer nobody has declined looks
// like on the wire. Normalized once here, so no later line has to remember.
const listOf = (value) => (Array.isArray(value) ? value : []);

// The mode byte decides whether a record is authenticated at all. An unsealed
// one names the file whatever its writer chose, and that name is what a save
// writes into the operating system.
async function openMeta(mk, info) {
  const record = b64decode(info.meta);
  if (modeOf(record) !== MODE_SEALED) throw new Error('this transfer is not sealed');
  return JSON.parse(new TextDecoder().decode(
    await openRecord(mk, DOMAIN.META, info.id, record)));
}

// Assembly runs off the page thread because it holds a sync access handle, which
// only a worker may open, and because decrypting gigabytes on the thread drawing
// the interface makes the whole app stop.
const spawnAssembler = () => new Worker(
  new URL('./assemble-worker.js', import.meta.url), { type: 'module' });

// Decrypt a transfer into a single disk-backed file. Every chunk comes from the
// server, so this is an action that can be retried as often as it takes: nothing
// it reads is consumed, and a failed attempt leaves the transfer exactly as it
// found it.
export async function assembleTransfer(transferId, {
  spawn = spawnAssembler, meta: known = null, onPercent = null,
} = {}) {
  if (!TRANSFER_ID.test(transferId || '')) {
    throw new Error('a malformed transfer id has nothing to assemble');
  }

  // Before anything else, and before any network. A save picker and a share
  // sheet both need the user gesture the click carried, and a gesture does not
  // survive an unbounded wait: two tailnet round trips and a worker spawn ahead
  // of the picker is how a second Save on an already-assembled file loses the
  // very gesture it was supposed to still have. The caller passes the metadata
  // it already decrypted for the row, so the common case reaches the operating
  // system having awaited one directory lookup.
  if (known) {
    const ready = await assembledFile(transferId, known);
    if (ready) return ready;
  }

  const mk = await loadMaster();
  if (!mk) throw new Error('Locked. Unlock this device first.');

  const info = await api.transfer(transferId);
  const meta = known || await openMeta(mk, info);

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

  const worker = spawn();
  try {
    return await new Promise((resolve, reject) => {
      // A worker that failed to load or died mid assembly would otherwise leave
      // this waiting on a reply that is never coming, and a save that never
      // settles is a button that never comes back.
      const lost = () => reject(new Error('the assembly worker stopped'));
      // Not a one-shot listener: the worker reports how far it has got before it
      // reports the file, and only the last of those messages settles this.
      worker.addEventListener('message', (event) => {
        const { file, error, percent, done, total } = event.data || {};
        if (percent !== undefined) {
          onPercent?.(percent, done, total);
          return;
        }
        if (error) reject(new Error(error));
        else resolve(file);
      });
      worker.addEventListener('error', lost, { once: true });
      worker.addEventListener('messageerror', lost, { once: true });
      // Nothing is consumed and every chunk is replaceable, because the server
      // holds all of them: a chunk read into the output can be dropped at once,
      // which keeps peak disk at the file plus one chunk rather than at twice
      // the file.
      worker.postMessage({
        transfer: transferId, meta, hashes, cids, consume: false, replaceable: true,
      });
    });
  } finally {
    // One job per worker. Terminating with the job is what keeps a save from
    // leaving a thread and an open directory handle behind for the life of the
    // page.
    worker.terminate();
  }
}
