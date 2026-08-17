import {
  deriveMaster, makeCheck, verifyCheck,
  saveMaster, loadMaster, b64decode, kvGet, kvPut,
} from './crypto.js';
import { api, ApiError } from './api.js';
import { observeCapabilities } from './inbound.js';
import { inboundTo, needsInstallGate, setBadge } from './ios.js';

export const state = { mk: null, config: null, me: null };

const views = new Map();
// The badge element on each view's switcher button, by view name.
const counters = new Map();

// How many are waiting on a view. Empty rather than zero, because a badge
// showing nothing is a badge that should not be there.
export function setViewCount(name, n) {
  const at = counters.get(name);
  if (at) at.textContent = n > 0 ? String(n) : '';
}
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
  const panel = el('div', { hidden: true, 'data-view': name });
  $('views').append(panel);
  views.set(name, { title, mount, panel, mounted: false });

  // The count rides on the button rather than beside it, so a view that holds
  // something waiting says so from wherever you are.
  const count = el('span', { class: 'count' });
  const button = el('button', {
    type: 'button',
    onclick: () => showView(name),
  }, title, count);
  button.dataset.view = name;
  counters.set(name, count);
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

// Pairing is the server-side statement that this approved device has acquired
// the master key. The key is saved before this request, so a temporary outage
// must not turn one failed marker into a permanent state: the next boot sees
// paired=false and calls this again. A successful write updates the in-memory
// identity as well, so recipient pickers in this session can trust it.
export async function ensurePaired(me = state.me, mark = () => api.markPaired()) {
  if (!me || me.paired) return true;
  try {
    await mark();
    me.paired = true;
    return true;
  } catch (err) {
    console.warn('this device could not be marked paired', err);
    return false;
  }
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
  await ensurePaired();
  return true;
}

// The chamber equalizing: the one moment of motion in this product that is not
// reporting a transfer. It runs once, between the passphrase being accepted and
// the app appearing, and it is where the strip's vocabulary is taught. A person
// sees a row of segments fill with the color that means "sealed" before they
// have sent anything, so the first real strip is already legible.
//
// It never blocks entry. Anything that goes wrong here resolves and the app
// opens, because an animation is not worth a locked-out device.
async function equalize() {
  const stage = $('equalize');
  if (!stage) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    const { renderStrip } = await import('./strip.js');
    stage.hidden = false;
    // Built at the width it will animate at, so the count is the count the
    // strip would really have.
    renderStrip(stage, 64, { seam: true, label: 'Sealing' });
    const segs = [...stage.querySelectorAll('.seg')];
    // Left to right, the direction a chunk list is read in.
    segs.forEach((seg, i) => { seg.style.animationDelay = `${i * 6}ms`; });
    stage.classList.add('running');
    if (!still) await new Promise((r) => setTimeout(r, segs.length * 6 + 320));
    stage.classList.add('done');
    if (!still) await new Promise((r) => setTimeout(r, 180));
  } catch (err) {
    console.warn('the equalize animation did not run', err);
  } finally {
    stage.hidden = true;
    stage.className = '';
    stage.replaceChildren();
  }
}

function enterApp() {
  $('unlock').hidden = true;
  $('app').hidden = false;
  // The switcher is meaningless before this point and the bar carries it on
  // every screen, including the ones that come before a passphrase exists.
  document.body.dataset.app = 'on';
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
    const waiting = inboundTo(await api.inbox(), state.me?.node).length;
    // The same count in both places it belongs: on the app's own icon, and on
    // the switcher button for the view that holds them.
    setViewCount('inbox', waiting);
    await setBadge(waiting);
  } catch (err) {
    console.warn('the badge was not updated', err);
  }
}

// Loaded here rather than imported at the top so the peer connection and the
// whole direct-transfer path stay out of the boot path, which is the one an
// unlock has to wait behind.
const listeners = new Set();
const deviceListeners = new Set();
const progressListeners = new Set();

// A view calls this to be told when something arrives. The event carries no
// detail, so the handler re-reads whatever it needs.
export function onInbox(fn) { listeners.add(fn); }

// Repaint state changed by this page itself. Server upload announcements still
// exclude their sender, so this stays in-process and cannot produce a push or a
// duplicate arrival notification on the device that sent the file.
export function notifyInbox() {
  for (const fn of listeners) fn();
}

// Approval, revocation and pairing completion change which devices can receive
// a transfer. They have their own event so an idle Send view can repaint the
// recipient picker without waiting for an unrelated file to arrive.
export function onDevices(fn) { deviceListeners.add(fn); }

