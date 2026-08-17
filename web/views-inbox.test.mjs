import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOMAIN, MODE_PLAIN, MODE_SEALED, b64encode, deriveMaster, sealRecord,
} from './crypto.js';

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
const {
  bitsSet, cleanLocalTransfer, elsewhereText, progressBitmap, readRow,
  reconcileLocalTransfers, rowActions, settleAfterSave, terminateTransfer,
} = await import('./views/inbox.js');
const { RUNG } = await import('./export.js');

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

test('a transfer the server holds no chunk of still renders its real name', async () => {
  const row = await readRow(await direct(), mk);
  assert.equal(row.name, 'holiday.mp4');
  // The size comes from the same record as the name, so it lands with it.
  assert.equal(row.detail, '1.5 KB · from mac-mini · just now');
  assert.ok(row.meta);
});

test('Save is offered once the server holds every chunk', async () => {
  const row = await readRow(await direct({ complete: true, missing: [] }), mk);
  assert.equal(row.saveable, true);
  assert.equal(row.note, undefined);
  assert.deepEqual(row.heldAt, [0, 1, 2]);
});

test('a partly arrived transfer says what it is waiting for and offers no Save', async () => {
  const row = await readRow(await direct({ missing: [CIDS[1], CIDS[2]] }), mk);
  assert.equal(row.name, 'holiday.mp4');
  assert.equal(row.saveable, false);
  assert.equal(row.note, 'Still arriving. 1 of 3 chunks so far.');
});

test('a sparse arrival keeps the chunk positions that are actually present', async () => {
  const row = await readRow(await direct({ missing: [CIDS[0], CIDS[1]] }), mk);
  assert.equal(row.reach, 1);
  assert.deepEqual(row.heldAt, [2]);
});

test('a transfer with nothing landed yet reads as not yet rather than as an error', async () => {
  const row = await readRow(await direct(), mk);
  assert.equal(row.saveable, false);
  assert.equal(row.note, 'Still arriving. 0 of 3 chunks so far.');
});

// A file can hold the same chunk many times, so the count is over positions and
// not over the length of the missing list: a repeat the server lacks would
// otherwise subtract twice and report a transfer as further along than it is.
test('the count is over positions rather than over the missing set', async () => {
  const t = await direct({ cids: [CIDS[0], CIDS[0], CIDS[1]], missing: [CIDS[0]] });
  const row = await readRow(t, mk);
  assert.equal(row.note, 'Still arriving. 1 of 3 chunks so far.');
  assert.deepEqual(row.heldAt, [2]);
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
  const row = await readRow(await direct({ meta: '' }), mk);
  assert.equal(row.name, 'Incomplete transfer');
  assert.equal(row.saveable, false);
});

test('an outbound transfer is status and delete only on its sender', async () => {
  const row = await readRow(
    await direct({ complete: true, missing: [] }), mk, 'mac-mini');

  assert.equal(row.outbound, true);
  assert.equal(row.saveable, false);
  assert.match(row.detail, /sent just now/);
  assert.doesNotMatch(row.detail, /from mac-mini/);
  assert.match(row.note, /available from the server/i);
  assert.deepEqual(rowActions(row), ['delete']);

  const inbound = await readRow(
    await direct({ complete: true, missing: [] }), mk, 'phone');
  assert.deepEqual(rowActions(inbound), ['save', 'decline', 'delete']);
});

test('terminal cleanup removes the assembled file', async () => {
  const removed = [];
  const deps = { removeAssembled: async (id) => { removed.push(id); } };

  await cleanLocalTransfer(await direct(), {}, false, deps);
  assert.deepEqual(removed, [ID], 'the decrypted copy is the only local thing left to reclaim');
});

test('a lost terminal response is completed from the authoritative inbox', async () => {
  const t = await direct();
  const calls = [];
  const outcome = await terminateTransfer(t, {}, false, async () => {
    calls.push('mutate');
    throw new Error('response lost');
  }, {
    inbox: async () => [],
    cleanLocalTransfer: async () => { calls.push('clean'); },
  });

  assert.equal(outcome.terminal, true);
  assert.deepEqual(calls, ['mutate', 'clean']);
});

