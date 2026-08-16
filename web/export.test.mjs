import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNG, exportFile, exportRungs } from './export.js';
import { assemble, assembledFile, chunkSource } from './assemble.js';
import { MODE_SEALED, chunkIdentity, sealChunk } from './crypto.js';

// A stand-in for the origin private file system. Only the four calls assembly
// makes are implemented, and the sync access handle keeps its bytes in an array
// so a test can read back exactly what was written, including a short write that
// should never have been handed to anyone.
function fakeStorage() {
  const dirs = new Map();
  const dir = (name) => {
    if (!dirs.has(name)) {
      const files = new Map();
      dirs.set(name, {
        files,
        async getFileHandle(entry, { create = false } = {}) {
          if (!files.has(entry)) {
            if (!create) throw new Error(`no entry named ${entry}`);
            files.set(entry, { bytes: new Uint8Array(0) });
          }
          const held = files.get(entry);
          return {
            async createSyncAccessHandle() {
              return {
                truncate(n) {
                  const next = new Uint8Array(n);
                  next.set(held.bytes.subarray(0, Math.min(n, held.bytes.length)));
                  held.bytes = next;
                },
                write(buf, { at }) {
                  if (held.bytes.length < at + buf.length) {
                    const grown = new Uint8Array(at + buf.length);
                    grown.set(held.bytes);
                    held.bytes = grown;
                  }
                  held.bytes.set(buf, at);
                  return buf.length;
                },
                flush() {},
                close() {},
              };
            },
            async getFile() {
              return new File([held.bytes], entry);
            },
          };
        },
        async removeEntry(entry) {
          if (!files.delete(entry)) throw new Error(`no entry named ${entry}`);
        },
      });
    }
    return dirs.get(name);
  };
  return { dirs, async getDirectoryHandle(name) { return dir(name); } };
}

// A master key is only ever an HKDF key here, which is what deriveMaster returns
// after its 600000 PBKDF2 rounds. Importing one directly keeps these tests about
// assembly rather than about key derivation.
const masterKey = () => crypto.subtle.importKey(
  'raw', new Uint8Array(32).fill(7), 'HKDF', false, ['deriveBits', 'deriveKey']);

// Three chunks of deliberately different lengths, so a mistake in the running
// write offset produces a different file rather than a differently ordered one.
async function sealedChunks(mk, plains) {
  const hashes = [];
  const cids = [];
  const sealed = [];
  for (const plain of plains) {
    const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
    hashes.push(h);
    cids.push(cid);
    sealed.push(await sealChunk(mk, MODE_SEALED, h, cid, plain));
  }
  return { hashes, cids, sealed };
}

function fakeStage(sealed) {
  const removed = [];
  return {
    removed,
    get: async (i) => sealed[i],
    remove: async (i) => { removed.push(i); },
  };
}

const PLAINS = [
  new Uint8Array(11).fill(0xa1),
  new Uint8Array(5).fill(0xb2),
  new Uint8Array(23).fill(0xc3),
];
const TOTAL = PLAINS.reduce((n, p) => n + p.length, 0);
const ID = 'a'.repeat(32);
const META = { name: 'holiday.mp4', size: TOTAL, mime: 'video/mp4' };

const bytesOf = async (file) => new Uint8Array(await file.arrayBuffer());

test('assembling a three-chunk transfer produces the concatenation in order', async () => {
  const mk = await masterKey();
  const { hashes, cids, sealed } = await sealedChunks(mk, PLAINS);
  const stage = fakeStage(sealed);
  const root = fakeStorage();

  const file = await assemble(ID, META, {
    mk, mode: MODE_SEALED, hashes, cids, stage, root,
  });

  const want = new Uint8Array(TOTAL);
  let at = 0;
  for (const p of PLAINS) { want.set(p, at); at += p.length; }
  assert.deepEqual(await bytesOf(file), want);

  // The name is the one the metadata carries, not the transfer id the handle is
  // called after. An id with no extension is not a filename iOS can pick a type
  // from, and it is what the share sheet would write into the Files app.
  assert.equal(file.name, 'holiday.mp4');
  assert.equal(file.type, 'video/mp4');

  // Consumed as it went, which is what keeps peak disk near the file size.
  assert.deepEqual(stage.removed, [0, 1, 2]);
});

