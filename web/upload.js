import { chunkFile } from './cdc.js';
import {
  DOMAIN, chunkIdentity, sealChunk, sealRecord, packHashes,
} from './crypto.js';
import { makeThumbnail } from './thumb.js';

// A file leaves this device one of two ways, and which one is the owner's choice
// per transfer. queueForDelivery is the default: the sealed chunks stay on this
// device's own disk and cross directly to the recipient when both are next
// online. uploadThroughServer is the exception, taken when the sender would
// rather not have to be reachable again.
//
// Both run two passes over the file. Pass one computes every chunk id and throws
// the bytes away, so memory stays flat regardless of file size. Pass two
// re-reads the file and seals what has to move. Keeping pass one's bytes to
// avoid the second read would mean holding the whole file in memory, which fails
// at exactly the sizes this product exists for. Re-reading from disk is far
// cheaper than either destination, and chunking is deterministic so the second
// pass cuts at identical boundaries.

// Four in flight. Measured guidance puts a 110 MB upload at roughly 22 seconds
// sequential and 12 seconds at three, with little left to win past four. Peak
// buffered memory is this many times the maximum chunk size, which is why the
// server keeps that maximum modest.
const CONCURRENCY = 4;
const RETRIES = 4;

// Every id is checked before it reaches a URL or a directory name, on both sides
// of the wire. The server is not hostile, but a malformed id here would build a
// path by string interpolation and the failure would surface as a confusing 404
// rather than as the wrong answer it is.
const TRANSFER_ID = /^[0-9a-f]{32}$/;

const enc = (s) => new TextEncoder().encode(s);

