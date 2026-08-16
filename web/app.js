import {
  MODE_SEALED, deriveMaster, makeCheck, verifyCheck,
  saveMaster, loadMaster, b64decode, kvGet, kvPut,
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
  subscribePush();
  // Like push, a launch is an enhancement and never a gate. A share that cannot
  // be replayed leaves the app open on the send view rather than refusing to
  // start.
  handleLaunch().catch((err) => console.warn('launch handling failed', err));
}

// The two ways the operating system hands this app something to send. Both end
// in the send view's own upload loop, never in a copy of it.
async function handleLaunch() {
  // Android share sheet: the worker stashed the payload before redirecting here,
  // because the plaintext POST could not be allowed to reach the server. The
  // stash is cleared before the upload starts, so a share that fails is not
  // replayed on every later visit.
  if (new URLSearchParams(location.search).has('share')) {
    const pending = await kvGet('pending-share');
    await kvPut('pending-share', null);
    history.replaceState(null, '', '/');
    if (pending) {
      showView('send');
      const { sendFiles, sendText } = await import('./views/send.js');
      if (pending.files?.length) await sendFiles(pending.files);
      else if (pending.text) await sendText(pending.text);
    }
  }
  // Windows Open with: Chrome hands the app the files it was launched on.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      showView('send');
      const { sendFiles } = await import('./views/send.js');
      await sendFiles(await Promise.all(params.files.map((h) => h.getFile())));
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

async function boot() {
  await loadViews();
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

boot().catch((err) => {
  document.body.prepend(el('p', { class: 'bad', style: 'padding:16px' }, err.message));
});