test('a chunk that fails its tag aborts assembly rather than writing a short file', async () => {
  const mk = await masterKey();
  const { hashes, cids, sealed } = await sealedChunks(mk, PLAINS);
  sealed[1] = sealed[1].slice();
  sealed[1][0] ^= 0xff;
  const stage = fakeStage(sealed);
  const root = fakeStorage();

  await assert.rejects(
    assemble(ID, META, { mk, mode: MODE_SEALED, hashes, cids, stage, root }),
    // Not the length check below. The tag is what has to stop this, because a
    // damaged chunk that happened to keep the total length right would otherwise
    // produce a plausible wrong file.
    (err) => !/expected/.test(err.message));

  // The chunk that failed was not consumed, and neither was the one after it.
  assert.deepEqual(stage.removed, [0]);

  // Nothing is handed back, so nothing short can be exported. What is on disk is
  // a partial write, which assembledFile refuses for that reason.
  assert.equal(await assembledFile(ID, META, { root }), null);
});

test('assembly checks the total length against the metadata size', async () => {
  const mk = await masterKey();
  const { hashes, cids, sealed } = await sealedChunks(mk, PLAINS);
  const stage = fakeStage(sealed);
  const root = fakeStorage();

  await assert.rejects(
    assemble(ID, { ...META, size: TOTAL + 1 }, {
      mk, mode: MODE_SEALED, hashes, cids, stage, root,
    }),
    new RegExp(`assembled ${TOTAL} bytes, expected ${TOTAL + 1}`));
});

test('a second save reuses the assembled file rather than decrypting again', async () => {
  const mk = await masterKey();
  const { hashes, cids, sealed } = await sealedChunks(mk, PLAINS);
  const root = fakeStorage();

  // Nothing assembled yet, so there is nothing to reuse.
  assert.equal(await assembledFile(ID, META, { root }), null);

  await assemble(ID, META, {
    mk, mode: MODE_SEALED, hashes, cids, stage: fakeStage(sealed), root,
  });

  // The staged chunks are gone by now, so a second assembly could not repeat the
  // work even if it wanted to. This is what a second tap has to find.
  const again = await assembledFile(ID, META, { root });
  assert.notEqual(again, null);
  assert.equal(again.name, 'holiday.mp4');
  assert.equal(again.size, TOTAL);
});

test('a chunk missing from the stage comes from the server, and only staged ones are pruned', async () => {
  const root = fakeStorage();
  const dir = await root.getDirectoryHandle('staging-a');
  const handle = await dir.getFileHandle('1', { create: true });
  const access = await handle.createSyncAccessHandle();
  access.write(new Uint8Array([9, 9, 9]), { at: 0 });
  access.close();

  const asked = [];
  const source = chunkSource(dir, ['cid-zero', 'cid-one'], {
    fetchChunk: async (cid) => { asked.push(cid); return new Uint8Array([1]); },
    consume: true,
    replaceable: true,
  });

  assert.deepEqual(await source.get(0), new Uint8Array([1]));
  assert.deepEqual(asked, ['cid-zero']);
  assert.deepEqual(await source.get(1), new Uint8Array([9, 9, 9]));
  assert.deepEqual(asked, ['cid-zero']);

  // The one that came from the server was never in the stage, so removing it
  // must not delete a file some other transfer position owns.
  await source.remove(0);
  await source.remove(1);
  assert.equal(dir.files.has('1'), false);
});

test('a stage this device does not own is read but never pruned', async () => {
  // A device sees the transfers it sent as well as the ones it was sent, and a
  // transfer whose sealed metadata names no stage of its own staged under this
  // same id. Deleting there would destroy the only copy of what it still owes
  // every recipient that has not taken delivery yet.
  const root = fakeStorage();
  const dir = await root.getDirectoryHandle('staging-b');
  const handle = await dir.getFileHandle('0', { create: true });
  const access = await handle.createSyncAccessHandle();
  access.write(new Uint8Array([4, 5]), { at: 0 });
  access.close();

  const source = chunkSource(dir, ['cid-zero'], {
    fetchChunk: async () => { throw new Error('the stage should have answered this'); },
    consume: false,
  });

  assert.deepEqual(await source.get(0), new Uint8Array([4, 5]));
  await source.remove(0);
  assert.equal(dir.files.has('0'), true);
});

