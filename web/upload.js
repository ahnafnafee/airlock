import { chunkFile } from './cdc.js';
import {
  DOMAIN, chunkIdentity, hex, sealChunk, sealRecord, packHashes,
} from './crypto.js';
import { sealPool, poolSize } from './sealpool.js';
import { makeThumbnail } from './thumb.js';

// A file leaves this device one of two ways, and which one is the owner's choice
// per transfer. queueForDelivery is the default: the sealed chunks stay on this
// device's own disk and cross directly to the recipient when both are next
// online. uploadThroughServer is the exception, taken when the sender would
// rather not have to be reachable again.
//
// The direct path reads the file once, sealing and staging as it cuts. The
// server path reads it twice: pass one computes every chunk id and throws the
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

// A transfer must name at least one chunk. The server enforces that too, but it
// reports the refusal as a storage quota failure, which says nothing true about
// a zero-byte file. Refused here so the reason reaching the caption is the
// actual one.
// ponytail: empty files cannot be sent at all. The ceiling is the server rule
// that a transfer names at least one chunk; lifting it means letting the create
// path accept an empty chunk list and teaching the receiving side to rebuild a
// zero-byte file from an empty chunk list.
function checkNotEmpty(count) {
  if (count === 0) throw new Error('an empty file has no chunks to send');
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
  return { cids, hashes };
}

// Everything the server path does before a sealed chunk has anywhere to go: name
// every chunk, create the transfer, and check the id the server answered with.
// The sealed records are written by the caller rather than here, so the first
// progress report lands before those round trips instead of after them.
async function begin(file, opts) {
  const { mk, mode, to, cdc, api } = opts;

  const ids = [];
  for await (const plain of chunkFile(file, cdc)) {
    ids.push(await chunkIdentity(mk, mode, plain));
  }

  checkNotEmpty(ids.length);

  const { id, missing } = await api.createTransfer(ids.map((x) => x.cid), to);
  return { ids, id: checkTransferId(id), missing };
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

  await uploadRecords(api, mk, mode, id, file, ids.map((x) => x.h));

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

  return progress;
}

// The default. The sealed chunks go to this device's own staging area, and the
// server is told only what the transfer is made of: who it is for, which chunk
// ids, and the sealed records the recipient needs to make sense of them. Not one
// byte of content reaches it.
//
// The chunks are staged first and the transfer is created once they are all
// down, which is the only order available: a transfer is named by its chunk ids
// and those come from the same pass that seals them. It is also the safer order,
// because a preparation that fails part way is a transfer the server was never
// told about rather than one sitting on the queue with holes in its stage.
//
// The transfer joins the server's queue the moment it is created, so what is
// written here is what the direct session reads back when the recipient is
// reachable, whether that is a second later or after this page has been closed
// and reopened.
export async function queueForDelivery(file, opts) {
  const {
    mk, mode, to, cdc, api, openStage, newPool, onProgress = () => {},
  } = opts;

  const stageId = newStageId();
  const stage = await openStage(stageId);

  // Nothing is held and nothing is in flight. Held means a chunk the recipient
  // already has, and no recipient has been asked yet: the dedup question is put
  // to the peer over the wire when the session runs, never to the server, which
  // is not the recipient and has no say in what this device must be able to hand
  // over itself. Nothing is in flight either, because sealing onto this device's
  // own disk is not a chunk in transit and must never paint as one.
  //
  // The total is unknown until the file has been cut, which is the price of
  // cutting and sealing in the same pass, so it stays zero until it is known.
  const progress = { id: null, total: 0, held: 0, sent: 0, inflight: 0 };

  // Every position is staged, including the repeats. The peer asks for chunk 7
  // of this transfer by position, so a file that repeats a chunk has to answer
  // for each place it appears, and a position left empty because some other
  // transfer happened to hold that id is a chunk this device could never hand
  // over.
  let cids;
  let hashes;
  try {
    ({ cids, hashes } = await prepare(file, {
      mk,
      mode,
      cdc,
      stageId,
      newPool,
      onProgress: (sealed) => {
        progress.sent = sealed;
        onProgress({ ...progress });
      },
    }));
    checkNotEmpty(cids.length);
  } catch (err) {
    // Nothing has reached the server yet, so there is no transfer to take back
    // down, but the chunks that did land have nothing that will ever read them.
    // Best effort, because the reason the caller needs is the original one.
    await stage.clear().catch(() => {});
    throw err;
  }

  progress.total = cids.length;
  onProgress({ ...progress });

  try {
    const { id } = await api.createTransfer(cids, to);
    progress.id = checkTransferId(id);
    await uploadRecords(api, mk, mode, id, file, hashes, stageId);
  } catch (err) {
    // From here on a transfer may exist on the queue whose records are missing,
    // and every later drain would offer it and fail. Undone so a failure here is
    // a transfer that simply did not send. A transfer whose id came back
    // malformed is the one that cannot be, because deleting it would mean
    // building a URL out of the very string that was refused.
    if (progress.id) await api.deleteTransfer(progress.id).catch(() => {});
    await stage.clear().catch(() => {});
    throw err;
  }

  return progress;
}

async function uploadRecords(api, mk, mode, id, file, hashes, stage = null) {
  const meta = await sealRecord(mk, mode, DOMAIN.META, id, enc(JSON.stringify({
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    // Where this device staged the sealed chunks, on the direct path only. The
    // chunks are written before the transfer exists, so the directory cannot be
    // named by the transfer's id, and this is what lets the sender find them
    // again after a reload. It rides in the sealed record rather than in a
    // second store, so it lasts exactly as long as the transfer does and the
    // server never learns it. The recipient has no use for it and ignores it.
    ...(stage ? { stage } : {}),
  })));
  await withRetry(() => api.putRecord(id, 'meta', meta));

  const list = await sealRecord(mk, mode, DOMAIN.LIST, id, packHashes(hashes));
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
