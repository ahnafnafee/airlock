// Turning a received transfer into one file the operating system can hold.
//
// Receiving is two steps and only the second was ever uncertain. Chunks arrive
// and land in the origin private file system, which always works. Turning them
// into a file is a separate action, it can be retried, and export.js gives it
// several independent implementations. Nothing here is the last chance at
// anything: a transfer whose export has not landed yet is still a transfer whose
// bytes are on the device and whose tags have verified.
//
// Everything in this module runs in a worker. createSyncAccessHandle is callable
// only from a dedicated worker global scope, and Safari shipped no other way to
// write into the origin private file system before 26.0, so one write path
// serves every browser.

import { openChunk } from './crypto.js';

const ASSEMBLED = 'assembled';

async function assembledDir(root) {
  const base = root || await navigator.storage.getDirectory();
  return base.getDirectoryHandle(ASSEMBLED, { create: true });
}

// The name a File carries is what the download attribute saves as and what the
// share sheet writes into the Files app, so a name chosen on another device has
// to survive the trip. This is deliberately not naming.js's ASCII fallback,
// which exists to be safe inside an HTTP header: here the point is the opposite,
// that an emoji or a non-Latin name reaches the operating system intact. Only
// the characters that would name a path rather than a file are removed.
function fileName(meta) {
  const cleaned = String(meta?.name ?? '')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim();
  if (cleaned === '' || /^\.+$/.test(cleaned)) return 'download';
  return cleaned;
}

// getFile names the File after its handle, which here is the transfer id: an id
// with no extension is neither a name a person recognizes nor one iOS can pick a
// type from. Rewrapping costs no memory, because a Blob built from a Blob
// references the same bytes on disk rather than reading them into the heap.
const wrap = (file, meta) => new File([file], fileName(meta), {
  type: meta.mime || 'application/octet-stream',
});

// Where a chunk comes from, in the order that costs least. A transfer delivered
// peer to peer already holds its sealed chunks in this device's stage; one
// relayed through the server does not. Save is only offered on a transfer the
// server reports complete, so the server can always supply what the stage lacks.
//
// Staged chunks are removed as they are consumed, and only the ones that came
// from the stage. That is what keeps peak disk at roughly the file size plus one
// chunk rather than twice the file size, and it is safe for exactly the reason
// above: the same bytes are still on the server.
//
// Consuming is refusable, because a stage is not always this save's to spend.
// Its caller decides, and refuses in two cases: a stage holding what this device
// still owes somebody, and a stage that anything might still ask to resume from.
// Emptying either one turns a save into a second delivery of the whole file.
// A stage is pruned only when doing so cannot lose bytes.
//
// consume says whether this device is allowed to prune at all. replaceable says
// whether the server still holds a copy of every chunk, which decides WHEN: a
// chunk the server can hand back is safe to delete the moment it has been
// written, because a failed assembly can fetch it again. A chunk the server
// does not have is the only copy in existence, so deleting it as the output
// grows would mean an assembly interrupted half way through has destroyed the
// bytes it had not finished with, leaving a partial output that fails its own
// size check and can never be retried. Those chunks are released by commit(),
// which the caller runs only after the whole file has assembled and verified.
//
// consume defaults to false so the safe answer is the one you get by omission.
// The worker is the only producer and always passes it explicitly.
export function chunkSource(dir, cids, { fetchChunk, consume = false, replaceable = false }) {
  const staged = new Set();
  const spent = [];

  const drop = async (i) => {
    // A stage that cannot be pruned costs disk and nothing else, so it never
    // fails an assembly that has otherwise succeeded.
    try {
      await dir.removeEntry(String(i));
    } catch {
      // Already gone, or a directory this transfer no longer owns.
    }
  };

  return {
    get: async (i) => {
      try {
        const handle = await dir.getFileHandle(String(i));
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        staged.add(i);
        return bytes;
      } catch {
        return fetchChunk(cids[i]);
      }
    },
    remove: async (i) => {
      if (!staged.delete(i) || !consume) return;
      if (replaceable) await drop(i);
      else spent.push(i);
    },
    // Called once the assembled file is whole. Until then every irreplaceable
    // chunk is still on disk, so a failure at any point leaves the transfer
    // exactly as retryable as it was before the attempt.
    commit: async () => {
      for (const i of spent.splice(0)) await drop(i);
    },
  };
}

// An assembly already on disk is reused rather than repeated, which is what
// makes a second Save immediate. It also has to be, rather than merely wanting
// to be: assemble consumes the staged chunks as it writes, and a share sheet or
// a save picker needs the user gesture that a long first assembly has already
// spent. The second tap is the one that reaches the operating system, and it
// only reaches it in time because this returns without decrypting anything.
//
// A file whose length disagrees with the metadata is an assembly that was
// interrupted. It is treated as absent rather than handed over short.
export async function assembledFile(transferId, meta, { root = null } = {}) {
  try {
    const out = await assembledDir(root);
    const handle = await out.getFileHandle(transferId);
    const file = await handle.getFile();
    if (file.size !== meta.size) return null;
    return wrap(file, meta);
  } catch {
    return null;
  }
}

// Decrypt the staged chunks into a single output file. The result is a
// disk-backed File, which is what lets every export rung stay memory-flat:
// createObjectURL and navigator.share both take a reference to disk rather than
// a copy in memory, so a 20 GB export costs what a 20 MB one does.
export async function assemble(transferId, meta, { mk, mode, hashes, cids, stage, root = null }) {
  const out = await assembledDir(root);
  const handle = await out.getFileHandle(transferId, { create: true });

  // One handle held for the whole write. The spec allows a single open sync
  // access handle per file, and reopening per chunk would be both slower and a
  // race against itself.
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    let at = 0;
    for (let i = 0; i < hashes.length; i++) {
      const sealed = await stage.get(i);
      // Throws if the chunk was substituted or corrupted, so a damaged transfer
      // fails here rather than producing a plausible wrong file.
      const plain = await openChunk(mk, mode, hashes[i], cids[i], sealed);
      access.write(plain, { at });
      at += plain.length;
      await stage.remove(i);
    }
    access.flush();
    if (at !== meta.size) {
      throw new Error(`assembled ${at} bytes, expected ${meta.size}`);
    }
  } finally {
    access.close();
  }
  // Only now, with the whole file written and its length agreed, are chunks the
  // server cannot replace safe to release.
  await stage.commit?.();
  return wrap(await handle.getFile(), meta);
}