// The export cascade. Every fake below stands in for something that either has
// no Node equivalent or has to be watched rather than used.
function fakeDom() {
  const log = [];
  const doc = {
    body: { append: (node) => log.push({ at: 'append', node }) },
    createElement() {
      const a = {
        click: () => log.push({ at: 'click', href: a.href, download: a.download }),
        remove: () => log.push({ at: 'remove' }),
      };
      return a;
    },
  };
  let next = 0;
  const urls = {
    createObjectURL: () => {
      const url = `blob:fake-${next++}`;
      log.push({ at: 'create', url });
      return url;
    },
    revokeObjectURL: (url) => log.push({ at: 'revoke', url }),
  };
  return { log, doc, urls, steps: () => log.map((e) => e.at) };
}

const aborting = () => {
  const err = new Error('the person said no');
  err.name = 'AbortError';
  return err;
};

const FILE = new File([new Uint8Array([1, 2, 3])], 'holiday.mp4', { type: 'video/mp4' });

test('a canceled share keeps the file rather than downloading it', async () => {
  // Falling through here would save a file the person just declined to save,
  // which is worse than not saving it: they can tap Save again, and the file has
  // not gone anywhere.
  const dom = fakeDom();
  const nav = { canShare: () => true, share: async () => { throw aborting(); } };

  const rung = await exportFile(FILE, {
    preferShare: true, nav, doc: dom.doc, urls: dom.urls, win: {},
  });

  assert.equal(rung, RUNG.KEEP);
  assert.deepEqual(dom.steps(), []);
});

test('a share that fails for any other reason falls through to the download', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = fakeDom();
  const nav = {
    canShare: () => true,
    share: async () => { throw new Error('there is no share transport here'); },
  };

  const rung = await exportFile(FILE, {
    preferShare: true, nav, doc: dom.doc, urls: dom.urls, win: {},
  });

  assert.equal(rung, RUNG.DOWNLOAD);
  assert.equal(dom.log.filter((e) => e.at === 'click').length, 1);
  assert.equal(dom.log.find((e) => e.at === 'click').download, 'holiday.mp4');
});

test('preferShare false never asks about sharing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = fakeDom();
  let touched = 0;
  const nav = {
    canShare: () => { touched++; return true; },
    share: async () => { touched++; },
  };

  const rung = await exportFile(FILE, {
    preferShare: false, nav, doc: dom.doc, urls: dom.urls, win: {},
  });

  assert.equal(rung, RUNG.DOWNLOAD);
  assert.equal(touched, 0);
});

test('a canceled save picker keeps the file rather than downloading it', async () => {
  const dom = fakeDom();
  const win = { showSaveFilePicker: async () => { throw aborting(); } };

  const rung = await exportFile(FILE, { nav: {}, doc: dom.doc, urls: dom.urls, win });

  assert.equal(rung, RUNG.KEEP);
  assert.deepEqual(dom.steps(), []);
});

test('a save picker that fails for any other reason falls through to the download', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = fakeDom();
  const win = {
    showSaveFilePicker: async () => { throw new Error('the gesture was already spent'); },
  };

  const rung = await exportFile(FILE, { nav: {}, doc: dom.doc, urls: dom.urls, win });

  assert.equal(rung, RUNG.DOWNLOAD);
});

test('the object URL is revoked, and not before the click', async (t) => {
  // Revoking while the browser is still fetching the URL cancels the download on
  // some engines, so the order here is the whole point of the timer.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = fakeDom();

  const rung = await exportFile(FILE, { nav: {}, doc: dom.doc, urls: dom.urls, win: {} });

  assert.equal(rung, RUNG.DOWNLOAD);
  assert.deepEqual(dom.steps(), ['create', 'append', 'click', 'remove']);

  t.mock.timers.tick(60000);
  assert.deepEqual(dom.steps(), ['create', 'append', 'click', 'remove', 'revoke']);
  assert.equal(dom.log.at(-1).url, dom.log[0].url);
});