// The server still lists it, so the mutation genuinely did not commit and the
// decrypted copy has to stay: throwing it away here would delete the one thing
// a retry could still save.
test('a refused terminal mutation reclaims nothing', async () => {
  const t = await direct();
  const calls = [];
  const outcome = await terminateTransfer(t, {}, false, async () => {
    throw new Error('refused');
  }, {
    inbox: async () => [t],
    cleanLocalTransfer: async () => { calls.push('clean'); },
  });

  assert.equal(outcome.terminal, false);
  assert.equal(outcome.uncertain, false);
  assert.deepEqual(calls, []);
});

// An inbox read that failed says nothing about what the server holds, so the
// outcome is reported as uncertain and nothing local is discarded on the
// strength of it.
test('an unreadable inbox leaves the outcome uncertain and reclaims nothing', async () => {
  const t = await direct();
  const calls = [];
  const outcome = await terminateTransfer(t, {}, false, async () => {
    throw new Error('refused');
  }, {
    inbox: async () => { throw new Error('offline'); },
    cleanLocalTransfer: async () => { calls.push('clean'); },
  });

  assert.equal(outcome.terminal, false);
  assert.equal(outcome.uncertain, true);
  assert.deepEqual(calls, []);
});

test('a successful inbox snapshot reclaims what it no longer lists', async () => {
  const order = [];
  await reconcileLocalTransfers([{ id: ID }], {
    reconcileReceiverStages: async (active) => { order.push(`stages:${[...active]}`); },
    reconcileAssembled: async (active) => { order.push(`outputs:${[...active]}`); },
  });
  assert.deepEqual(new Set(order), new Set([`stages:${ID}`, `outputs:${ID}`]));
});

test('a name this device cannot vouch for is never rendered as one', async () => {
  // Both refusals survive the looser gate: a record sealed under another
  // passphrase, and one sent unsealed, which nothing in this build ever does.
  const wrong = await readRow(await direct({ meta: await metaFor(other) }), mk);
  assert.equal(wrong.name, 'Cannot open');
  assert.equal(wrong.saveable, false);
  assert.match(wrong.detail, /sealed with a different passphrase/);

  const plain = await readRow(await direct({ meta: await metaFor(mk, MODE_PLAIN) }), mk);
  assert.equal(plain.name, 'Cannot open');
  assert.equal(plain.saveable, false);
  assert.match(plain.detail, /Not sealed/);
});

// An inbox is a list of what has not arrived yet. A file that reached the
// operating system has arrived, so leaving it listed turns the inbox into a log
// that only grows and that nobody can tell apart from outstanding work.
test('a saved transfer leaves the inbox', async () => {
  const calls = [];
  const deps = {
    decline: async (id) => { calls.push(`decline:${id}`); },
    cleanLocalTransfer: async () => { calls.push('clean'); },
  };

  // Declined rather than deleted: on a transfer sent to every device, deleting
  // would take it from the others the moment the first one saved it.
  assert.equal(await settleAfterSave({ id: ID }, {}, RUNG.SAVE_PICKER, deps), true);
  assert.deepEqual(calls, [`decline:${ID}`, 'clean']);
});

test('a cancelled export is not an arrival and stays in the inbox', async () => {
  const calls = [];
  const deps = {
    decline: async () => { calls.push('decline'); },
    cleanLocalTransfer: async () => { calls.push('clean'); },
  };
  // KEEP means the file is assembled and still here, which is the one outcome
  // that has to remain listed.
  assert.equal(await settleAfterSave({ id: ID }, {}, RUNG.KEEP, deps), false);
  assert.deepEqual(calls, []);
});

