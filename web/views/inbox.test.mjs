import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOMAIN, MODE_PLAIN, MODE_SEALED, b64encode, deriveMaster, sealRecord,
} from '../crypto.js';

// A view registers itself against the app shell the moment it is imported, and
// the shell reaches for a document. These are the few calls that path makes, and
// nothing below asserts on any of them: the point is only that importing the
// module under test does not need a browser. readRow is written to build no
// nodes for exactly this reason.
function stubDocument() {
  const node = () => ({
    children: [],
    dataset: {},
    className: '',
    hidden: false,
    textContent: '',
    append(...cs) { this.children.push(...cs); },
    prepend(...cs) { this.children.unshift(...cs); },
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
  });
  const byId = new Map();
  globalThis.document = {
    createElement: node,
    createTextNode: (text) => ({ text }),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, node());
      return byId.get(id);
    },
    body: node(),
  };
  // navigator is a getter on the Node global, so it cannot simply be assigned.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node' }, configurable: true, writable: true,
  });
  globalThis.window = { matchMedia: () => ({ matches: false }), navigator: globalThis.navigator };
  globalThis.location = { hash: '', search: '' };
  globalThis.addEventListener = () => {};
  // The shell asks the server who this device is as it boots. There is no
  // server here, and a refusal is a state it already handles.
  globalThis.fetch = async () => { throw new Error('no server in this test'); };
}

stubDocument();
const { readRow } = await import('./inbox.js');

const SALT = b64encode(new Uint8Array(16).fill(3));
const mk = await deriveMaster('correct horse battery staple', SALT);
const other = await deriveMaster('a different passphrase', SALT);

const ID = 'a'.repeat(32);
const CIDS = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
const enc = (s) => new TextEncoder().encode(s);

const metaFor = async (key, mode = MODE_SEALED) => b64encode(await sealRecord(
  key, mode, DOMAIN.META, ID,
  enc(JSON.stringify({ name: 'holiday.mp4', size: 1536, mime: 'video/mp4' }))));

// A transfer delivered the default way: the sender kept the bytes and handed
// them over the wire, so the server holds no chunk of it and never will. Its
// metadata record is on the server, because both send paths upload that.
async function direct(overrides = {}) {
  return {
    id: ID,
    sender: 'mac-mini',
    createdAt: new Date().toISOString(),
    cids: CIDS,
    missing: [...CIDS],
    complete: false,
    meta: await metaFor(mk),
    ...overrides,
  };
}

// A stage that holds the given positions. Anything not listed here has no
// directory at all, which is what a transfer that has not started arriving
// looks like on disk.
function stages(holdings) {
  return async (transferId) => {
    if (!(transferId in holdings)) throw new Error('no such directory');
    return { held: async () => new Set(holdings[transferId]) };
  };
}

test('a transfer the server holds no chunk of still renders its real name', async () => {
  const row = await readRow(await direct(), mk, stages({}));
  assert.equal(row.name, 'holiday.mp4');
  // The size comes from the same record as the name, so it lands with it.
  assert.equal(row.detail, '1.5 KB · from mac-mini · just now');
  assert.ok(row.meta);
});

test('Save is offered once this device holds every chunk', async () => {
  const row = await readRow(await direct(), mk, stages({ [ID]: [0, 1, 2] }));
  assert.equal(row.saveable, true);
  assert.equal(row.note, undefined);
});

test('a partly arrived transfer says what it is waiting for and offers no Save', async () => {
  const row = await readRow(await direct(), mk, stages({ [ID]: [0] }));
  assert.equal(row.name, 'holiday.mp4');
  assert.equal(row.saveable, false);
  assert.equal(row.note, 'Still arriving. 1 of 3 chunks so far.');
});

test('a stage that does not exist yet reads as not yet rather than as an error', async () => {
  const row = await readRow(await direct(), mk, stages({}));
  assert.equal(row.saveable, false);
  assert.equal(row.note, 'Still arriving. 0 of 3 chunks so far.');
});

test('a chunk the server happens to hold counts toward the same total', async () => {
  // Assembly reads a position from the stage and falls back to the server, so a
  // position either one holds is a position this device can put in the file.
  const t = await direct({ missing: [CIDS[0], CIDS[1]] });
  assert.equal((await readRow(t, mk, stages({ [ID]: [0] }))).note,
    'Still arriving. 2 of 3 chunks so far.');
  assert.equal((await readRow(t, mk, stages({ [ID]: [0, 1] }))).saveable, true);
});

test('a transfer the server holds is saveable without asking this disk', async () => {
  let asked = 0;
  const row = await readRow(
    await direct({ complete: true, missing: [] }), mk,
    async () => { asked++; throw new Error('the stage must not be consulted'); });
  assert.equal(row.saveable, true);
  assert.equal(row.name, 'holiday.mp4');
  // Opening a stage creates the directory, so a transfer that never staged
  // anything must not be asked about one.
  assert.equal(asked, 0);
});

test('a transfer whose metadata record has not landed is the only nameless row', async () => {
  const row = await readRow(await direct({ meta: '' }), mk, stages({ [ID]: [0, 1, 2] }));
  assert.equal(row.name, 'Incomplete transfer');
  assert.equal(row.saveable, false);
});

test('a name this device cannot vouch for is never rendered as one', async () => {
  // Both refusals survive the looser gate: a record sealed under another
  // passphrase, and one sent unsealed, which nothing in this build ever does.
  const wrong = await readRow(await direct({ meta: await metaFor(other) }), mk,
    stages({ [ID]: [0, 1, 2] }));
  assert.equal(wrong.name, 'Cannot open');
  assert.equal(wrong.saveable, false);
  assert.match(wrong.detail, /sealed with a different passphrase/);

  const plain = await readRow(await direct({ meta: await metaFor(mk, MODE_PLAIN) }), mk,
    stages({ [ID]: [0, 1, 2] }));
  assert.equal(plain.name, 'Cannot open');
  assert.equal(plain.saveable, false);
  assert.match(plain.detail, /Not sealed/);
});