test('a browser that cannot mint an object URL keeps the file', async () => {
  const dom = fakeDom();
  const urls = { createObjectURL: () => { throw new Error('no object URLs here'); } };

  const rung = await exportFile(FILE, { nav: {}, doc: dom.doc, urls, win: {} });

  assert.equal(rung, RUNG.KEEP);
});

test('keeping the file is a rung every browser has', () => {
  // The one unconditional entry, and the reason the cascade has no failure case.
  assert.equal(exportRungs({}, {})[RUNG.KEEP], true);
  assert.equal(exportRungs({}, {})[RUNG.SAVE_PICKER], false);
  assert.equal(exportRungs({}, {})[RUNG.STREAM], false);
  assert.equal(exportRungs({}, {})[RUNG.DOWNLOAD], false);
  assert.equal(exportRungs({}, {})[RUNG.SHARE], false);

  const rich = exportRungs(
    { serviceWorker: {}, canShare: () => true },
    { showSaveFilePicker: () => {}, URL: { createObjectURL: () => {} } });
  for (const [rung, has] of Object.entries(rich)) {
    assert.equal(has, true, `${rung} should be reported on a browser that has it`);
  }
});


// A chunk the server does not have is the only copy of those bytes. Deleting it
// as the output grows means an assembly interrupted half way through has
// destroyed what it had not finished with, and the partial output fails its own
// size check, so the transfer becomes unrecoverable rather than retryable. This
// is reachable on the product default, where the sender hands bytes straight to
// the recipient and the server holds no chunk at all.
test('an irreplaceable chunk survives until the whole file has assembled', async () => {
  const root = fakeStorage();
  const dir = await root.getDirectoryHandle('staging-c');
  for (const name of ['0', '1']) {
    const handle = await dir.getFileHandle(name, { create: true });
    const access = await handle.createSyncAccessHandle();
    access.write(new Uint8Array([7]), { at: 0 });
    access.close();
  }

  const source = chunkSource(dir, ['cid-zero', 'cid-one'], {
    fetchChunk: async () => { throw new Error('the server holds nothing'); },
    consume: true,
    replaceable: false,
  });

  await source.get(0);
  await source.remove(0);
  // Consumed, written into the output, and still on disk: the assembly has not
  // finished, so this is still the only copy of those bytes.
  assert.equal(dir.files.has('0'), true, 'the only copy of a consumed chunk was deleted mid assembly');

  await source.get(1);
  await source.remove(1);
  assert.equal(dir.files.has('1'), true);

  await source.commit();
  assert.equal(dir.files.has('0'), false, 'a committed assembly should release its stage');
  assert.equal(dir.files.has('1'), false);
});

// The other half of the same rule. When the server holds every chunk, a
// consumed one is replaceable and goes immediately, which is what keeps peak
// disk at the file size plus one chunk rather than twice the file size.
test('a replaceable chunk is released as soon as it is written', async () => {
  const root = fakeStorage();
  const dir = await root.getDirectoryHandle('staging-d');
  const handle = await dir.getFileHandle('0', { create: true });
  const access = await handle.createSyncAccessHandle();
  access.write(new Uint8Array([7]), { at: 0 });
  access.close();

  const source = chunkSource(dir, ['cid-zero'], {
    fetchChunk: async () => new Uint8Array([7]),
    consume: true,
    replaceable: true,
  });

  await source.get(0);
  await source.remove(0);
  assert.equal(dir.files.has('0'), false);
});

// Omitting consume must not prune. The worker is the only producer and always
// passes it, but a default of true would make the dangerous answer the one you
// get by forgetting.
test('a stage is never pruned by a caller that did not ask', async () => {
  const root = fakeStorage();
  const dir = await root.getDirectoryHandle('staging-e');
  const handle = await dir.getFileHandle('0', { create: true });
  const access = await handle.createSyncAccessHandle();
  access.write(new Uint8Array([7]), { at: 0 });
  access.close();

  const source = chunkSource(dir, ['cid-zero'], { fetchChunk: async () => new Uint8Array([7]) });
  await source.get(0);
  await source.remove(0);
  await source.commit();
  assert.equal(dir.files.has('0'), true);
});
