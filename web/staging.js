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

async function stageDir(transferId) {
  const staging = await stagingRoot();
  return staging.getDirectoryHandle(checkedId(transferId), { create: true });
}

export async function openStage(transferId) {
  const dir = await stageDir(transferId);

  // createSyncAccessHandle rather than createWritable, and therefore only
  // callable from a dedicated worker. This is not a performance choice: Safari
  // did not ship createWritable until 26.0, so on any earlier iOS this is the
  // only way to write into the origin private file system at all.
  //
  // The spec permits one open sync handle per file at a time, so the handle is
  // opened and closed around each write rather than held, since chunks are
  // separate files and several may be written concurrently.
  const put = async (index, bytes) => {
    const handle = await dir.getFileHandle(String(index), { create: true });
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
  };

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
    // the origin's storage. The ceiling is that nothing sweeps. Lifting it
    // means listing the staging directory at startup and dropping every id the
    // server no longer reports as an open transfer.
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
