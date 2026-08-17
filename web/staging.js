// Sealed chunks wait here between sessions. A browser loses its File handle when
// the page closes, so without persistent local storage a queued transfer would
// have nothing left to send and a half-received one nothing to resume from.
//
// This is the owner's own disk. It is what turns "both devices must be online at
// once" into "both devices must be online at some point".

const TRANSFER_ID = /^[0-9a-f]{32}$/;

// A staged chunk is named by its position and nothing else. Number() would take
// '0x10' for 16, '1e3' for 1000 and ' 5' for 5, so the name a reader accepts is
// spelled out rather than parsed: exactly the digits String(index) produces, no
// sign, no leading zero, no other notation.
const CHUNK_NAME = /^(?:0|[1-9][0-9]*)$/;
const CHUNK_ID = /^[0-9a-f]{64}$/;
const CID_LIST = 'cids';

// A chunk file exists from the moment the write starts, so its existence says
// only that a write began. This mark is what says one finished. It goes down
// before the first byte and is removed after the flush, which makes its absence
// the commit and makes presence mean whole bytes: a write cut short by a closed
// tab, a sleeping device or a full disk leaves the mark behind, and every reader
// treats that index as missing until the chunk is written again.
//
// The suffix keeps it out of the index namespace, so a leftover mark is never
// itself counted as a chunk.
const MARK = '.part';
const markOf = (index) => `${index}${MARK}`;

