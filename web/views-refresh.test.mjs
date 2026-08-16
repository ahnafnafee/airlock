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
// An iPhone in a Safari tab, which is the one boot path that stops before it
// reaches the network: the install gate returns and nothing else in boot runs.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)' },
  configurable: true,
  writable: true,
});
globalThis.window = globalThis;

const { state, showView, registerView } = await import('./app.js');
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

await import('./views/send.js');
await import('./views/devices.js');
// Somewhere to switch to. Leaving a view and coming back is the whole gesture
// under test, and it needs a second destination to be a gesture at all.
registerView('other', 'Other', () => {});

const panels = doc.getElementById('views').children;
const [sendPanel, devicesPanel] = panels;

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

// Leaving the view and coming back is what a person does, and it is also the
// exact sequence that used to change nothing: registerView mounts at most once.
async function revisit(name) {
  showView('other');
  showView(name);
  await settle();
}

const picker = () => find(sendPanel, (n) => n.getAttribute('id') === 'to');
// The send view's status line is the last thing its panel holds.
const sendStatus = () => sendPanel.children.at(-1);
const offered = () => picker().children.map((o) => o.value);
const deviceRows = () => find(devicesPanel, (n) => n.tagName === 'UL').children;
// The node name each row is about, without the trailing "(this device)".
// A row that carries no name is not a device row, so its own text stands in and
// the mismatch reads as a value rather than as a crash in the helper.
const listed = () => deviceRows().map((li) => {
  const name = find(li, (n) => n.className?.includes('name'));
  return textOf(name || li).split(' ')[0];
});

test('the send picker offers every approved device except this one', async () => {
  roster = [device('laptop'), device('tablet'), device('desktop', false)];
  showView('send');
  await settle();
  // The device you are sitting at is not a destination, and a blocked one
  // cannot read what it is sent.
  assert.deepEqual(offered(), ['', 'tablet']);
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
