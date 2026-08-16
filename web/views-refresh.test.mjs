import test from 'node:test';
import assert from 'node:assert/strict';

// A DOM small enough to read and real enough to route. What these tests need
// from a browser is narrow: nodes that hold children and attributes, a hidden
// attribute that notifies an observer the way showView's writes do, and a select
// whose value follows its options. Everything else a browser has is out of
// scope, and a stub that pretended otherwise would be evidence about itself.
class Stub {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.observers = [];
    this.handlers = new Map();
    this.classList = { add: () => {}, remove: () => {} };
  }

  // Elements only, so a label's text node never counts as an option or a row.
  get children() { return this.childNodes.filter((n) => n.tagName); }

  get hidden() { return this.attributes.has('hidden'); }

  set hidden(on) {
    const had = this.attributes.has('hidden');
    if (on) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
    if (had !== Boolean(on)) this.notify('hidden');
  }

  get checked() { return this.attributes.has('checked'); }

  set checked(on) {
    if (on) this.attributes.set('checked', '');
    else this.attributes.delete('checked');
  }

  // A select answers with the option it has selected, and assigning selects the
  // option that matches. An option answers with its own attribute.
  get value() {
    if (this.tagName !== 'SELECT') return this.own ?? this.attributes.get('value') ?? '';
    const chosen = this.children.find((o) => o.selected);
    return chosen ? chosen.value : '';
  }

  set value(v) {
    if (this.tagName !== 'SELECT') { this.own = String(v); return; }
    let done = false;
    for (const o of this.children) {
      o.selected = !done && o.value === String(v);
      if (o.selected) done = true;
    }
  }

  setAttribute(name, v) {
    // el only ever writes this attribute to mean hidden, so it routes through
    // the setter that tells the observers.
    if (name === 'hidden') { this.hidden = true; return; }
    this.attributes.set(name, v);
  }

  removeAttribute(name) {
    if (name === 'hidden') { this.hidden = false; return; }
    this.attributes.delete(name);
  }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }

  append(...nodes) { this.childNodes.push(...nodes); }

  replaceChildren(...nodes) { this.childNodes = [...nodes]; }

  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  fire(type, event = {}) {
    for (const fn of this.handlers.get(type) || []) fn(event);
  }

  // A real observer reports only what happened after observe(), and it batches:
  // every record from one turn arrives in a single callback. Leaving a view and
  // coming back writes the attribute twice, so a stub that called back per
  // record would make one gesture look like two refreshes.
  notify(name) {
    for (const o of this.observers) {
      if (o.filter && !o.filter.includes(name)) continue;
      o.records.push({ type: 'attributes', attributeName: name });
      if (o.scheduled) continue;
      o.scheduled = true;
      queueMicrotask(() => {
        o.scheduled = false;
        o.cb(o.records.splice(0, o.records.length));
      });
    }
  }
}

const doc = new Stub('#document');
const nodes = new Map();
doc.createElement = (tag) => new Stub(tag);
doc.createTextNode = (s) => ({ nodeValue: String(s) });
doc.getElementById = (id) => {
  if (!nodes.has(id)) nodes.set(id, new Stub('div'));
  return nodes.get(id);
};
doc.body = new Stub('body');
doc.visibilityState = 'visible';

