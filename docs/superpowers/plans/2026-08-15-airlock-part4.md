# Airlock Phase 1 Implementation Plan, part 4: the application

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-15-airlock-part3.md`. Task numbering is unbroken and the **Global Constraints** in `2026-08-15-airlock.md` bind every task here.

**Specs:** `docs/superpowers/specs/2026-08-15-airlock-design.md` for behavior, and `docs/superpowers/specs/2026-08-15-airlock-visual-design.md` for every color, type, spacing and copy decision. The visual spec is binding: do not invent a palette, a typeface, or a phrase that is not in it.

---

### Task 10: Application shell, design tokens and unlock

**Files:**
- Create: `web/tokens.css`
- Create: `web/app.css`
- Modify: `web/index.html` (replace the placeholder from Task 6)
- Create: `web/api.js`
- Create: `web/app.js`
- Modify: `main.go` (extend the embed directive)

**Interfaces:**
- Consumes: `deriveMaster`, `makeCheck`, `verifyCheck`, `saveMaster`, `loadMaster`, `b64decode`, `MODE_SEALED` from `web/crypto.js` (Task 9).
- Produces:
  - `web/api.js`: `export const api = {...}` and `export class ApiError extends Error`
  - `web/app.js`: `export const state = { mk, mode, config, me }`, `export function showView(name)`, `export function el(tag, attrs, ...children)`, `export function registerView(name, mount)`

**The shell owns three things and nothing else:** booting (identity, config, key), the unlock flow, and switching between views. Each view is a module that registers itself. Task 11 registers `send`, Task 12 registers `inbox`, and Phase 2 registers `history` and `devices`.

- [ ] **Step 1: Write `web/tokens.css`**

Every value here comes from the visual design spec. Nothing in the app may hardcode a color or a font.

```css
:root {
  /* The ground is a desaturated green-black, the color of a pressure vessel
     under low light. Deliberately not neutral near-black, which is where every
     dark tool ends up by default. */
  --hull: #0E1614;
  --hull-raised: #16211E;
  --seam: #24332E;
  --bone: #E4E7E1;
  --vapor: #8A9A93;

  /* Two signal colors, each with one job it never leaves. Amber is always
     "in transit", green is always "sealed or already held". Neither is ever
     used for the other's meaning, which is what lets a reader learn the
     interface once and then read state without reading words. */
  --sodium: #F0A83C;
  --seal: #4FD1A5;
  --breach: #E8654F;

  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  --label: 11px;
  --data: 13px;
  --body: 15px;
  --title: 20px;
  --wordmark: 28px;

  --gap: 16px;
  --radius: 3px;
}
```

- [ ] **Step 2: Write `web/app.css`**

```css
* { box-sizing: border-box; }

html, body {
  margin: 0;
  background: var(--hull);
  color: var(--bone);
  font: var(--body)/1.5 var(--sans);
  -webkit-text-size-adjust: 100%;
}

/* Labels are the identity of this interface: mono, uppercase, tracked wide,
   small. Machine labeling reads as machine labeling. */
.label {
  font: var(--label)/1.2 var(--mono);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--vapor);
}

.data { font: var(--data)/1.4 var(--mono); }
.muted { color: var(--vapor); }
.bad { color: var(--breach); }

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap);
  padding: var(--gap);
  border-bottom: 1px solid var(--seam);
}

.wordmark {
  font: var(--wordmark)/1 var(--mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  margin: 0;
}

main { max-width: 760px; margin: 0 auto; padding: var(--gap) var(--gap) 96px; }
h2 { font: var(--title)/1.3 var(--sans); margin: 0 0 var(--gap); }

/* The hatch. A bounded chamber you put something into. */
#drop {
  border: 1px dashed var(--seam);
  border-radius: var(--radius);
  background: var(--hull-raised);
  padding: 48px var(--gap);
  text-align: center;
  color: var(--vapor);
  transition: border-color 120ms ease, color 120ms ease;
}
#drop.over { border-color: var(--sodium); color: var(--bone); }
#drop button {
  background: none;
  border: 0;
  padding: 0;
  color: var(--sodium);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

button.primary {
  background: var(--sodium);
  color: #1A1206;
  border: 0;
  border-radius: var(--radius);
  padding: 10px 18px;
  font: 600 var(--body)/1 var(--sans);
  cursor: pointer;
}
button.ghost {
  background: none;
  color: var(--bone);
  border: 1px solid var(--seam);
  border-radius: var(--radius);
  padding: 8px 14px;
  font: var(--data)/1 var(--mono);
  cursor: pointer;
}