export function bitmapOf(indexes, count) {
  const out = new Uint8Array((count + 7) >> 3);
  for (const i of indexes) {
    // The final byte has spare bits, so an index just past the count is still
    // in range of the array and would otherwise be written silently.
    if (i >= 0 && i < count) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

export function indexesFrom(bitmap, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    // Bounded by count, not by the bitmap's length: the final byte has spare
    // bits and a peer setting them must not invent chunks.
    if (bitmap[i >> 3] & (1 << (i & 7))) out.push(i);
  }
  return out;
}

// Every id is checked before it becomes a directory name. A malformed one would
// build a path by string interpolation, and the failure would surface as a
// confusing storage error rather than as the wrong answer it is.
function checkedId(transferId) {
  if (!TRANSFER_ID.test(transferId || '')) {
    throw new Error('a malformed transfer id has no staging directory');
  }
  return transferId;
}

async function stagingRoot(root = null) {
  const base = root || await navigator.storage.getDirectory();
  return base.getDirectoryHandle('staging', { create: true });
}

// Exported for the staging worker, which resolves the same directory from the
// other side of the message protocol below.
export async function stageDir(transferId) {
  const staging = await stagingRoot();
  return staging.getDirectoryHandle(checkedId(transferId), { create: true });
}

// The one place a chunk reaches disk. Both workers that stage bytes call it: the
// one the page posts received chunks to, and the seal workers, which write the
// chunk they have just sealed rather than sending it back to be written
// somewhere else.
//
// createSyncAccessHandle is callable only from a dedicated worker global scope,
// so this throws on the page. That is not only a performance choice: Safari did
// not ship createWritable until 26.0, so on any earlier iOS the sync handle is
// the only way to write into the origin private file system at all, which is why
// one write path serves every browser.
export async function writeStaged(transferId, index, bytes) {
  // The directory is resolved per write rather than held, because a stage
  // cleared between two writes would leave a cached handle naming a directory
  // that no longer exists, and the write would land nowhere.
  const dir = await stageDir(transferId);
  // Before any byte, so there is no moment in which a chunk file is short and
  // nothing on disk says so. A rewrite of an index that was already whole marks
  // it unheld for the length of the rewrite, which is the honest answer while
  // the bytes under it are being replaced.
  await dir.getFileHandle(markOf(index), { create: true });
  const handle = await dir.getFileHandle(String(index), { create: true });
  // The spec permits one open sync handle per file at a time, so the handle is
  // opened and closed around each write rather than held, since chunks are
  // separate files and several may be written concurrently.
  const access = await handle.createSyncAccessHandle();
  try {
    access.write(bytes, { at: 0 });
    // A rewrite of an index whose file was left longer by an interrupted earlier
    // write would otherwise keep the stale tail and read back as a chunk that is
    // not the one written.
    access.truncate(bytes.byteLength);
    access.flush();
  } finally {
    access.close();
  }
  // The commit. It follows the flush, so a reader that finds no mark is reading
  // bytes the file system has already been told to keep. A write that threw
  // above never reaches this and leaves its index unheld, which is what makes a
  // failed write indistinguishable from one that never happened.
  //
  // ponytail: the mark is a directory entry, not a barrier, so an engine free to
  // reorder its removal ahead of the chunk's own flush could still call a short
  // chunk whole. The ceiling is that this API surface offers no way to order two
  // file system operations more tightly than this. An atomic rename would
  // collapse them into one, and FileSystemFileHandle.move is that rename, but it
  // is absent from engines this has to run on, and standing in for it by copying
  // the finished file into place would write every chunk to disk twice.
  await dir.removeEntry(markOf(index));
}

// Writes leave this thread, because of the rule above. The page hands a chunk to
// the staging worker and waits for its reply.
//
// Reads stay here. getFile, keys and getFileHandle are callable from the page,
// so the sending half and the bitmap never pay for a round trip.
//
// The worker is taken as a factory so a test can drive the protocol without one.
export function makeWriter(spawn) {
  let worker = null;
  let nextTicket = 1;
  const pending = new Map();

  function running() {
    if (worker) return worker;
    worker = spawn();
    worker.addEventListener('message', (event) => {
      const { ticket, error, name } = event.data || {};
      const waiting = pending.get(ticket);
      // A reply to a write nobody is waiting on is not an error. It is a ticket
      // whose caller was already failed by a worker that has since recovered.
      if (!waiting) return;
      pending.delete(ticket);
      if (error) {
        const failure = new Error(error);
        // Put back on this side, because a DOMException does not survive the
        // message. A quota failure has to stay recognizable as one all the way
        // up to the session, which drops the partial stage on the strength of it.
        if (name) failure.name = name;
        waiting.reject(failure);
      } else waiting.resolve();
    });
    // A worker that failed to load or died mid write leaves every write waiting
    // on a reply that is never coming, and a caller that never settles is a
    // transfer that neither finishes nor records progress. Dropping the worker
    // here is also what lets the next write start a fresh one rather than queue
    // behind a dead one.
    const lost = () => {
      worker = null;
      const waiting = [...pending.values()];
      pending.clear();
      for (const { reject } of waiting) reject(new Error('the staging worker stopped'));
    };
    worker.addEventListener('error', lost);
    worker.addEventListener('messageerror', lost);
    return worker;
  }

  return (transfer, index, bytes) => new Promise((resolve, reject) => {
    const ticket = nextTicket++;
    pending.set(ticket, { resolve, reject });
    // The chunk's buffer is handed over rather than copied, which is what keeps
    // a multi-gigabyte transfer flat in memory. Only a view that owns its whole
    // buffer is transferred: detaching a buffer another view still reads from
    // would empty that view instead of costing a copy.
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    try {
      running().postMessage(
        { ticket, transfer, index, bytes }, whole ? [bytes.buffer] : []);
    } catch (err) {
      pending.delete(ticket);
      reject(err);
    }
  });
}

const write = makeWriter(() => new Worker(
  new URL('./stage-worker.js', import.meta.url), { type: 'module' }));

async function existsIn(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function committedBytes(dir, name) {
  if (!await existsIn(dir, name) || await existsIn(dir, markOf(name))) return null;
  const handle = await dir.getFileHandle(name);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

function checkedCids(cids) {
  if (!Array.isArray(cids) || !cids.every((cid) => CHUNK_ID.test(cid))) {
    throw new Error('a staging chunk list contains a malformed id');
  }
  return [...cids];
}

// Builds the stage opener around its writer. Production writes through the
// dedicated worker above; tests use the same OPFS implementation directly.
// Keeping that adapter at this seam lets every cache and ownership rule remain
// behind the ordinary stage interface.
export function makeStageOpener(writeBytes) {
  return async function open(transferId, cids = null) {
    const id = checkedId(transferId);
    const dir = await stageDir(id);
    const manifest = cids === null ? null : checkedCids(cids);

    // A receiver records the server-authenticated CID at each position before
    // answering the peer. The same commit mark chunks use makes a manifest left
    // half-written by a crash invisible to later transfers.
    if (manifest) {
      await writeBytes(id, CID_LIST,
        new TextEncoder().encode(JSON.stringify(manifest)));
    }

    // The write itself happens in the worker, which resolves this same directory
    // on its side. The id was checked by stageDir above and is checked again
    // there, because a path is built from it on both sides of the message.
    const put = (index, bytes) => writeBytes(id, index, bytes);

    const localHas = async (index) => {
      if (!CHUNK_NAME.test(String(index))) return false;
      if (!await existsIn(dir, String(index))) return false;
      // The file is there. Whether all of its bytes are is the question the mark
      // answers, and until it is gone the answer is no.
      return !await existsIn(dir, markOf(index));
    };

    let sources = null;
    const cachedSources = async () => {
      if (sources) return sources;
      sources = new Map();
      if (!manifest) return sources;

      const staging = await stagingRoot();
      for await (const otherId of staging.keys()) {
        if (otherId === id || !TRANSFER_ID.test(otherId)) continue;
        let other;
        try {
          other = await staging.getDirectoryHandle(otherId);
          const bytes = await committedBytes(other, CID_LIST);
          if (!bytes) continue;
          const otherCids = checkedCids(JSON.parse(new TextDecoder().decode(bytes)));
          for (let index = 0; index < otherCids.length; index++) {
            const entries = sources.get(otherCids[index]) || [];
            entries.push({ dir: other, index });
            sources.set(otherCids[index], entries);
          }
        } catch {
          // A sender stage has no manifest, and a stage being cleared may vanish
          // between listing and opening. Neither is a cached receiver chunk.
        }
      }
      return sources;
    };

    const has = async (index) => {
      if (!CHUNK_NAME.test(String(index))) return false;
      if (await localHas(index)) return true;
      if (!manifest || index >= manifest.length) return false;

      // Materialize the shared bytes into this transfer's own position before
      // answering held. That makes ownership explicit: either transfer may be
      // cleared immediately afterward without invalidating the other one.
      const candidates = (await cachedSources()).get(manifest[index]) || [];
      for (const candidate of candidates) {
        let bytes;
        try {
          bytes = await committedBytes(candidate.dir, String(candidate.index));
        } catch {
          // The source transfer was cleared after the cache scan. It was never
          // claimed, so falling through makes the peer send this position.
          continue;
        }
        if (!bytes) continue;
        await put(index, bytes);
        return localHas(index);
      }
      return false;
    };

    const get = async (index) => {
      // A chunk whose write did not finish is not a chunk. Handing its bytes to a
      // peer or to an assembly would fail a tag check somewhere far from here,
      // long after the cause, so it fails at the read instead.
      if (!await has(index)) throw new Error(`chunk ${index} is not staged`);
      const handle = await dir.getFileHandle(String(index));
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    };

    const held = async () => {
      const chunks = new Set();
      const marked = new Set();
      for await (const name of dir.keys()) {
        // Only a bare position counts as a chunk, so a mark, and anything else
        // that ever lands in this directory, is never mistaken for one.
        if (CHUNK_NAME.test(name)) chunks.add(name);
        else if (name.endsWith(MARK)) marked.add(name.slice(0, -MARK.length));
      }
      const out = new Set();
      for (const name of chunks) if (!marked.has(name)) out.add(Number(name));
      return out;
    };

    return {
      put,
      get,
      has,
      held,
      bitmap: async (count) => bitmapOf(await held(), count),
      // Receiver stages are reconciled from their CID manifest and registered
      // sender stages from the outbound ownership index. The remaining
      // ponytail is narrower: a sender preparation killed before the server
      // creates a transfer has neither marker, so its random stage cannot yet be
      // distinguished from one still being prepared. A durable preparation
      // marker, written before the first chunk and retired after registration,
      // is the missing fact an age-based sweep would need.
      clear: async () => {
        const staging = await stagingRoot();
        await staging.removeEntry(id, { recursive: true });
      },
    };
  };
}

const open = makeStageOpener(write);
export const openStage = (transferId, cids = null) => open(transferId, cids);

// Receiver stages identify themselves with a CID manifest; sender stages do
// not, because their random id lives in sealed metadata instead. That makes it
// safe to reclaim only receiver-owned directories against a successful Inbox
// snapshot without risking a queued outbound file whose stage id the server can
// never see. A partial manifest still proves receiver ownership.
export async function reconcileReceiverStages(activeTransferIds, { root = null } = {}) {
  const active = new Set([...activeTransferIds].filter((id) => TRANSFER_ID.test(id)));
  const staging = await stagingRoot(root);
  const removed = [];
  for await (const id of staging.keys()) {
    if (!TRANSFER_ID.test(id) || active.has(id)) continue;
    let dir;
    try {
      dir = await staging.getDirectoryHandle(id);
    } catch {
      continue;
    }
    if (!await existsIn(dir, CID_LIST) && !await existsIn(dir, markOf(CID_LIST))) continue;
    try {
      await staging.removeEntry(id, { recursive: true });
      removed.push(id);
    } catch (err) {
      // Another tab may have completed the same idempotent reconciliation.
      if (err?.name !== 'NotFoundError') throw err;
    }
  }
  return removed;
}

// Ask the browser to keep this data rather than evicting it under pressure. A
// queued transfer whose staged chunks were evicted would be undeliverable with
// no way to tell the owner why.
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