// Another device has moved along with a saving transfer. Its own event, because
// a save ticks steadily for as long as the file is large, and routing that
// through the inbox nudge would have every device re-reading and re-decrypting
// the whole list on every tick to learn one number. The handler is given the
// transfer and the device and reads the figure itself.
export function onProgress(fn) { progressListeners.add(fn); }

// A signal is the opposite: it carries the whole payload, because a session
// description has nowhere else to be read from.

// EventSource readyState CLOSED, per the HTML standard. Written out rather than
// read off the global so this module also loads in a runtime that has no
// EventSource at all.
const STREAM_CLOSED = 2;

export const RETRY_BASE_MS = 1000;
export const RETRY_CAP_MS = 30000;

// How long to wait before reopening a stream the browser gave up on. The
// ceiling doubles with each consecutive failure up to a cap, and the wait lands
// somewhere in the upper half of that ceiling.
//
// The jitter is the reason for the half. Every device on one tailnet loses the
// same server in the same instant, so an unjittered backoff has all of them
// knock on the door together in the second it comes back, and a server that
// just restarted is the least able to answer them all at once.
export function retryDelay(attempt, random = Math.random) {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

// Test seam. Production never calls this.
let stream = {
  open: (path) => new EventSource(path),
  wait: (fn, ms) => setTimeout(fn, ms),
};
export function __setStreamImpl(impl) { stream = impl; }

// The open stream is what makes the inbox live without asking for a
// notification permission. Push stays for the case this cannot cover: an app
// that is not running at all.
//
// A stream that stays closed makes the device deaf. EventSource retries a
// transient drop by itself, but an HTTP error, or a server that went away and
// came back, leaves it CLOSED for good, and from then on every inbox nudge and
// every peer offer is lost until a person reloads the page. So a closed stream
// is reopened, and a reopened one begins by re-running the work an inbox nudge
// does, because the nudge that fired while it was down does not come again.
//
// ponytail: the reopen is silent. A device that has been deaf for half a minute
// looks exactly like one whose inbox is genuinely empty, and telling those apart
// wants a visible reconnecting state on the shell, which is a surface this file
// does not own.
export function listen() {
  let attempt = 0;
  let missed = false;

  const open = () => {
    const source = stream.open('/api/events');
    // A source that has handed off to a successor is finished. Without this, a
    // source reporting its failure more than once would start a second chain of
    // reopens racing the first, and each chain would carry its own backoff.
    let retired = false;

    source.addEventListener('open', () => {
      attempt = 0;
      if (!missed) return;
      missed = false;
      // Exactly what an inbox nudge does. A nudge carries no payload and its
      // listeners re-read whatever they need, so running them with no event in
      // hand is a catch-up rather than a lie about something having arrived.
      for (const fn of listeners) fn();
      for (const fn of deviceListeners) fn();
    });

    // The payload is the sending device's name. It is the only part of an
    // arrival that is not sealed, which is why the notice names the sender
    // rather than the file: the filename lives inside the metadata record and
    // opening it is the inbox's job, not this handler's.
    source.addEventListener('inbox', (event) => {
      // The sending device's name, and empty when the nudge is not about an
      // arrival. It used to read whatever the stream put in this field, which
      // was the literal "1" the server sent as a placeholder.
      // The sending device's name, and empty when this event is a catch-up or a
      // nudge rather than an arrival.
      const from = (event?.data || '').trim();
      const channel = arrivalChannel(globalThis, globalThis.document, subscribed, from);
      if (channel === 'toast') toast(`A file arrived from ${from}.`);
      else if (channel === 'local') showLocalNotice(from);
      // Only for an actual arrival. A catch-up on a fresh stream carries no
      // sender, and chiming through a list of things that were already there
      // would make every reload sound like a delivery. Nothing waits on it and
      // nothing reports it: a sound that will not play is not a failure.
      if (from) {
        import('./chime.js').then(({ chime }) => chime('arrive')).catch(() => {});
      }
      // Every one of the three re-reads what changed, whether or not it was
      // worth announcing.
      for (const fn of listeners) fn();
    });

    source.addEventListener('devices', () => {
      for (const fn of deviceListeners) fn();
    });

    // "<transfer id>:<device>", naming what moved and who moved it. How far it
    // has got is deliberately not here: a listener reads that from the endpoint
    // that scopes it, so the stream stays a pointer at what changed. A device
    // name is a DNS label and an id is hex, so the first colon is the split.
    source.addEventListener('progress', (event) => {
      const at = (event?.data || '').indexOf(':');
      if (at < 1) return;
      const id = event.data.slice(0, at);
      const node = event.data.slice(at + 1);
      if (!node) return;
      for (const fn of progressListeners) fn(id, node);
    });

    // The payload is base64 because an SSE data field ends at the first newline
    // and a session description is full of them. It is passed on untouched: the
    // encoding is the stream's problem and the contents are the session's.
    source.addEventListener('error', () => {
      if (retired) return;
      // Every failure means a gap, whoever closes it. EventSource repairs a
      // transient drop by itself and says nothing about it, so a catch-up armed
      // only on the failures this code handles would skip exactly the common
      // case: a server restart, after which the stream comes back on its own
      // and every nudge sent during the gap is simply gone. A queued transfer
      // would then sit undelivered with both devices online, because the drain
      // that failed while the server was down is never retried.
      missed = true;
      // CONNECTING means EventSource is already handling it and a second stream
      // would only duplicate the first. CLOSED is the state it will not leave
      // on its own, and the only one worth reopening from here.
      if (source.readyState !== STREAM_CLOSED) return;
      retired = true;
      stream.wait(open, retryDelay(attempt++));
    });
  };

  open();
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
  // Never asks. Boot has no user gesture to spend, and iOS refuses the prompt
  // without one and records that refusal as the answer, which would burn the
  // only chance this device gets. enablePush owns the asking.
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.config.vapidKey),
      });
    await api.subscribePush(sub);
    // Recorded because an arrival has to pick one announcer. Only a subscription
    // the server actually accepted means the worker will be woken, and assuming
    // it either doubles every notice or loses it.
    subscribed = true;
  } catch (err) {
    console.warn('push subscription failed', err);
  }
}