input[type="password"], input[type="text"], select {
  background: var(--hull-raised);
  color: var(--bone);
  border: 1px solid var(--seam);
  border-radius: var(--radius);
  padding: 10px 12px;
  font: var(--body)/1 var(--sans);
  width: 100%;
}

:focus-visible { outline: 2px solid var(--sodium); outline-offset: 2px; }

/* Navigation is one element that changes position rather than two designs:
   fixed to the bottom edge where thumbs are, sticky to the side where a
   cursor is. */
nav {
  position: fixed;
  inset: auto 0 0 0;
  display: flex;
  background: var(--hull-raised);
  border-top: 1px solid var(--seam);
}
nav button {
  flex: 1;
  background: none;
  border: 0;
  border-top: 2px solid transparent;
  padding: 14px 4px;
  color: var(--vapor);
  font: var(--label)/1 var(--mono);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: pointer;
}
nav button[aria-current="page"] { color: var(--bone); border-top-color: var(--sodium); }

@media (min-width: 720px) {
  nav {
    inset: 0 auto 0 0;
    flex-direction: column;
    justify-content: center;
    border-top: 0;
    border-right: 1px solid var(--seam);
    padding: 0 4px;
  }
  nav button {
    flex: 0;
    border-top: 0;
    border-left: 2px solid transparent;
    padding: 14px 18px;
    text-align: left;
  }
  nav button[aria-current="page"] { border-left-color: var(--sodium); }
  main { padding-bottom: var(--gap); }
}

[hidden] { display: none !important; }
```

- [ ] **Step 3: Replace `web/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Airlock</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0E1614">
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header>
  <h1 class="wordmark">Airlock</h1>
  <span id="me" class="data muted"></span>
</header>

<section id="unlock" hidden>
  <main>
    <h2 id="unlock-title">Enter the passphrase</h2>
    <p class="muted" id="unlock-note">
      It never leaves this device. Every device you set up uses the same one.
    </p>
    <form id="unlock-form">
      <p><input type="password" id="passphrase" autocomplete="current-password" required></p>
      <p><button class="primary" type="submit">Unlock</button></p>
    </form>
    <p id="unlock-error" class="bad" role="alert"></p>
  </main>
</section>

<div id="app" hidden>
  <main id="views"></main>
  <nav id="nav" aria-label="Views"></nav>
</div>

<script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Write `web/api.js`**

```js
// One typed wrapper over the HTTP API, so no view builds a URL by hand and a
// route change has exactly one place to land.

export class ApiError extends Error {
  constructor(status, body) {
    super(`${status}: ${body}`);
    this.status = status;
  }
}

async function req(path, init = {}) {
  const res = await fetch(path, init);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res;
}

const json = async (path, init) => (await req(path, init)).json();

const sendJSON = (path, body) => json(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const sendBytes = (path, bytes, method = 'PUT') =>
  req(path, { method, body: bytes });

export const api = {
  whoami: () => json('/api/whoami'),
  config: () => json('/api/config'),
  setCheck: (bytes) => sendBytes('/api/check', bytes, 'POST'),

  devices: () => json('/api/devices'),
  allow: (node) => req(`/api/devices/${encodeURIComponent(node)}/allow`, { method: 'POST' }),
  revoke: (node) => req(`/api/devices/${encodeURIComponent(node)}/revoke`, { method: 'POST' }),
  markPaired: () => req('/api/devices/me/paired', { method: 'POST' }),

  // Returns {id, missing}. This one call is the dedup, delta-sync and resume
  // mechanism: send every id, get back only what the server lacks.
  createTransfer: (cids, to) => sendJSON('/api/transfer', { cids, to }),
  transfer: (id) => json(`/api/transfer/${id}`),
  putRecord: (id, kind, bytes) => sendBytes(`/api/transfer/${id}/${kind}`, bytes),
  getRecord: async (id, kind) =>
    new Uint8Array(await (await req(`/api/transfer/${id}/${kind}`)).arrayBuffer()),
  deleteTransfer: (id) => req(`/api/transfer/${id}`, { method: 'DELETE' }),

  putChunk: (cid, bytes) => sendBytes(`/api/chunk/${cid}`, bytes),
  getChunk: async (cid) =>
    new Uint8Array(await (await req(`/api/chunk/${cid}`)).arrayBuffer()),

  inbox: () => json('/api/inbox'),
  history: () => json('/api/history'),
};
```

- [ ] **Step 5: Write `web/app.js`**

