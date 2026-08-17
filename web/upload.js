import { chunkFile } from './cdc.js';
import {
  DOMAIN, chunkIdentity, hex, sealChunk, sealRecord, packHashes,
} from './crypto.js';
import { sealPool, poolSize } from './sealpool.js';
import { makeThumbnail } from './thumb.js';

// A file leaves this device one way: sealed here, then uploaded. What the server
// is handed is ciphertext and a list of opaque ids, and there is nothing else it
// can do with either.
//
// It reads the file twice. Pass one computes every chunk id and throws the
// bytes away, and only then can it ask which of them the server lacks, which is
// the question that decides what pass two seals and sends. Keeping pass one's
// bytes to avoid the second read would mean holding the whole file in memory,
// which fails at exactly the sizes this product exists for. Re-reading from disk
// is far cheaper than the wire, and chunking is deterministic so the second pass
// cuts at identical boundaries.

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

function checkTransferId(id) {
  if (!TRANSFER_ID.test(id || '')) {
    throw new Error('the server returned a malformed transfer id');
  }
  return id;
}

// The staging directory is named by an id minted here rather than by the
// transfer's, because the sealed chunks are written before the transfer exists:
// the ids that name a transfer come from the same pass that seals them. The
// sealed metadata carries this name, which is how the sender finds the chunks
// again after the page has been closed and reopened.
//
// ponytail: an id minted here is unreachable if the page dies before the sealed
// record that carries it is written. The ceiling is that a preparation
// interrupted after the first chunk has been staged and before the record goes
// up leaves a directory whose name nothing else records, so no later sweep can
// tell it from a live one. Lifting it means noting the id durably on this
// device before the first chunk is written and clearing that note once the
// record is up, which is what would let a sweep tell an abandoned preparation
// from one still running.
const newStageId = () => hex(crypto.getRandomValues(new Uint8Array(16)));

const workerPool = () => sealPool(poolSize(), () => new Worker(
  new URL('./seal-worker.js', import.meta.url), { type: 'module' }));

// prepare makes one pass over the file. Chunks are cut on this thread, sealed by
// the pool, and written straight into staging by the worker that sealed them,
// which is where the sender reads them from when the peer is reachable. Naming
// every chunk in one pass and sealing in a second was a second full read of a
// file that may be twenty gigabytes, for nothing.
export async function prepare(file, {
  mk, mode, cdc, stageId, newPool = workerPool, onProgress = () => {},
}) {
  const pool = newPool();
  const cids = [];
  const hashes = [];
  // A chunk's plaintext length, at its position. Content defined chunks are not
  // equal, so this is what lets the strip draw each one at the width it really
  // occupies and lets a ruler put a byte offset under the right segment.
  const sizes = [];
  // Bounded rather than awaited only at the end. Awaiting at the end would queue
  // every chunk of the file, which is the memory the streaming chunker exists to
  // avoid. One more than the pool holds, so a worker that finishes has the next
  // chunk waiting rather than idling while this thread reads and cuts it, at a
  // cost of one chunk of memory.
  const limit = Math.max(1, pool.size || 1) + 1;
  const pending = new Set();
  let sealed = 0;
  let index = 0;

  try {
    await pool.init(mk, mode, stageId);
    for await (const plain of chunkFile(file, cdc)) {
      const i = index++;
      sizes[i] = plain.length;
      const p = pool.seal(i, plain).then((r) => {
        cids[r.index] = r.cid;
        hashes[r.index] = r.h;
        // Counted as chunks land rather than reported as the index that landed,
        // because completion order is not submission order and a count that
        // went backwards would paint the strip backwards.
        onProgress(++sealed);
      }).finally(() => pending.delete(p));
      // The race and the all below both handle every member of the set, but a
      // chunk that fails while the loop is between them has nothing waiting on
      // it and would surface as an unhandled rejection rather than as the
      // failure it is.
      p.catch(() => {});
      pending.add(p);
      if (pending.size >= limit) await Promise.race(pending);
    }
    await Promise.all(pending);
  } finally {
    // Including on the way out of a failure: a pool left open is a set of
    // workers holding chunks for a transfer that is not happening.
    pool.close();
  }
  return { cids, hashes, sizes };
}