// Named rather than taken as a default argument value, because evaluating
// `localStorage` where there is none throws before any try block around the call
// can catch it, and this module is imported by tests that run outside a browser.
const themeStore = () => globalThis.localStorage || null;
const themeRoot = () => globalThis.document?.documentElement || { dataset: {} };

// The three answers a person can give about appearance, in the order the button
// cycles them. "system" is first because following the device is the right
// default and the one most people never move off.
export const THEMES = ['system', 'light', 'dark'];

const THEME_LABEL = {
  system: 'Theme: follow the system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

// What comes after this one. Exported because the order is the behaviour, and a
// test that restates it would pass against any order at all.
export function nextTheme(current) {
  const at = THEMES.indexOf(current);
  return THEMES[(at + 1) % THEMES.length];
}

// "system" is the absence of a choice rather than a third value to record, so it
// clears the attribute and lets prefers-color-scheme decide. Anything stored
// that is not a theme is treated as no choice, because a value from another
// version of this app must not leave the interface in a state with no name.
export function applyTheme(choice, root = themeRoot(), store = themeStore()) {
  const theme = THEMES.includes(choice) ? choice : 'system';
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === 'system') store?.removeItem('airlock-theme');
    else store?.setItem('airlock-theme', theme);
  } catch {
    // Storage refused, so the choice lasts for this page and no longer. Worth
    // less than refusing to change the theme at all.
  }
  return theme;
}

