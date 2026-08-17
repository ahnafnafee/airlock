import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilities, markCapability, observeCapabilities, filesFromDrop, installCard,
  __setStore, __settled,
} from './inbound.js';

// A store that counts its writes, because the thing worth holding to account in
// markCapability is not that the flag ends up true. It is that a second receipt
// writes nothing and that a new flag never takes the old ones with it.
function fakeStore() {
  const data = new Map();
  const store = {
    writes: 0,
    get: async (k) => data.get(k),
    put: async (k, v) => { store.writes++; data.set(k, v); },
  };
  return store;
}

// Stands in for document and window. Only addEventListener is real, because
// what these tests exercise is which events are believed, not how they travel.
function fakeTarget(extra = {}) {
  const handlers = new Map();
  return {
    ...extra,
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    fire(type, event) {
      for (const fn of handlers.get(type) || []) fn(event);
    },
  };
}

function fresh() {
  const store = fakeStore();
  __setStore(store);
  const doc = fakeTarget();
  const win = fakeTarget();
  observeCapabilities({ doc, win });
  return { store, doc, win };
}

test('a paste proves nothing until it actually carries a file', async () => {
  // Firefox on Android does not implement clipboardData.files at all, so it
  // fires this event and never brings a file. A hint offered on the strength of
  // the event alone would be a promise that browser cannot keep.
  const { doc } = fresh();

  doc.fire('paste', {});
  doc.fire('paste', { clipboardData: {} });
  doc.fire('paste', { clipboardData: { files: [] } });
  await __settled();
  assert.deepEqual(await capabilities(), {});

  doc.fire('paste', { clipboardData: { files: [new File(['x'], 'x.bin')] } });
  await __settled();
  assert.equal((await capabilities()).paste, true);
});

test('a dragenter carrying no files leaves the drop zone undrawn', async () => {
  const { doc } = fresh();

  doc.fire('dragenter', {});
  doc.fire('dragenter', { dataTransfer: { types: [] } });
  doc.fire('dragenter', { dataTransfer: { types: ['text/plain', 'text/uri-list'] } });
  await __settled();
  assert.equal((await capabilities()).drop, undefined);

  doc.fire('dragenter', { dataTransfer: { types: ['Files'] } });
  await __settled();
  assert.equal((await capabilities()).drop, true);
});

test('a browser that never offers an install is never shown an install card', async () => {
  // Firefox shaped: beforeinstallprompt never fires and there is no launchQueue.
  // Nothing about the manifest is consulted, so no card can appear here.
  const { win } = fresh();
  assert.deepEqual(await capabilities(), {});
  assert.equal(installCard(await capabilities()), null);

  win.fire('beforeinstallprompt', {});
  await __settled();
  assert.equal((await capabilities()).installable, true);
  assert.notEqual(installCard(await capabilities()), null);
});

test('the file handler API is claimed only where the window exposes it', async () => {
  const store = fakeStore();
  __setStore(store);
  observeCapabilities({ doc: fakeTarget(), win: fakeTarget() });
  await __settled();
  assert.equal((await capabilities()).fileHandlerApi, undefined);

  __setStore(fakeStore());
  observeCapabilities({ doc: fakeTarget(), win: fakeTarget({ launchQueue: {} }) });
  await __settled();
  assert.equal((await capabilities()).fileHandlerApi, true);
});

test('the install card never claims a share menu before a share has landed', async () => {
  // Chromium on Android fires beforeinstallprompt and has no launchQueue, so
  // the card may not offer Open with. Chromium on the desktop is the reverse.
  const android = { installable: true };
  assert.ok(!installCard(android).includes('Open with'));
  assert.ok(installCard(android).includes('may also appear'));

  const desktop = { installable: true, fileHandlerApi: true };
  assert.ok(installCard(desktop).includes('Open with'));
  assert.ok(installCard(desktop).includes('may also appear'));

  const proven = { installable: true, fileHandlerApi: true, shareTarget: true };
  assert.ok(!installCard(proven).includes('may'));
  assert.ok(installCard(proven).includes('share menu'));
});