// Everything the server path does before a sealed chunk has anywhere to go: name
// every chunk, create the transfer, and check the id the server answered with.
// The sealed records are written by the caller rather than here, so the first
// progress report lands before those round trips instead of after them.
async function begin(file, opts) {
  const { mk, mode, to, cdc, api } = opts;

  const ids = [];
  const sizes = [];
  for await (const plain of chunkFile(file, cdc)) {
    sizes.push(plain.length);
    ids.push(await chunkIdentity(mk, mode, plain));
  }

  const { id, missing } = await api.createTransfer(ids.map((x) => x.cid), to, true);
  return { ids, sizes, id: checkTransferId(id), missing };
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

  const { ids, sizes, id, missing } = await begin(file, opts);
  try {
    const wanted = new Set(missing);

    const progress = {
      id,
      total: ids.length,
      // The widths the segments should have, so the strip stops implying that
      // every chunk is the same size.
      sizes,
      // Counted over positions rather than as ids.length minus the missing set.
      // A file can hold the same chunk many times, and a repeat the server lacks
      // is not a dedup hit: subtracting a de-duplicated set size would report a
      // first upload of a mostly-empty disk image as almost entirely held.
      held: ids.filter((x) => !wanted.has(x.cid)).length,
      // Where those chunks sit, not just how many there are. The strip is a row
      // in file order, so a reader takes a segment's place in it as that chunk's
      // place in the file. Painting the held ones as a block from the start would
      // report a file whose middle changed as one whose tail did, which is the
      // one thing about a delta the strip is uniquely able to show.
      heldAt: ids.map((x, i) => (wanted.has(x.cid) ? -1 : i)).filter((i) => i >= 0),
      storedAt: [],
      inflightAt: [],
      sent: 0,
      // How many chunks are on the wire right this instant. The strip paints that
      // window amber, and amber means in transit and nothing else, so the count
      // has to come from the uploader rather than be guessed from CONCURRENCY.
      inflight: 0,
    };
    // Report before uploading anything, so a re-send reads as an immediate wave of
    // already-held chunks rather than a stalled bar.
    onProgress({ ...progress });

    if (wanted.size > 0) {
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
        const at = index - 1;
        progress.inflight++;
        progress.inflightAt.push(at);
        onProgress({ ...progress, inflightAt: [...progress.inflightAt], storedAt: [...progress.storedAt] });
        const p = withRetry(() => api.putChunk(cid, id, sealed))
          .then(() => { progress.sent++; progress.storedAt.push(at); })
          .finally(() => {
            inflight.delete(p);
            progress.inflight--;
            progress.inflightAt = progress.inflightAt.filter((i) => i !== at);
            onProgress({ ...progress, inflightAt: [...progress.inflightAt], storedAt: [...progress.storedAt] });
          });
        inflight.add(p);
        if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
      }
      await Promise.all(inflight);
    }

    // Metadata is the announcement trigger. Publish it only after every held
    // chunk and supporting record is ready, so the first Inbox repaint can save.
    await uploadRecords(api, mk, mode, id, file, ids.map((x) => x.h));

    return progress;
  } catch (err) {
    // begin returned a validated id, so every failure from here leaves a real
    // partial transfer behind. Deletion is best effort and may fail for the
    // same network reason as the upload; neither outcome replaces the error
    // that actually stopped the send.
    await api.deleteTransfer(id).catch(() => {});
    throw err;
  }
}

async function uploadRecords(api, mk, mode, id, file, hashes) {
  const meta = await sealRecord(mk, mode, DOMAIN.META, id, enc(JSON.stringify({
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
  })));
  const list = await sealRecord(mk, mode, DOMAIN.LIST, id, packHashes(hashes));

  // The server can never make this: it has never seen the image. A transfer
  // that is not an image or a video simply carries no thumb record.
  const thumb = await makeThumbnail(file);
  const sealedThumb = thumb
    ? await sealRecord(mk, mode, DOMAIN.THUMB, id, thumb)
    : null;

  // Meta lands last because it is the announcement trigger. At that instant the
  // chunk list, the optional thumbnail and every content chunk are already
  // readable, so the first Inbox repaint after it can offer a save.
  await withRetry(() => api.putRecord(id, 'chunklist', list));
  if (sealedThumb) {
    // A thumbnail is a nicety. Losing it must never fail the transfer.
    await withRetry(() => api.putRecord(id, 'thumb', sealedThumb)).catch(() => {});
  }
  await withRetry(() => api.putRecord(id, 'meta', meta));
}