export function storedTheme(store = themeStore()) {
  try {
    const saved = store?.getItem('airlock-theme');
    return THEMES.includes(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

// Looking at what you typed. A passphrase this long is easy to mistype and
// nothing can tell you that you did: the server never sees it, and a wrong one
// is indistinguishable from a right one until it fails to open anything.
function wireReveal() {
  const field = $('passphrase');
  const peek = $('peek');
  if (!field || !peek) return;
  peek.addEventListener('click', () => {
    const showing = field.getAttribute('type') === 'text';
    field.setAttribute('type', showing ? 'password' : 'text');
    peek.setAttribute('aria-pressed', showing ? 'false' : 'true');
    peek.setAttribute('aria-label', showing ? 'Show the passphrase' : 'Hide the passphrase');
    // Back where it was, so looking does not cost the caret.
    field.focus();
  });
}

function wireTheme() {
  const button = globalThis.document?.getElementById?.('theme');
  if (!button) return;
  let choice = storedTheme();
  const paint = () => { button.setAttribute('aria-label', THEME_LABEL[choice]); };
  paint();
  button.addEventListener('click', () => {
    choice = applyTheme(nextTheme(choice));
    paint();
  });
}

// How long a notice stays up. Long enough to read a filename without looking for
// it, short enough that a run of arrivals does not build a wall.
export const TOAST_MS = 6000;

// Whether the server holds a push subscription this device registered. False
// until one is accepted, which is the honest default: an engine without push,
// and one whose subscribe failed, both need the page to speak for itself.
let subscribed = false;

// An arrival the operating system will not announce, shown inside the page.
// Returns the node so a caller can remove it early; a no-op outside a document,
// because a module under test has nowhere to put one.
export function toast(message, { from = '', action = null, after = TOAST_MS } = {}) {
  if (typeof document === 'undefined') return null;
  const host = document.getElementById('toasts');
  if (!host) return null;

  const node = el('div', { class: 'toast' },
    el('span', { class: 'said' },
      el('span', {}, message),
      from ? el('span', { class: 'from' }, from) : ''));
  // A notice that asks for something has to wait to be answered. Auto-dismissing
  // it would put a decision on screen and take it away again before a person
  // crossing the room could act on it, so an actionable notice stays until it is
  // used or waved off, and only a plain one times out.
  if (action) {
    const go = el('button', { class: 'ghost', type: 'button' }, action.label);
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        // The button is handed to the action so slow work can report into it.
        // A notice whose one control greys out and then says nothing for a
        // minute reads as broken.
        await action.run(go);
      } finally {
        node.remove();
      }
    });
    const close = el('button', {
      class: 'dismiss', type: 'button', 'aria-label': `Dismiss: ${message}`,
    }, '×');
    close.addEventListener('click', () => node.remove());
    node.append(go, close);
  } else {
    setTimeout(() => node.remove(), after);
  }
  host.append(node);
  return node;
}

// How an arrival should be announced on this device. Four answers, and the rule
// is that exactly one channel speaks, because two notices for one file is worse
// than a plain one.
//
//   none:   not an arrival, so nothing is announced.
//   toast:  the page says it. Correct whenever the page is being looked at, and
//           the only thing left when notifications were refused.
//   local:  the page raises a system notification itself. This is the case that
//           was silent: permission granted, window not in front, and no push to
//           carry it, which is every engine that has notifications without push.
//   push:   nothing to do here. The service worker will be woken and will speak,
//           and doing anything more would double it.
//
// The stream's inbox event carries three different pieces of news: a catch-up
// when it opens, a nudge that some transfer changed, and a file arriving. Only
// the last names the device it came from, and only the last is worth
// interrupting anyone about. Reading them as one is why "a file arrived" greeted
// every page load and every delete.
export function arrivalChannel(scope = globalThis, doc = globalThis.document,
  pushes = false, from = '') {
  if (!from) return 'none';
  if (doc?.visibilityState === 'visible') return 'toast';
  const granted = 'Notification' in scope && scope.Notification.permission === 'granted';
  if (!granted) return 'toast';
  return pushes ? 'push' : 'local';
}

// Two independent facts, deliberately not collapsed into one.
//
// The first is whether this device can show a system notification at all, which
// is the Notification API and the answer already given to it. The second is
// whether one can reach the device with the app closed, which additionally needs
// push. An engine can have the first without the second, and that combination is
// worth saying out loud rather than treating as "no notifications": arrivals
// still announce themselves while the app is running.
//
//   unavailable: this engine cannot notify, and no click will change that
//   unset:       never asked, and a click can still ask
//   blocked:     answered no, and only browser settings can undo it
//   on:          answered yes
export function notifyStatus(scope = globalThis) {
  if (!('Notification' in scope)) return 'unavailable';
  const answer = scope.Notification.permission;
  if (answer === 'granted') return 'on';
  if (answer === 'denied') return 'blocked';
  return 'unset';
}

// Whether an arrival can reach this device with the app closed. Both halves are
// required: the server must have a key to sign with, and the engine must have
// somewhere to receive.
export function pushCapable(scope = globalThis) {
  return Boolean(state.config?.vapidKey && 'PushManager' in scope);
}

// The ask, which must be called from inside a click. Permission is the whole
// decision; the push subscription that follows is an upgrade, and an engine that
// cannot take it still gets notifications while the app is running. Returns
// whether this device will now be notified, so the caller can say what happened
// rather than leaving a button that looks like it did nothing.
export async function enableNotifications() {
  if (!('Notification' in globalThis)) return false;
  try {
    if (await Notification.requestPermission() !== 'granted') return false;
  } catch (err) {
    console.warn('notification permission request failed', err);
    return false;
  }
  await subscribePush();
  return true;
}

