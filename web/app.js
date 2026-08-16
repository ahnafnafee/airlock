import {
  MODE_SEALED, deriveMaster, makeCheck, verifyCheck,
  saveMaster, loadMaster, b64decode, kvGet, kvPut,
} from './crypto.js';
import { api, ApiError } from './api.js';
import { requestPersistence } from './staging.js';
import { observeCapabilities } from './inbound.js';
import { inboundTo, needsInstallGate, setBadge } from './ios.js';

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
  // Assigning the same hash again would add a history entry that goes nowhere,
  // so a person pressing Back would have to press it twice to leave a view.
  if (location.hash.slice(1) !== name) location.hash = name;
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
  // Before the first view is shown, so a drag already under way when the app
  // opens is the one that draws the drop zone. These listeners only record what
  // this browser turns out to be able to do; the send view attaches its own to
  // act on it.
  observeCapabilities();
  const first = location.hash.slice(1);
  showView(views.has(first) ? first : views.keys().next().value);
  // The hash is a view's address, so it has to be read as well as written.
  // Without this the system Back gesture and any link into a view move the
  // address and leave whatever was already on screen, which on Android is the
  // primary way people navigate and reads as the app ignoring them.
  addEventListener('hashchange', () => {
    const name = location.hash.slice(1);
    if (views.has(name)) showView(name);
  });
  subscribePush();
  // The badge is kept current here rather than inside the inbox view, so it
  // stays right whether or not that view has ever been opened. The nudge says
  // only that something changed, so the count is re-read rather than adjusted.
  refreshBadge();
  onInbox(() => refreshBadge());
  // Like push, a launch is an enhancement and never a gate. A share that cannot
  // be replayed leaves the app open on the send view rather than refusing to
  // start.
  handleLaunch().catch((err) => console.warn('launch handling failed', err));
  // A notification tapped on its body rather than on a button lands here, so a
  // window that was already open moves to the view the worker asked for. An
  // unknown name is ignored: showView hides every panel it is not given, so
  // acting on one would leave a blank app.
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'show' && views.has(event.data.view)) showView(event.data.view);
  });
  listen();
  // Delivery is peer to peer, so an open app is one that both sends what it owes
  // and takes what is owed to it. Every failure in here is logged: a device that
  // cannot run sessions is still a device that can browse its inbox.
  startSessions().catch((err) => console.warn('session setup failed', err));
}

// The pending inbound count on the app's own icon. On iOS it is the only rich
// notification affordance WebKit honors, which is why it is here at all, but it
// is worth the same on every platform that has the API and none of this asks
// which platform it is on.
//
// Inbound is a filter and not a reading of the endpoint, because /api/inbox
// answers with what this device sent as well as what it was sent. The predicate
// is inboundTo's, in one place, so the badge and the notification cannot come to
// disagree about what is waiting.
async function refreshBadge() {
  try {
    await setBadge(inboundTo(await api.inbox(), state.me?.node).length);
  } catch (err) {
    console.warn('the badge was not updated', err);
  }
}

// Loaded here rather than imported at the top so the peer connection and the
// whole direct-transfer path stay out of the boot path, which is the one an
// unlock has to wait behind.
async function startSessions() {
  const loading = import('./session.js');
  // Registered before anything is awaited, so a peer that offers the moment this
  // stream opens is answered rather than missed.
  onSignal(async (payload) => {
    try {
      await (await loading).handleSignal(payload);
    } catch (err) {
      console.warn('a signal could not be handled', err);
    }
  });

  const { drainQueue } = await loading;
  // Asked for before anything is staged, so a queued transfer is not evicted
  // between the two devices being online.
  //
  // WebKit shows no prompt for this and grants it heuristically, with being
  // installed to the Home Screen the heuristic that matters. A refusal is not
  // fatal and does not deserve a screen, but it changes what a queued transfer
  // is: storage the browser may reclaim under pressure, so one waiting for a
  // peer that is away can lose its staged chunks and have to start over.
  if (!await requestPersistence()) {
    console.warn('storage is not persistent: a queued transfer may be evicted before it is delivered');
  }
  drainQueue();
  onInbox(() => drainQueue());
}

const listeners = new Set();
const signalListeners = new Set();

// A view calls this to be told when something arrives. The event carries no
// detail, so the handler re-reads whatever it needs.
export function onInbox(fn) { listeners.add(fn); }

// A signal is the opposite: it carries the whole payload, because a session
// description has nowhere else to be read from.
export function onSignal(fn) { signalListeners.add(fn); }

