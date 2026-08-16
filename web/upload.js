import { chunkFile } from './cdc.js';
import {
  DOMAIN, chunkIdentity, sealChunk, sealRecord, packHashes,
} from './crypto.js';

// Four in flight. Measured guidance puts a 110 MB upload at roughly 22 seconds
// sequential and 12 seconds at three, with little left to win past four. Peak
// buffered memory is this many times the maximum chunk size, which is why the
// server keeps that maximum modest.
const CONCURRENCY = 4;
const RETRIES = 4;

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

// upload runs two passes over the file.
//
// Pass one computes every chunk id and throws the bytes away, so memory stays
// flat regardless of file size. One call then asks the server which of those ids
// it lacks. Pass two re-reads the file and uploads only those.
//
// Keeping pass one's bytes to avoid the second read would mean holding the whole
// file in memory, which fails at exactly the sizes this product exists for.
// Re-reading from disk is far cheaper than uploading, and chunking is
// deterministic so the second pass cuts at identical boundaries.
export async function upload(file, opts) {
  const { mk, mode, to, cdc, api, onProgress = () => {} } = opts;

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
  // Every id is checked before it reaches a URL, on both sides of the wire. The
  // server is not hostile, but a malformed id here would build a path by string
  // interpolation and the failure would surface as a confusing 404 rather than
  // as the wrong answer it is.
  if (!/^[0-9a-f]{32}$/.test(id || '')) {
    throw new Error('the server returned a malformed transfer id');
  }
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

async function uploadRecords(api, mk, mode, id, file, ids) {
  const meta = await sealRecord(mk, mode, DOMAIN.META, id, enc(JSON.stringify({
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
  })));
  await withRetry(() => api.putRecord(id, 'meta', meta));

  const list = await sealRecord(mk, mode, DOMAIN.LIST, id, packHashes(ids.map((x) => x.h)));
  await withRetry(() => api.putRecord(id, 'chunklist', list));
}