```js
import {
  MODE_SEALED, deriveMaster, makeCheck, verifyCheck,
  saveMaster, loadMaster, b64decode,
} from './crypto.js';
import { api, ApiError } from './api.js';

export const state = { mk: null, mode: MODE_SEALED, config: null, me: null };

const views = new Map();
const $ = (id) => document.getElementById(id);

// A tiny element helper, because building nodes beats innerHTML when the text
// comes from another device and is attacker-shaped the moment one is
// compromised.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// A view registers a mount function and gets its own container. Views never
// know about each other.
export function registerView(name, title, mount) {
  const panel = el('div', { hidden: true });
  $('views').append(panel);
  views.set(name, { title, mount, panel, mounted: false });

  const button = el('button', {
    type: 'button',
    onclick: () => showView(name),
  }, title);
  button.dataset.view = name;
  $('nav').append(button);
}

export function showView(name) {
  for (const [key, v] of views) {
    const active = key === name;
    v.panel.hidden = !active;
    if (active && !v.mounted) {
      v.mounted = true;
      v.mount(v.panel);
    }
  }
  for (const b of $('nav').children) {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  location.hash = name;
}

async function unlock(passphrase) {
  const candidate = await deriveMaster(passphrase, state.config.salt);

  if (state.config.check === null) {
    // First device on this server. This passphrase becomes the one every other
    // device must use.
    try {
      await api.setCheck(await makeCheck(candidate));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Another device set it between our config read and now. Re-read and
        // verify against theirs rather than overwriting.
        state.config = await api.config();
        return unlock(passphrase);
      }
      throw err;
    }
  } else if (!await verifyCheck(candidate, b64decode(state.config.check))) {
    return false;
  }

  state.mk = candidate;
  await saveMaster(candidate);
  await api.markPaired().catch(() => {});
  return true;
}

function enterApp() {
  $('unlock').hidden = true;
  $('app').hidden = false;
  const first = location.hash.slice(1);
  showView(views.has(first) ? first : views.keys().next().value);
}

async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { type: 'module' });
    // Downloads route through the worker, so wait until one controls this page.
    if (!navigator.serviceWorker.controller) await navigator.serviceWorker.ready;
  } catch (err) {
    console.warn('service worker registration failed', err);
  }
}

async function boot() {
  await registerWorker();

  state.me = await api.whoami();
  $('me').textContent = state.me.node;
  state.config = await api.config();
  state.mk = await loadMaster();

  // Force setup whenever the server has no verifier, even if this device still
  // holds a key. A wiped server means a new salt, so the stored key would seal
  // transfers no other device could open.
  const stale = state.mk && state.config.check !== null
    && !await verifyCheck(state.mk, b64decode(state.config.check));
  if (stale) state.mk = null;

  if (state.mk && state.config.check !== null) {
    enterApp();
    return;
  }

  $('unlock').hidden = false;
  if (state.config.check === null) {
    $('unlock-title').textContent = 'Choose a passphrase';
    $('unlock-note').textContent =
      'This server has no passphrase yet. Every device you set up must enter the same one.';
    $('passphrase').autocomplete = 'new-password';
  }
  $('unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('unlock-error').textContent = '';
    try {
      if (await unlock($('passphrase').value)) enterApp();
      else $('unlock-error').textContent =
        'That passphrase does not match the one this server was set up with.';
    } catch (err) {
      $('unlock-error').textContent = err.message;
    }
  });
}

// Views register themselves on import. Order here is nav order.
await import('./views/send.js');
await import('./views/inbox.js');

boot().catch((err) => {
  document.body.prepend(el('p', { class: 'bad', style: 'padding:16px' }, err.message));
});
```

- [ ] **Step 6: Create placeholder view modules**

Tasks 11 and 12 fill these. They must exist now or the imports above fail.

`web/views/send.js`:

```js
import { registerView } from '../app.js';
registerView('send', 'Send', (panel) => { panel.textContent = 'Task 11'; });
```

`web/views/inbox.js`:

```js
import { registerView } from '../app.js';
registerView('inbox', 'Inbox', (panel) => { panel.textContent = 'Task 12'; });
```

- [ ] **Step 7: Extend the embed directive**

In `main.go`, replace the `//go:embed` line with:

```go
//go:embed web/index.html web/tokens.css web/app.css web/api.js web/app.js web/crypto.js web/cdc.js web/views
```

`web/package.json` and the `*.test.mjs` files are deliberately absent: they are development files and must not ship in the binary.

- [ ] **Step 8: Verify**

```bash
go build ./... && go vet ./... && go test ./...
AIRLOCK_TOKEN=devtoken go run . --auth=token --data ./devdata
```