globalThis.document = doc;
globalThis.location = { hash: '' };
globalThis.addEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false });
globalThis.HTMLInputElement = class {};
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; }

  observe(node, opts) {
    node.observers.push({
      cb: this.cb, filter: opts?.attributeFilter, records: [], scheduled: false,
    });
  }

  disconnect() {}
};
// Reconciliation walks two OPFS directories even when both are empty. This
// directory is enough to make an empty successful Inbox response behave like
// one in a browser, without turning the view test into a storage test.
function emptyDirectory() {
  const directories = new Map();
  const files = new Map();
  const missing = (name) => {
    const error = new Error(`no entry named ${name}`);
    error.name = 'NotFoundError';
    return error;
  };
  return {
    async getDirectoryHandle(name, { create = false } = {}) {
      if (directories.has(name)) return directories.get(name);
      if (!create) throw missing(name);
      const directory = emptyDirectory();
      directories.set(name, directory);
      return directory;
    },
    async getFileHandle(name, { create = false } = {}) {
      if (files.has(name)) return files.get(name);
      if (!create) throw missing(name);
      const file = {};
      files.set(name, file);
      return file;
    },
    async removeEntry(name) {
      if (!directories.delete(name) && !files.delete(name)) throw missing(name);
    },
    async *keys() { yield* [...directories.keys(), ...files.keys()]; },
  };
}
const storageRoot = emptyDirectory();

// An iPhone in a Safari tab, which is the one boot path that stops before it
// reaches the network: the install gate returns and nothing else in boot runs.
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)',
    storage: { getDirectory: async () => storageRoot },
  },
  configurable: true,
  writable: true,
});
globalThis.window = globalThis;

const {
  state, showView, registerView, onInbox, notifyInbox,
} = await import('./app.js');
const { api } = await import('./api.js');
const inbound = await import('./inbound.js');
// The capability flags live in IndexedDB, which this process does not have. The
// send view reads them at mount and the answer is not what is under test.
inbound.__setStore({ get: async () => ({}), put: async () => {} });

state.me = { node: 'laptop' };
state.config = { auth: 'token', cdc: {} };

// What /api/devices answers with, swapped per test.
let roster = [];
let failNext = false;
api.devices = async () => {
  if (failNext) { failNext = false; throw new Error('the server is unreachable'); }
  return roster;
};

const device = (node, allowed = true) => ({
  node, allowed, paired: true, addr: '100.0.0.1', user: 'owner', lastSeen: new Date().toISOString(),
});

const sendView = await import('./views/send.js');
await import('./views/devices.js');
// The Inbox reads immediately when it mounts. Give it a quiet default before
// importing the view; the out-of-order test below replaces this at its API
// boundary with two responses it controls.
api.inbox = async () => [];
await import('./views/inbox.js');
// Somewhere to switch to. Leaving a view and coming back is the whole gesture
// under test, and it needs a second destination to be a gesture at all.
registerView('other', 'Other', () => {});

const panels = doc.getElementById('views').children;
const [sendPanel, devicesPanel, inboxPanel] = panels;

function find(node, pred) {
  for (const c of node.children) {
    if (pred(c)) return c;
    const deep = find(c, pred);
    if (deep) return deep;
  }
  return null;
}

function textOf(node) {
  if (!node.tagName) return node.nodeValue ?? '';
  return node.childNodes.map(textOf).join('');
}

// Every refresh trigger runs a fetch and a repaint across a few microtasks. One
// turn of the event loop settles all of them.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('send controls are named and terminal state has a quiet live region', async () => {
  showView('send');
  await settle();
  const recipient = find(sendPanel, (n) => n.getAttribute('id') === 'to');
  const label = find(sendPanel, (n) => n.getAttribute('for') === 'to');
  const live = find(sendPanel, (n) => n.getAttribute('role') === 'status');
  const progress = find(sendPanel, (n) => n.getAttribute('aria-live') === 'off');
  assert.ok(recipient);
  assert.equal(textOf(label), 'To');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.getAttribute('aria-atomic'), 'true');
  assert.ok(progress, 'per-chunk copy is not a chatty live region');
  showView('other');
});

// Leaving the view and coming back is what a person does, and it is also the
// exact sequence that used to change nothing: registerView mounts at most once.
async function revisit(name) {
  showView('other');
  showView(name);
  await settle();
}