// Announce an arrival through the operating system from the page itself. This is
// what covers an engine with notifications but no push: the app is running, so
// there is a live registration to show through, and without this such a device
// is silent the moment its window is not the one being looked at.
async function showLocalNotice(from) {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const body = from ? `From ${from}.` : 'Open Airlock to save it.';
    if (reg?.showNotification) {
      await reg.showNotification('A file arrived', { body, tag: 'airlock-arrival' });
      return;
    }
    new Notification('A file arrived', { body });
  } catch (err) {
    // The in-app notice already ran for every case this one is the upgrade to.
    console.warn('local notification failed', err);
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
  // Left outlined, not filled. Each signal color carries exactly one meaning:
  // sodium is in transit and seal is sealed or already held. Nothing is in
  // transit while this device waits for a person at another device to approve
  // it, so a sodium strip would have the app's most recognizable element state
  // something untrue about the system. Pending is the honest reading, because
  // nothing has happened yet.
  //
  // ponytail: so this screen is static. Making it feel alive is worth doing and
  // needs a segment state of its own in the strip's stylesheet, not an accent
  // borrowed from a meaning it already carries.
  renderStrip($('pairing-strip'), 48).setAll('pending');
  $('pairing').hidden = false;
  while (!state.me.allowed) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    state.me = await api.whoami().catch(() => state.me);
  }
  $('pairing').hidden = true;
}

// Web Crypto exists only on a secure origin, and every key this client holds
// comes from it. An insecure origin is therefore not a degraded mode, it is no
// mode at all: without this the passphrase field accepts a passphrase and then
// reports a TypeError from deep inside the key derivation, which reads as a
// broken app rather than as the wrong address.
//
// Tailscale mode always serves HTTPS and localhost is exempt from the rule, so
// the configuration that lands here is token mode reached by a LAN address.
export function secureEnough(scope = globalThis) {
  return Boolean(scope.isSecureContext && scope.crypto && scope.crypto.subtle);
}

async function boot() {
  // First, and before every gate below. The toggle lives in the header, which is
  // the one element on screen during the insecure-origin and install screens as
  // well, and a person who cannot get past those should still be able to read
  // them.
  wireTheme();
  // Also before the gates. A browser offers to install once, a few hundred
  // milliseconds after the page loads, and an offer nobody was listening for is
  // gone: attaching this after a passphrase is typed is attaching it minutes
  // too late.
  observeCapabilities();
  if (!secureEnough()) {
    const where = $('insecure-origin');
    if (where) where.textContent = location.origin;
    $('insecure').hidden = false;
    return;
  }
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
    await ensurePaired();
    enterApp();
    return;
  }

  $('unlock').hidden = false;
  wireReveal();
  if (state.config.check === null) {
    $('unlock-title').textContent = 'Choose a passphrase';
    $('unlock-note').textContent =
      'This server has no passphrase yet. Every device you set up must enter the same one.';
    $('passphrase').autocomplete = 'new-password';
  }
  // Deriving the key is deliberately slow, so the form has to say it is working
  // or a person reads the stillness as a dead button and presses again. The flag
  // is the real guard: a disabled button still allows implicit submission from
  // the passphrase field, and a second derivation would enter the app twice.
  let deriving = false;
  $('unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (deriving) return;
    deriving = true;
    const go = $('unlock-go');
    go.disabled = true;
    go.textContent = 'Unlocking';
    $('unlock-error').textContent = '';
    try {
      if (await unlock($('passphrase').value)) {
        await equalize();
        enterApp();
        // The one moment worth asking at. This device has just been set up, so
        // the answer means something, and the submit that got here is still the
        // gesture Firefox and Safari require before they will show the prompt
        // at all. Asking on load instead is refused outright on those two and
        // earns Chrome's quiet UI on the third, where the ask becomes an icon
        // in the address bar that nobody sees. Asked once: a decision already
        // made leaves the status set, and the Inbox carries the button for
        // anyone who wants to change it later.
        if (notifyStatus() === 'unset') await enableNotifications();
        return;
      }
      $('unlock-error').textContent =
        'That passphrase does not match the one this server was set up with.';
    } catch (err) {
      $('unlock-error').textContent = err.message;
    } finally {
      deriving = false;
      go.disabled = false;
      go.textContent = 'Unlock';
    }
  });
}

// A page is what boots. Importing this module to exercise one of its exports is
// not, and there is no document to report a failure into. Guarding the call
// keeps the entry point here, rather than in a second file that would exist only
// to make this one importable.
if (typeof document !== 'undefined') {
  boot().catch((err) => {
    document.body.prepend(el('p', { class: 'bad', style: 'padding:16px' }, err.message));
  });
}