Open `http://localhost:8080/login?t=devtoken`. Localhost is a secure context even over plain HTTP, so Web Crypto and the service worker both work in development.

Check, in order:

1. The header shows the wordmark and your node identity.
2. The panel says "Choose a passphrase" on a fresh data directory.
3. Enter one. The app appears with a nav showing Send and Inbox.
4. Reload. It goes straight to the app with no prompt.
5. Delete `devdata/check.bin`, reload, and confirm it returns to setup rather than silently using the stored key.
6. Resize below 720px and confirm the nav moves to the bottom edge.
7. Tab through the unlock form and confirm every control shows a visible amber focus ring.

- [ ] **Step 9: Commit**

```bash
git add web/tokens.css web/app.css web/index.html web/api.js web/app.js web/views main.go
git commit -m "feat(web): application shell, design tokens and passphrase unlock"
```

---

### Task 11: Upload pipeline with dedup negotiation

**Files:**
- Create: `web/upload.js`
- Create: `web/strip.js`
- Modify: `web/views/send.js` (replace the placeholder)
- Test: `web/upload.test.mjs`

**Interfaces:**
- Consumes: `chunkFile` from `cdc.js`, `chunkIdentity`/`sealChunk`/`sealRecord`/`packHashes`/`DOMAIN` from `crypto.js`, `api` from `api.js`, `el`/`state`/`registerView` from `app.js`.
- Produces:
  - `export async function upload(file, opts) -> {id, total, held, sent}` where `opts` is `{mk, mode, to, cdc, api, onProgress}`
  - `export function renderStrip(container, total)` returning `{ set(index, state), setAll(state) }`

**Two passes over the file, on purpose.** Pass one computes every chunk id and discards the bytes, so memory stays flat no matter the file size. Then one call asks the server which ids it lacks. Pass two re-reads the file and uploads only those. Re-reading from disk is far cheaper than uploading, and chunking is deterministic so the second pass produces the same boundaries.

Holding pass one's bytes to avoid the re-read would mean holding the whole file in memory, which fails at exactly the file sizes this product exists for.

**Concurrency is four.** Measured guidance puts a 110 MB upload at roughly 22 seconds sequential and 12 seconds at three in flight, with little benefit past four. Peak buffered memory is four times the maximum chunk size.

- [ ] **Step 1: Write the failing tests**

Create `web/upload.test.mjs`. It uses a fake api object, so no server and no DOM are involved.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { upload } from './upload.js';
import { deriveMaster, MODE_SEALED, MODE_PLAIN, b64encode } from './crypto.js';

const CDC = { min: 64, normal: 128, max: 512, maskS: (1 << 9) - 1, maskL: (1 << 7) - 1 };
const mkP = deriveMaster('test passphrase', b64encode(new Uint8Array(16).fill(3)));

function fakeFile(bytes, name = 'f.bin', type = 'application/octet-stream') {
  return {
    name, type, size: bytes.length,
    stream() {
      let off = 0;
      return new ReadableStream({
        pull(c) {
          if (off >= bytes.length) { c.close(); return; }
          c.enqueue(bytes.subarray(off, off + 1000));
          off += 1000;
        },
      });
    },
  };
}

function fakeApi(held = new Set()) {
  const calls = { chunks: [], records: [], created: [] };
  return {
    calls,
    async createTransfer(cids, to) {
      calls.created.push({ cids, to });
      return { id: 'a'.repeat(32), missing: cids.filter((c) => !held.has(c)) };
    },
    async putRecord(id, kind, bytes) { calls.records.push({ kind, length: bytes.length }); },
    async putChunk(cid, bytes) { calls.chunks.push(cid); held.add(cid); },
  };
}

function pseudoRandom(n, seed = 5) {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

test('uploads every chunk the server lacks, and the two records', async () => {
  const api = fakeApi();
  const data = pseudoRandom(20000);
  const r = await upload(fakeFile(data), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.equal(api.calls.created.length, 1);
  assert.equal(api.calls.chunks.length, r.total);
  assert.equal(r.held, 0);
  assert.deepEqual(api.calls.records.map((x) => x.kind).sort(), ['chunklist', 'meta']);
});

test('a second upload of identical content sends no chunks at all', async () => {
  // This is dedup, delta sync and resume, all of which are the same mechanism.
  const held = new Set();
  const data = pseudoRandom(20000, 9);
  const first = fakeApi(held);
  const r1 = await upload(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: first });

  const second = fakeApi(held);
  const r2 = await upload(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: second });

  assert.equal(second.calls.chunks.length, 0, 'a duplicate upload must send nothing');
  assert.equal(r2.held, r1.total);
  assert.equal(r2.sent, 0);
});