const picker = () => find(sendPanel, (n) => n.getAttribute('id') === 'to');
const sendStatus = () => find(sendPanel, (n) => n.getAttribute('id') === 'send-status');
const offered = () => picker().children.map((o) => o.value);
const deviceRows = () => find(devicesPanel, (n) => n.tagName === 'UL').children;
// The node name each row is about, without the trailing "(this device)".
// A row that carries no name is not a device row, so its own text stands in and
// the mismatch reads as a value rather than as a crash in the helper.
const listed = () => deviceRows().map((li) => {
  const name = find(li, (n) => n.className?.includes('name'));
  return textOf(name || li).split(' ')[0];
});

test('an older inbox response cannot reconcile after a newer refresh wins', async () => {
  const transferId = 'a'.repeat(32);
  const staging = await storageRoot.getDirectoryHandle('staging', { create: true });
  const receiver = await staging.getDirectoryHandle(transferId, { create: true });
  await receiver.getFileHandle('cids', { create: true });

  let releaseOld;
  const oldResponse = new Promise((resolve) => { releaseOld = resolve; });
  const current = [{
    id: transferId, sender: 'phone', createdAt: new Date().toISOString(), meta: '',
  }];
  const replies = [oldResponse, Promise.resolve(current)];
  api.inbox = async () => replies.shift() ?? [];

  showView('inbox');
  notifyInbox();
  assert.equal(replies.length, 0, 'both refreshes have reached the API boundary');
  const list = find(inboxPanel, (n) => n.tagName === 'UL');
  for (let i = 0; i < 10 && !/Incomplete transfer/.test(textOf(list)); i++) await settle();
  assert.match(textOf(list), /Incomplete transfer/, 'the newer snapshot won the visible list');

  releaseOld([]);
  await settle();
  assert.equal(await staging.getDirectoryHandle(transferId), receiver,
    'a superseded snapshot cannot reclaim a current receiver stage');

  api.inbox = async () => [];
  showView('other');
});

test('the send picker offers only paired approved devices except this one', async () => {
  roster = [
    device('laptop'),
    device('tablet'),
    device('desktop', false),
    { ...device('phone'), paired: false },
  ];
  showView('send');
  await settle();
  // This device is not a destination. Neither a blocked device nor one that has
  // not acquired the master key can read what it is sent.
  assert.deepEqual(offered(), ['', 'tablet']);
});

test('the send view cannot create an unreadable plaintext transfer', () => {
  assert.equal(find(sendPanel, (n) => n.getAttribute('id') === 'sealed'), null);
});

test('a device approved after the view mounted becomes selectable', async () => {
  // The defect this names: two people set up a phone, approve it from the
  // laptop, and the laptop's picker never learns the phone exists.
  roster = [device('laptop'), device('tablet'), device('phone')];
  await revisit('send');
  assert.deepEqual(offered(), ['', 'tablet', 'phone']);
});

test('a chosen recipient survives a refresh that changes the list', async () => {
  picker().value = 'phone';
  assert.equal(picker().value, 'phone');

  roster = [device('laptop'), device('tablet'), device('phone'), device('watch')];
  await revisit('send');

  assert.deepEqual(offered(), ['', 'tablet', 'phone', 'watch']);
  // Resetting this because a list reloaded would send the next press of Send to
  // every device instead of the one that was picked.
  assert.equal(picker().value, 'phone');
});

test('a refresh that finds nothing changed leaves the picker alone', async () => {
  picker().value = 'watch';
  const before = picker().children;
  await revisit('send');
  assert.equal(picker().value, 'watch');
  // The same option nodes, not merely equal ones: rebuilding an unchanged list
  // would close a dropdown someone had open.
  assert.deepEqual(picker().children, before);
});

test('a recipient that is no longer reachable is dropped and said out loud', async () => {
  picker().value = 'watch';
  roster = [device('laptop'), device('tablet'), device('phone')];
  await revisit('send');

  assert.equal(picker().value, '');
  assert.match(sendStatus().textContent, /watch/);
  assert.equal(sendStatus().className, 'data bad');
});