// The anchor rung returns the moment the click is dispatched. A download that
// Chrome blocked for want of a gesture, or that the person cancelled while
// watching it, is indistinguishable from one that landed, so clearing on it
// takes the row away from a file nobody actually has.
test('a download with no receipt leaves the transfer listed', async () => {
  const calls = [];
  const deps = {
    decline: async (id) => { calls.push(`decline:${id}`); },
    cleanLocalTransfer: async () => { calls.push('clean'); },
  };
  assert.equal(await settleAfterSave({ id: ID }, {}, RUNG.DOWNLOAD, deps), false);
  assert.deepEqual(calls, [], 'nothing may be declined on an unwitnessed save');
});

// The two rungs that do resolve against a real outcome still clear the row, or
// every saved file would pile up in the one list that is meant to show what is
// outstanding.
test('a share the platform accepted clears the transfer', async () => {
  const calls = [];
  const deps = {
    decline: async (id) => { calls.push(`decline:${id}`); },
    cleanLocalTransfer: async () => { calls.push('clean'); },
  };
  assert.equal(await settleAfterSave({ id: ID }, {}, RUNG.SHARE, deps), true);
  assert.deepEqual(calls, [`decline:${ID}`, 'clean']);
});

// The file is saved either way, so a server that refuses leaves a stale row
// rather than a lost file, and nothing local is reclaimed on the strength of a
// request that did not land.
test('a refused clearing keeps the local copy', async () => {
  const calls = [];
  const deps = {
    decline: async () => { throw new Error('offline'); },
    cleanLocalTransfer: async () => { calls.push('clean'); },
  };
  // A rung that does carry a receipt, so the decline is actually attempted and
  // it is the server's refusal being tested rather than the outcome check above.
  assert.equal(await settleAfterSave({ id: ID }, {}, RUNG.SAVE_PICKER, deps), false);
  assert.deepEqual(calls, []);
});

// The bitmap is what one device tells the others about a save in progress. It
// is read back by a different device than wrote it, so the two halves have to
// agree on length and on which end the bits start from, and neither half is
// allowed to round: a percentage computed from a wrong bit count is a bar that
// is confidently in the wrong place.
test('a save publishes one bit per written chunk', () => {
  // Length is the chunk count rounded up to whole bytes, never the count.
  assert.equal(progressBitmap(0, 8).length, 1);
  assert.equal(progressBitmap(0, 9).length, 2);
  assert.equal(progressBitmap(0, 17).length, 3);

  // Nothing written is no bits set, and the whole file is exactly as many bits
  // as there are chunks, never the spare ones padding the last byte.
  assert.equal(bitsSet(progressBitmap(0, 20)), 0);
  assert.equal(bitsSet(progressBitmap(20, 20)), 20);

  // Assembly runs in file order, so the set bits are a prefix of that length.
  for (const done of [1, 7, 8, 9, 19]) {
    assert.equal(bitsSet(progressBitmap(done, 20)), done, `${done} chunks written`);
  }

  // The prefix starts at the low bit of the first byte. Stated as a value
  // rather than implied, because the reader is a different device.
  assert.deepEqual([...progressBitmap(3, 8)], [0b00000111]);
});

test('a percentage from a bitmap never exceeds the file', () => {
  // The padding bits in the last byte are never set, so a full file reads as
  // exactly 100 rather than as 106 because the count was rounded to bytes.
  const chunks = 17;
  const full = bitsSet(progressBitmap(chunks, chunks));
  assert.equal(Math.floor((full * 100) / chunks), 100);
});

test('the elsewhere line names every device and only this transfer', () => {
  const at = new Map([
    [`${ID}:pixel-10-pro`, 42],
    [`${ID}:ipad-pro-11-m4`, 100],
    ['b'.repeat(32) + ':axiom-laptop', 7],
  ]);
  const text = elsewhereText(ID, at);
  assert.match(text, /pixel-10-pro saving 42%/);
  // A finished save reads as finished rather than as stuck at 100%.
  assert.match(text, /ipad-pro-11-m4 saved it/);
  // Another transfer's progress must never leak onto this row.
  assert.doesNotMatch(text, /axiom-laptop/);
});

test('a transfer nobody else is saving has nothing to say', () => {
  assert.equal(elsewhereText(ID, new Map()), '');
});