// The open stream is what makes the inbox live without asking for a
// notification permission. Push stays for the case this cannot cover: an app
// that is not running at all.
function listen() {
  const source = new EventSource('/api/events');
  source.addEventListener('inbox', () => {
    for (const fn of listeners) fn();
  });
  // The payload is base64 because an SSE data field ends at the first newline
  // and a session description is full of them. It is passed on untouched: the
  // encoding is the stream's problem and the contents are the session's.
  source.addEventListener('signal', (event) => {
    for (const fn of signalListeners) fn(event.data);
  });
  // EventSource reconnects on its own after a drop, so there is nothing to
  // schedule here. This only reports a stream the browser gave up on.
  source.addEventListener('error', () => {
    if (source.readyState === EventSource.CLOSED) {
      console.warn('event stream closed');
    }
  });
}

// The two ways the operating system hands this app something to send. Neither
// uploads: both put what they were given on the send view's staging list, where
// it waits for a destination and a press of Send. That is the product, and it is
// also the only defense the share path has, because a share POST is a navigation
// and any page can navigate this browser.
async function handleLaunch() {
  // The view is shown before the payload reaches it, so the list the files land
  // on is the list already on screen. showView mounts synchronously and the
  // module is already loaded, so this import is a lookup rather than a fetch.
  const staging = async () => {
    showView('send');
    return import('./views/send.js');
  };

  // Android share sheet: the worker stashed the payload before redirecting here,
  // because the plaintext POST could not be allowed to reach the server. The
  // stash is cleared first, so the plaintext is not left at rest and a share is
  // offered once rather than on every later visit.
  if (new URLSearchParams(location.search).has('share')) {
    const pending = await kvGet('pending-share');
    await kvPut('pending-share', null);
    history.replaceState(null, '', '/');
    if (pending?.files?.length) (await staging()).stageFiles(pending.files);
    else if (pending?.text) (await staging()).stageText(pending.text);
  }

  // Windows: Chrome hands the app the files it was launched on, whether that was
  // Open with for a type the manifest names or the context-menu entry for
  // everything else. The shell says which files, and never which device they are
  // for, so they stage like anything else.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      (await staging()).stageFiles(files);
    });
  }
}

// The VAPID public key is base64url with the padding stripped, and
// applicationServerKey wants the raw bytes.
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Push is an enhancement, never a gate: every failure here is logged and the app
// carries on unnotified rather than refusing to open.
async function subscribePush() {
  if (!state.config.vapidKey || !('Notification' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (await Notification.requestPermission() !== 'granted') return;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.config.vapidKey),
      });
    await api.subscribePush(sub);
  } catch (err) {
    console.warn('push subscription failed', err);
  }
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

// Views register themselves on import. Order here is nav order. This is loaded
// from inside boot rather than awaited at the top level on purpose: a view
// imports this module back, so a top-level await would suspend this module
// while the view waited for it to finish evaluating, which is a deadlock that
// never boots at all. Loading from here lets this module finish first, so every
// export a view reaches for is already live when the view runs.
async function loadViews() {
  await import('./views/send.js');
  await import('./views/inbox.js');
  await import('./views/history.js');
  await import('./views/devices.js');
}

// A device is recorded the first time it asks who it is, and an approved device
// turns it on from its own Devices view. Polling rather than listening: the
// event stream is one of the things approval unlocks, so a waiting device has
// nothing to listen to yet.
async function waitForApproval() {
  const { renderStrip } = await import('./strip.js');
  $('pairing-node').textContent = state.me.node;
  renderStrip($('pairing-strip'), 48).setAll('sending');
  $('pairing').hidden = false;
  while (!state.me.allowed) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    state.me = await api.whoami().catch(() => state.me);
  }
  $('pairing').hidden = true;
}

async function boot() {
  // Before the first request, and well before the passphrase. A Home Screen web
  // app on iOS has its own storage partition and shares no IndexedDB, OPFS or
  // service worker registration with the same origin in a Safari tab, so a
  // passphrase set up in the tab would not exist in the installed app. Pairing
  // here would be setup silently thrown away, which is why this is a gate and
  // not a suggestion.
  if (needsInstallGate()) {
    $('install').hidden = false;
    return;
  }
  await loadViews();
  await registerWorker();

  state.me = await api.whoami();
  $('me').textContent = state.me.node;
  if (!state.me.allowed) await waitForApproval();
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

boot().catch((err) => {
  document.body.prepend(el('p', { class: 'bad', style: 'padding:16px' }, err.message));
});
