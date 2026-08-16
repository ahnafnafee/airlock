// Sealed chunks wait here between sessions. A browser loses its File handle when
// the page closes, so without persistent local storage a queued transfer would
// have nothing left to send and a half-received one nothing to resume from.
//
// This is the owner's own disk. It is what turns "both devices must be online at
// once" into "both devices must be online at some point".

const TRANSFER_ID = /^[0-9a-f]{32}$/;

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

async function stagingRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('staging', { create: true });
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
      const { ticket, error } = event.data || {};
      const waiting = pending.get(ticket);
      // A reply to a write nobody is waiting on is not an error. It is a ticket
      // whose caller was already failed by a worker that has since recovered.
      if (!waiting) return;
      pending.delete(ticket);
      if (error) waiting.reject(new Error(error));
      else waiting.resolve();
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

export async function openStage(transferId) {
  const dir = await stageDir(transferId);

  // The write itself happens in the worker, which resolves this same directory
  // on its side. The id was checked by stageDir above and is checked again
  // there, because a path is built from it on both sides of the message.
  const put = (index, bytes) => write(transferId, index, bytes);

  const get = async (index) => {
    const handle = await dir.getFileHandle(String(index));
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  };

  const has = async (index) => {
    try {
      await dir.getFileHandle(String(index));
      return true;
    } catch {
      return false;
    }
  };

  const held = async () => {
    const out = new Set();
    for await (const name of dir.keys()) {
      const i = Number(name);
      if (Number.isInteger(i) && i >= 0) out.add(i);
    }
    return out;
  };

  return {
    put,
    get,
    has,
    held,
    bitmap: async (count) => bitmapOf(await held(), count),
    // ponytail: a stage is only ever removed by the transfer that owns it, so
    // one abandoned part way through holds its chunks until the owner clears
    // the origin's storage. The ceiling is that nothing sweeps.
    //
    // Lifting it is not a matter of listing this directory and dropping every
    // id the server does not report as an open transfer. Only a receiving
    // stage is named by its transfer's id. A sending one is named by an id
    // minted during preparation that lives only inside that transfer's sealed
    // meta record, and the server never learns it, so it can never report it.
    // The live set is the union of the transfer ids this device is receiving
    // and the stage field read out of the sealed meta record of every transfer
    // this device sent, which means a sweep has to open those records before it
    // may drop anything. It must also spare a directory belonging to a
    // preparation still in flight, whose record does not exist yet. A sweep
    // that skipped either step would delete the sealed chunks of every queued
    // transfer still waiting to be delivered.
    clear: async () => {
      const staging = await stagingRoot();
      await staging.removeEntry(checkedId(transferId), { recursive: true });
    },
  };
}

// Ask the browser to keep this data rather than evicting it under pressure. A
// queued transfer whose staged chunks were evicted would be undeliverable with
// no way to tell the owner why.
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