// The directory entry fakes below are the shape webkitGetAsEntry returns: a
// callback API, not a promise one, and a reader that has to be drained.
const fileEntry = (name) => {
  const blob = new File([name], name, { type: 'application/octet-stream' });
  return { isFile: true, name, blob, file: (resolve) => resolve(blob) };
};

const dirEntry = (name, batches) => ({
  isFile: false,
  name,
  createReader() {
    let call = 0;
    return {
      readEntries: (resolve) => resolve(batches[call++] || []),
    };
  },
});

const dropped = (entries) => ({
  items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })),
  files: [],
});

test('a dropped folder arrives with its layout in the names', async () => {
  const tree = dirEntry('photos', [[
    fileEntry('a.jpg'),
    dirEntry('2024', [[fileEntry('b.jpg')], []]),
  ], []]);

  const loose = fileEntry('loose.bin');
  const files = await filesFromDrop(dropped([tree, loose]));
  assert.deepEqual(files.map((f) => f.name).sort(), [
    'loose.bin', 'photos/2024/b.jpg', 'photos/a.jpg',
  ]);
  // A file dropped at the top level has no folder above it, so it is handed on
  // untouched rather than re-wrapped under a name it never had.
  assert.equal(files.find((f) => f.name === 'loose.bin'), loose.blob);
});

test('a folder of more than one batch is read to the end', async () => {
  // readEntries yields at most 100 entries per call and signals the end with an
  // empty batch. An implementation that calls it once returns 100 here and
  // silently loses the other 50, which is the whole point of this test.
  const first = Array.from({ length: 100 }, (_, i) => fileEntry(`f${i}.bin`));
  const second = Array.from({ length: 50 }, (_, i) => fileEntry(`f${100 + i}.bin`));
  const files = await filesFromDrop(dropped([dirEntry('many', [first, second, []])]));

  assert.equal(files.length, 150);
  assert.equal(new Set(files.map((f) => f.name)).size, 150);
  assert.ok(files.every((f) => f.name.startsWith('many/')));
});

test('a drop with no entry API falls back to the flat file list', async () => {
  const a = new File(['a'], 'a.bin');
  const b = new File(['b'], 'b.bin');

  assert.deepEqual(await filesFromDrop({ files: [a, b] }), [a, b]);
  // Present but useless, which is what an older Firefox hands over.
  assert.deepEqual(
    await filesFromDrop({ items: [{}, {}], files: [a] }),
    [a],
  );
});

test('a receipt already recorded is not written again', async () => {
  const store = fakeStore();
  __setStore(store);

  await markCapability('paste');
  await markCapability('paste');
  assert.equal(store.writes, 1);

  await markCapability('drop');
  assert.equal(store.writes, 2);
  // A new flag must not carry off the ones already there. Writing only the new
  // name would leave a device that has proved three things claiming one.
  assert.deepEqual(await capabilities(), { paste: true, drop: true });
});

test('two receipts in the same moment both survive', async () => {
  // Each mark reads the record, adds its flag and writes the whole thing back.
  // Run unserialized, both read the same empty record and the second write
  // erases the first flag.
  const store = fakeStore();
  __setStore(store);

  await Promise.all([
    markCapability('paste'),
    markCapability('drop'),
    markCapability('installable'),
  ]);
  assert.deepEqual(await capabilities(), { paste: true, drop: true, installable: true });
});

test('a store that refuses a write does not wedge every later receipt', async () => {
  // The chain that serializes marks must not end at the first rejection, or one
  // failed write would silence the rest of the session.
  const store = fakeStore();
  let refuse = true;
  __setStore({
    get: store.get,
    put: async (k, v) => {
      if (refuse) throw new Error('the database is closing');
      return store.put(k, v);
    },
  });

  await assert.rejects(markCapability('paste'), /the database is closing/);
  refuse = false;
  await markCapability('drop');
  assert.deepEqual(await capabilities(), { drop: true });
});