test('a refresh the server refuses leaves the options that were confirmed', async () => {
  const before = offered();
  failNext = true;
  await revisit('send');
  // An emptied picker would quietly turn a chosen destination into all devices.
  assert.deepEqual(offered(), before);
});

test('the send picker refreshes when the window comes back to the front', async () => {
  roster = [device('laptop'), device('tablet'), device('phone'), device('printer')];
  showView('send');
  doc.fire('visibilitychange');
  await settle();
  assert.deepEqual(offered(), ['', 'tablet', 'phone', 'printer']);
});

test('a device approved after the devices view mounted appears in the list', async () => {
  roster = [device('laptop'), device('tablet')];
  showView('devices');
  await settle();
  assert.deepEqual(listed(), ['laptop', 'tablet']);

  roster = [device('laptop'), device('tablet'), device('phone')];
  await revisit('devices');
  assert.deepEqual(listed(), ['laptop', 'tablet', 'phone']);
});

test('a refresh the server refuses leaves the device rows that were confirmed', async () => {
  const before = listed();
  failNext = true;
  await revisit('devices');
  // Replacing a real list with an error because one background read failed
  // would lose the only interface that can undo a revocation.
  assert.deepEqual(listed(), before);
});

test('a successful send refreshes an already-mounted sender inbox locally', async () => {
  showView('send');
  await settle();
  let refreshes = 0;
  onInbox(() => { refreshes++; });
  sendView.__setSendImpl({
    server: async (_file, opts) => {
      opts.onProgress({
        total: 2, held: 1, sent: 0, inflight: 1,
        heldAt: [0], storedAt: [], inflightAt: [1],
      });
      return { total: 2, held: 1, sent: 1, inflight: 0, heldAt: [0], storedAt: [1] };
    },
    direct: async () => { throw new Error('the held path was expected'); },
  });

  const hold = find(sendPanel, (n) => n.getAttribute('id') === 'hold');
  const button = find(sendPanel, (n) => n.className === 'primary');
  hold.checked = true;
  sendView.stageFiles([new File(['sent'], 'sent.txt', { type: 'text/plain' })]);

  button.fire('click');
  await settle();
  await settle();

  assert.equal(refreshes, 1);
});

test('a failed file stays staged and the batch reports it after later files succeed', async () => {
  showView('send');
  await settle();
  const attempted = [];
  sendView.__setSendImpl({
    server: async (file) => {
      attempted.push(file.name);
      if (file.name === 'again.txt') throw new Error('connection lost');
      return { total: 0, held: 0, sent: 0, inflight: 0 };
    },
    direct: async () => { throw new Error('the held path was expected'); },
  });

  const hold = find(sendPanel, (n) => n.getAttribute('id') === 'hold');
  const button = find(sendPanel, (n) => n.className === 'primary');
  const list = find(sendPanel, (n) => n.getAttribute('aria-label') === 'Staged files');
  hold.checked = true;
  sendView.stageFiles([
    new File(['first'], 'again.txt', { type: 'text/plain' }),
    new File(['second'], 'done.txt', { type: 'text/plain' }),
  ]);

  button.fire('click');
  await settle();
  await settle();

  assert.deepEqual(attempted, ['again.txt', 'done.txt']);
  assert.equal(list.children.length, 1, 'only the failed file remains for retry');
  assert.equal(find(list.children[0], (n) => n.getAttribute('aria-label')?.startsWith('Name for')).value,
    'again.txt');
  assert.match(sendStatus().textContent, /1 file did not send/i);
  assert.match(sendStatus().textContent, /ready to retry/i);
  assert.equal(sendStatus().className, 'data bad');
});

test('staging snapshots a file before its disk handle can change', () => {
  let snapshots = 0;
  sendView.stageFiles([{
    name: 'mutable.bin',
    type: 'application/octet-stream',
    size: 3,
    lastModified: 123,
    slice() {
      snapshots++;
      return new Blob([new Uint8Array([1, 2, 3])]);
    },
  }]);
  assert.equal(snapshots, 1);
});