test('an edited file re-sends only the chunks that changed', async () => {
  // The delta-sync property. Fixed-size chunking would re-send everything after
  // the edit.
  const held = new Set();
  const data = pseudoRandom(200000, 11);
  await upload(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: fakeApi(held) });

  const edited = new Uint8Array(data.length + 50);
  edited.set(data.subarray(0, 2000), 0);
  edited.set(pseudoRandom(50, 77), 2000);
  edited.set(data.subarray(2000), 2050);

  const second = fakeApi(held);
  const r = await upload(fakeFile(edited), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: second });
  assert.ok(r.sent < r.total * 0.2, `re-sent ${r.sent} of ${r.total} chunks after a 50-byte edit`);
});

test('progress reports held chunks before any upload starts', async () => {
  const held = new Set();
  const data = pseudoRandom(20000, 13);
  await upload(fakeFile(data), { mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: fakeApi(held) });

  const seen = [];
  await upload(fakeFile(data), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api: fakeApi(held),
    onProgress: (p) => seen.push({ ...p }),
  });
  assert.ok(seen.length > 0);
  assert.ok(seen[0].held > 0, 'the first progress report should already show dedup hits');
});

test('a failed chunk upload is retried', async () => {
  let failures = 2;
  const api = fakeApi();
  const inner = api.putChunk;
  api.putChunk = async (cid, bytes) => {
    if (failures-- > 0) throw new Error('network');
    return inner(cid, bytes);
  };
  const r = await upload(fakeFile(pseudoRandom(20000, 17)), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.equal(r.sent, r.total, 'every chunk should land despite transient failures');
});

test('plaintext mode uploads unsealed bytes', async () => {
  const api = fakeApi();
  const r = await upload(fakeFile(pseudoRandom(5000, 19)), {
    mk: await mkP, mode: MODE_PLAIN, to: [], cdc: CDC, api,
  });
  assert.equal(r.sent, r.total);
});

test('an empty file still produces a transfer', async () => {
  const api = fakeApi();
  const r = await upload(fakeFile(new Uint8Array(0), 'empty.txt'), {
    mk: await mkP, mode: MODE_SEALED, to: [], cdc: CDC, api,
  });
  assert.equal(r.total, 0);
  assert.deepEqual(api.calls.records.map((x) => x.kind).sort(), ['chunklist', 'meta']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test web/upload.test.mjs`
Expected: FAIL, cannot find module `./upload.js`.

- [ ] **Step 3: Write `web/upload.js`**

```js
import { chunkFile } from './cdc.js';
import {
  DOMAIN, chunkIdentity, sealChunk, sealRecord, packHashes,
} from './crypto.js';

const CONCURRENCY = 4;
const RETRIES = 4;

const enc = (s) => new TextEncoder().encode(s);

// Bounded retry with backoff. This is the whole resume-across-a-dropped-
// connection story: chunk writes are idempotent server-side, so replaying one
// is always safe.
async function withRetry(fn) {
  let delay = 400;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// upload runs two passes over the file.
//
// Pass one computes every chunk id and throws the bytes away, so memory stays
// flat regardless of file size. One call then asks the server which of those ids
// it lacks. Pass two re-reads the file and uploads only those.
//
// Keeping pass one's bytes to avoid the second read would mean holding the whole
// file in memory, which fails at exactly the sizes this product exists for.
// Re-reading from disk is far cheaper than uploading, and chunking is
// deterministic so the second pass cuts at identical boundaries.
export async function upload(file, opts) {
  const { mk, mode, to, cdc, api, onProgress = () => {} } = opts;

  const ids = [];
  for await (const plain of chunkFile(file, cdc)) {
    ids.push(await chunkIdentity(mk, mode, plain));
  }

  const { id, missing } = await api.createTransfer(ids.map((x) => x.cid), to);
  const wanted = new Set(missing);

  const progress = { id, total: ids.length, held: ids.length - wanted.size, sent: 0 };
  // Report before uploading anything, so a re-send reads as an immediate wave of
  // already-held chunks rather than a stalled bar.
  onProgress({ ...progress });

  await uploadRecords(api, mk, mode, id, file, ids);

  if (wanted.size === 0) return progress;

  const inflight = new Set();
  let index = 0;
  for await (const plain of chunkFile(file, cdc)) {
    const { h, cid } = ids[index++];
    if (!wanted.has(cid)) continue;

    const sealed = await sealChunk(mk, mode, h, cid, plain);
    const p = withRetry(() => api.putChunk(cid, sealed))
      .then(() => {
        progress.sent++;
        onProgress({ ...progress });
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
  }
  await Promise.all(inflight);

  return progress;
}

async function uploadRecords(api, mk, mode, id, file, ids) {
  const meta = await sealRecord(mk, mode, DOMAIN.META, id, enc(JSON.stringify({
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
  })));
  await withRetry(() => api.putRecord(id, 'meta', meta));

  const list = await sealRecord(mk, mode, DOMAIN.LIST, id, packHashes(ids.map((x) => x.h)));
  await withRetry(() => api.putRecord(id, 'chunklist', list));
}
```

Records go up once, from `uploadRecords`, before the chunk loop. The chunk list must exist on the server before the chunks it names, so that a transfer interrupted halfway is still openable as far as it got rather than being an opaque pile of ids.

- [ ] **Step 4: Write `web/strip.js`**

```js
import { el } from './app.js';

// The chunk strip. A transfer renders as a row of segments, one per chunk,
// bucketed when there are thousands. It replaces the progress bar rather than
// joining it, because it shows the thing a progress bar hides: how much of this
// file the server already had.
const MAX_SEGMENTS = 240;

export function renderStrip(container, total) {
  const count = Math.min(total, MAX_SEGMENTS) || 1;
  const perSegment = Math.ceil((total || 1) / count);
  const segments = [];

  const row = el('div', { class: 'strip', role: 'img', 'aria-label': 'Transfer progress' });
  for (let i = 0; i < count; i++) {
    const seg = el('span', { class: 'seg pending' });
    segments.push(seg);
    row.append(seg);
  }
  container.append(row);

  const apply = (seg, state) => { seg.className = `seg ${state}`; };

  return {
    set(index, state) { apply(segments[Math.floor(index / perSegment)], state); },
    setRange(from, to, state) {
      for (let i = from; i < to; i++) this.set(i, state);
    },
    setAll(state) { segments.forEach((s) => apply(s, state)); },
  };
}
```

Append to `web/app.css`:

```css
.strip {
  display: flex;
  gap: 1px;
  height: 22px;
  margin: var(--gap) 0 6px;
}
.seg { flex: 1; border-radius: 1px; background: transparent; box-shadow: inset 0 0 0 1px var(--seam); }
.seg.held { background: var(--seal); box-shadow: none; animation: fade-in 120ms ease both; }
.seg.sending { background: var(--sodium); box-shadow: none; animation: cycle 1.4s ease-in-out infinite; }
.seg.stored { background: var(--vapor); box-shadow: none; }

@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes cycle { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

@media (prefers-reduced-motion: reduce) {
  .seg.held, .seg.sending { animation: none; }
}
```

- [ ] **Step 5: Write `web/views/send.js`**

```js
import { registerView, state, el } from '../app.js';
import { api } from '../api.js';
import { upload } from '../upload.js';
import { renderStrip } from '../strip.js';

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

registerView('send', 'Send', (panel) => {
  const picker = el('input', { type: 'file', multiple: true, hidden: true });
  const drop = el('div', { id: 'drop' },
    'Drop files here, ',
    el('button', { type: 'button', onclick: () => picker.click() }, 'or choose'),
    picker);

  const recipient = el('select', { id: 'to' }, el('option', { value: '' }, 'All my devices'));
  const status = el('div', { class: 'data muted' });
  const progress = el('div');

  panel.append(
    el('h2', {}, 'Send'),
    drop,
    el('p', { class: 'label' }, 'To'),
    recipient,
    progress,
    status);

  api.devices().then((devices) => {
    for (const d of devices) {
      if (d.node === state.me.node || !d.allowed) continue;
      recipient.append(el('option', { value: d.node }, d.node));
    }
  }).catch(() => {});

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('over'));
  }
  drop.addEventListener('drop', (e) => { e.preventDefault(); send([...e.dataTransfer.files]); });
  picker.addEventListener('change', (e) => send([...e.target.files]));

  async function send(files) {
    const to = recipient.value ? [recipient.value] : [];
    for (const file of files) {
      progress.replaceChildren();
      let strip = null;
      try {
        const r = await upload(file, {
          mk: state.mk, mode: state.mode, to, cdc: state.config.cdc, api,
          onProgress: (p) => {
            if (!strip) strip = renderStrip(progress, p.total);
            // Held chunks were never uploaded and must never render as stored:
            // the two colors mean different things and the distinction is the
            // whole point of the strip.
            strip.setRange(0, p.held, 'held');
            strip.setRange(p.held, p.held + p.sent, 'stored');
            status.textContent =
              `${file.name} · ${humanSize(file.size)} · ${p.held} of ${p.total} held`;
          },
        });
        status.textContent = `Sent ${file.name} · ${r.held} of ${r.total} chunks were already here`;
      } catch (err) {
        status.textContent = `${file.name} did not send. ${err.message}`;
        status.className = 'data bad';
      }
    }
  }
});
```

The strip is bucketed, so `setRange` may map several chunks onto one segment. That is why `held` is painted first and `stored` second: within a shared segment the more recent state wins, which matches what a reader expects to see moving.

- [ ] **Step 6: Run tests and verify by hand**

```bash
node --test web/upload.test.mjs
go build ./... && AIRLOCK_TOKEN=devtoken go run . --auth=token --data ./devdata --max-chunk 1048576
```

Check, in order:

1. Drop a 50 MB file. The strip fills amber then settles, and the caption counts.
2. Drop **the same file again**. The strip goes green almost instantly and the caption reads `N of N held`. Confirm with the server log or `ls devdata/chunks` that no new chunk files appeared.
3. Append a few bytes to that file and send it. Only a handful of segments should be amber.
4. Kill the network mid-upload, restore it within a few seconds, and confirm the upload continues rather than failing.
5. Reload the page mid-upload, drop the same file again, and confirm it resumes from where it stopped with no stored client state.

- [ ] **Step 7: Commit**

```bash
git add web/upload.js web/strip.js web/views/send.js web/upload.test.mjs web/app.css
git commit -m "feat(web): two-pass upload with dedup negotiation and parallel chunk transfer"
```

---

### Task 12: Service worker download and inbox

**Files:**
- Create: `web/sw.js`
- Modify: `web/views/inbox.js` (replace the placeholder)
- Modify: `main.go` (embed `sw.js`)

**Interfaces:**
- Consumes: `openChunk`, `openRecord`, `unpackHashes`, `modeOf`, `loadMaster`, `b64decode`, `DOMAIN` from `crypto.js`.
- Produces: a `GET /dl/{id}` route handled entirely in the worker.

**Why the worker owns downloads.** It fetches chunks, decrypts them, and returns a synthesized streaming `Response` carrying `Content-Disposition`. The browser then saves the file with its own progress UI, streaming to disk, so a 20 GB file never sits in memory. The same code path works on Android and Windows, which removes any need for the File System Access API.

**Integrity comes from the tag, not from a separate check.** The sealed chunk list gives each chunk's content hash, and the chunk's key derives from that hash. If the server reorders, substitutes, or truncates anything, GCM authentication fails and the stream errors. A separate id verification loop would be a second authority for the same fact.

- [ ] **Step 1: Write `web/sw.js`**

```js
import {
  DOMAIN, openChunk, openRecord, unpackHashes, modeOf, loadMaster, b64decode,
} from './crypto.js';

// Registered with {type:'module'} so these imports work.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method === 'GET' && url.pathname.startsWith('/dl/')) {
    event.respondWith(download(url.pathname.slice(4)));
  }
});

async function download(id) {
  const mk = await loadMaster();
  if (!mk) return new Response('Locked. Open Airlock and unlock this device first.', { status: 403 });

  try {
    const info = await (await fetch(`/api/transfer/${id}`)).json();

    const listRecord = new Uint8Array(
      await (await fetch(`/api/transfer/${id}/chunklist`)).arrayBuffer());
    // The mode byte on the record says which scheme sealed this transfer, so a
    // reader never has to be told.
    const mode = modeOf(listRecord);
    const hashes = unpackHashes(await openRecord(mk, DOMAIN.LIST, id, listRecord));
    const meta = JSON.parse(new TextDecoder().decode(
      await openRecord(mk, DOMAIN.META, id, b64decode(info.meta))));

    if (hashes.length !== info.cids.length) {
      throw new Error('the chunk list and the server record disagree on length');
    }

    let next = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (next >= hashes.length) { controller.close(); return; }
        const i = next++;
        const res = await fetch(`/api/chunk/${info.cids[i]}`);
        if (!res.ok) { controller.error(new Error(`chunk ${i}: ${res.status}`)); return; }
        const sealed = new Uint8Array(await res.arrayBuffer());
        // Throws if the chunk was substituted, reordered, or corrupted: its key
        // derives from the hash the sealed list gives for this position.
        controller.enqueue(await openChunk(mk, mode, hashes[i], info.cids[i], sealed));
      },
    });

    const filename = encodeURIComponent(meta.name);
    return new Response(body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(meta.size),
        'Content-Disposition':
          `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
      },
    });
  } catch (err) {
    return new Response(`Could not open this transfer. ${err.message}`, { status: 500 });
  }
}
```

- [ ] **Step 2: Write `web/views/inbox.js`**

```js
import { registerView, state, el } from '../app.js';
import { api } from '../api.js';
import { DOMAIN, openRecord, b64decode } from '../crypto.js';

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

registerView('inbox', 'Inbox', (panel) => {
  const list = el('ul', { class: 'rows' });
  panel.append(el('h2', {}, 'Inbox'), list);
  refresh();

  async function refresh() {
    const transfers = await api.inbox();
    list.replaceChildren();

    if (transfers.length === 0) {
      list.append(el('li', { class: 'muted' },
        'Nothing waiting. Anything sent from another device lands here.'));
      return;
    }

    for (const t of transfers) {
      list.append(await row(t));
    }
  }

  async function row(t) {
    let name = 'Incomplete transfer';
    let detail = `from ${t.sender} · ${ago(t.createdAt)}`;
    let openable = false;

    if (t.complete) {
      try {
        const meta = JSON.parse(new TextDecoder().decode(
          await openRecord(state.mk, DOMAIN.META, t.id, b64decode(t.meta))));
        name = meta.name;
        detail = `${humanSize(meta.size)} · from ${t.sender} · ${ago(t.createdAt)}`;
        openable = true;
      } catch {
        // Sealed under a different passphrase, or tampered with. Say so rather
        // than showing a name we cannot vouch for.
        name = 'Cannot open';
        detail = `from ${t.sender} · sealed with a different passphrase`;
      }
    } else {
      detail += ` · ${t.cids.length - t.missing.length} of ${t.cids.length} chunks`;
    }

    const actions = el('div', { class: 'actions' });
    if (openable) {
      actions.append(el('a', { class: 'ghost', href: `/dl/${t.id}`, download: '' }, 'Save'));
    }
    actions.append(el('button', {
      class: 'ghost', type: 'button',
      onclick: async () => { await api.deleteTransfer(t.id); await refresh(); },
    }, 'Delete'));

    return el('li', {},
      el('div', {}, el('div', { class: 'name' }, name), el('div', { class: 'data muted' }, detail)),
      actions);
  }
});
```

Every value here goes through `textContent` and constructed nodes rather than `innerHTML`, because filenames come from another device and are attacker-shaped input the moment any device is compromised.

Append to `web/app.css`:

```css
.rows { list-style: none; padding: 0; margin: 0; }
.rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap);
  padding: 14px 0;
  border-bottom: 1px solid var(--seam);
}
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; gap: 8px; flex: none; }
.actions a.ghost { text-decoration: none; display: inline-block; }
```

- [ ] **Step 3: Embed the worker**

In `main.go`, replace the embed directive with its Phase 1 final form:

```go
//go:embed web/index.html web/tokens.css web/app.css web/api.js web/app.js web/crypto.js web/cdc.js web/upload.js web/strip.js web/sw.js web/views
```

- [ ] **Step 4: Verify**

```bash
go build ./... && go vet ./... && go test ./... && node --test web/*.test.mjs
AIRLOCK_TOKEN=devtoken go run . --auth=token --data ./devdata --max-chunk 1048576
```

Check, in order:

1. Send a file, switch to Inbox, and confirm it appears with its real filename and size.
2. Click Save. The browser's own download UI shows the correct name and a real progress bar.
3. `cmp` the downloaded file against the original. They must be byte-identical.
4. `cat` any file under `devdata/chunks/`. It must be unreadable binary. If you can read your file, encryption is not in the path and this task is not done.
5. Corrupt one chunk file on the server with `printf 'x' | dd of=<chunk> bs=1 seek=5 conv=notrunc`, then download again. The download must fail rather than produce a damaged file.
6. Clear IndexedDB, reload without unlocking, and confirm `/dl/{id}` returns the 403 message rather than a corrupt file.
7. Send a file named `<img src=x onerror=alert(1)>.txt` and confirm the inbox renders it as literal text with no alert.

- [ ] **Step 5: Commit**

```bash
git add web/sw.js web/views/inbox.js web/app.css main.go
git commit -m "feat(web): streaming decrypt-on-download in the service worker, and the inbox"
```

---

## Phase 1 complete

At this point Airlock sends and receives files end to end with dedup, delta sync,
and resume, behind a Tailscale identity gate, with the server holding nothing but
ciphertext.

Phase 2 adds: device pairing and the recipient picker UI, transfer history,
thumbnails, Web Push, PWA install and share target, relays, the Android shell for
silent background receive, and the throughput benchmark that settles the
`tailscale-mode` default.