// Bounded retry with backoff. This is the whole resume-across-a-dropped-
// connection story: chunk writes are idempotent server-side, so replaying one
// is always safe.
async function withRetry(fn) {
  let delay = 400;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// Everything both paths do before a sealed chunk has anywhere to go: name every
// chunk, create the transfer, and check the id the server answered with. The
// sealed records are written by the caller rather than here, so the first
// progress report lands before those round trips instead of after them.
async function begin(file, opts) {
  const { mk, mode, to, cdc, api } = opts;

  const ids = [];
  for await (const plain of chunkFile(file, cdc)) {
    ids.push(await chunkIdentity(mk, mode, plain));
  }

  // A transfer must name at least one chunk. The server enforces that too, but
  // it reports the refusal as a storage quota failure, which says nothing true
  // about a zero-byte file. Refuse here so the reason reaching the caption is
  // the actual one.
  // ponytail: empty files cannot be sent at all. The ceiling is the server rule
  // that a transfer names at least one chunk; lifting it means letting the
  // create path accept an empty chunk list and teaching the receiving side to
  // rebuild a zero-byte file from an empty chunk list.
  if (ids.length === 0) {
    throw new Error('an empty file has no chunks to send');
  }

  const { id, missing } = await api.createTransfer(ids.map((x) => x.cid), to);
  if (!TRANSFER_ID.test(id || '')) {
    throw new Error('the server returned a malformed transfer id');
  }
  return { ids, id, missing };
}

// The exception, chosen per transfer. The sealed chunks are spooled to the
// server, so the transfer finishes even if this device is never reachable
// again. It is the only path by which content reaches the server, and even then
// it is ciphertext under a key the server does not hold.
//
// It asks the server which ids it lacks and uploads only those, which is dedup,
// delta sync and resume in one question.
export async function uploadThroughServer(file, opts) {
  const { mk, mode, cdc, api, onProgress = () => {} } = opts;

  const { ids, id, missing } = await begin(file, opts);
  const wanted = new Set(missing);

  const progress = {
    id,
    total: ids.length,
    // Counted over positions rather than as ids.length minus the missing set.
    // A file can hold the same chunk many times, and a repeat the server lacks
    // is not a dedup hit: subtracting a de-duplicated set size would report a
    // first upload of a mostly-empty disk image as almost entirely held.
    held: ids.filter((x) => !wanted.has(x.cid)).length,
    sent: 0,
    // How many chunks are on the wire right this instant. The strip paints that
    // window amber, and amber means in transit and nothing else, so the count
    // has to come from the uploader rather than be guessed from CONCURRENCY.
    inflight: 0,
  };
  // Report before uploading anything, so a re-send reads as an immediate wave of
  // already-held chunks rather than a stalled bar.
  onProgress({ ...progress });

  await uploadRecords(api, mk, mode, id, file, ids);

  if (wanted.size === 0) return progress;

  const inflight = new Set();
  let index = 0;
  for await (const plain of chunkFile(file, cdc)) {
    const { h, cid } = ids[index++];
    if (!wanted.has(cid)) continue;
    // Claim it, so a chunk that occurs several times in one file goes up once.
    wanted.delete(cid);

    const sealed = await sealChunk(mk, mode, h, cid, plain);
    // Reported on entry as well as on completion, so the strip can light the
    // window that is actually moving instead of only the one that has landed.
    progress.inflight++;
    onProgress({ ...progress });
    const p = withRetry(() => api.putChunk(cid, id, sealed))
      .then(() => { progress.sent++; })
      .finally(() => {
        inflight.delete(p);
        progress.inflight--;
        onProgress({ ...progress });
      });
    inflight.add(p);
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
  }
  await Promise.all(inflight);

  return progress;
}

// The default. The sealed chunks go to this device's own staging area, and the
// server is told only what the transfer is made of: who it is for, which chunk
// ids, and the sealed records the recipient needs to make sense of them. Not one
// byte of content reaches it.
//
// The transfer joins the server's queue the moment it is created, so what is
// written here is what the direct session reads back when the recipient is
// reachable, whether that is a second later or after this page has been closed
// and reopened.
export async function queueForDelivery(file, opts) {
  const { mk, mode, cdc, api, openStage, onProgress = () => {} } = opts;

  const { ids, id } = await begin(file, opts);

  // Nothing is held and nothing is in flight. Held means a chunk the recipient
  // already has, and no recipient has been asked yet: the dedup question is put
  // to the peer over the wire when the session runs, never to the server, which
  // is not the recipient and has no say in what this device must be able to hand
  // over itself.
  const progress = { id, total: ids.length, held: 0, sent: 0, inflight: 0 };
  onProgress({ ...progress });

  await uploadRecords(api, mk, mode, id, file, ids);

  const stage = await openStage(id);
  let index = 0;
  for await (const plain of chunkFile(file, cdc)) {
    const { h, cid } = ids[index];
    // Written under its position, not its id, and every position is written.
    // The peer asks for chunk 7 of this transfer by position, so a file that
    // repeats a chunk has to answer for each place it appears, and a position
    // left empty because the server happened to hold that id is a chunk this
    // device could never hand over.
    await stage.put(index, await sealChunk(mk, mode, h, cid, plain));
    progress.sent = ++index;
    onProgress({ ...progress });
  }

  return progress;
}

async function uploadRecords(api, mk, mode, id, file, ids) {
  const meta = await sealRecord(mk, mode, DOMAIN.META, id, enc(JSON.stringify({
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
  })));
  await withRetry(() => api.putRecord(id, 'meta', meta));

  const list = await sealRecord(mk, mode, DOMAIN.LIST, id, packHashes(ids.map((x) => x.h)));
  await withRetry(() => api.putRecord(id, 'chunklist', list));

  // The server can never make this: it has never seen the image. A transfer
  // that is not an image or a video simply carries no thumb record.
  const thumb = await makeThumbnail(file);
  if (thumb) {
    const sealed = await sealRecord(mk, mode, DOMAIN.THUMB, id, thumb);
    // A thumbnail is a nicety. Losing it must never fail the transfer.
    await withRetry(() => api.putRecord(id, 'thumb', sealed)).catch(() => {});
  }
}
