// Getting a file into Airlock, on every browser rather than on the one the
// manifest was written for.
//
// The file picker is the floor and it is the only rung every engine has. Drag
// and drop is desktop, paste is desktop and not even all of it, the share sheet
// is Chromium, and file handling is Chromium on the desktop alone. So the picker
// is the product's real inbound path and everything above it is an optimization
// over it, offered only where it has been seen to work.
import { kvGet, kvPut } from './crypto.js';

// Receipt-confirmed capabilities. A promise the browser does not keep is worse
// than an affordance we never offered, so nothing here is set from a manifest
// member or a user agent string: each flag is written the first time the thing
// actually happens.
//
// The rule exists because Firefox on Android parses share_target and then
// silently ignores it. There is no error and nothing to feature-detect, so an
// app that offers a share menu entry on the strength of its own manifest lies on
// that browser. The only honest evidence a share target works is a share
// arriving.
const FLAGS = 'capabilities';

// Test seam. Production never calls this. The service worker and the page both
// read and write this record, so it lives in IndexedDB rather than in a variable.
let store = { get: kvGet, put: kvPut };
export function __setStore(impl) { store = impl; }

export async function capabilities() {
  return (await store.get(FLAGS)) || {};
}

const watchers = new Set();

// A flag set mid-session is the point of receipt detection: the first drag over
// this window is what draws the drop zone, and that drag is already happening
// while the screen says nothing about dropping. Whatever drew the screen is told
// rather than left to poll.
export function onCapabilities(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

let pending = Promise.resolve();

// Test seam. Resolves once every mark requested so far has settled.
export function __settled() { return pending; }

export async function markCapability(name) {
  // Serialized, because each mark reads the whole record, adds one flag and
  // writes it back. Two receipts in the same moment, which is ordinary when a
  // drag ends in a drop, would otherwise both read the record as it was and the
  // second write would erase the first flag.
  //
  // The chain carries on past a rejection, so one refused write does not silence
  // every later receipt in the session.
  //
  // ponytail: this serializes one document, and the service worker writes the
  // same record when a share lands. A page open at that moment can still lose a
  // flag. The ceiling is that the read and the write are separate IndexedDB
  // transactions. Lift it by doing the read-modify-write inside a single
  // readwrite transaction, which is atomic across contexts.
  const run = pending.then(() => record(name));
  pending = run.catch(() => {});
  return run;
}

async function record(name) {
  const current = await capabilities();
  if (current[name]) return false;
  const next = { ...current, [name]: true };
  await store.put(FLAGS, next);
  for (const fn of watchers) fn(next);
  return true;
}

// A receipt is worth nothing if recording it can break the gesture that produced
// it, so every mark from an event handler goes through here.
const mark = (name) => markCapability(name).catch(
  (err) => console.warn(`the ${name} receipt was not recorded`, err));

export function observeCapabilities({ doc = document, win = window } = {}) {
  // Paste: attached unconditionally and left for a real delivery to prove.
  // Firefox on Android does not implement clipboardData.files at all, so it
  // never fires with one, which is exactly why it never gets the hint.
  doc.addEventListener('paste', (e) => {
    if (e.clipboardData?.files?.length) mark('paste');
  });

  // Drag: the zone is drawn on a real dragenter carrying files rather than from
  // a capability check, so it simply never appears on a phone.
  doc.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) mark('drop');
  });

  // The only honest install signal. It fires in Chromium and never in Firefox or
  // Safari, so an install card cannot appear where installing buys nothing.
  win.addEventListener('beforeinstallprompt', () => mark('installable'));

  // Present in Chromium on the desktop and absent from Chrome on Android, which
  // is the distinction that decides whether an install may promise Open with.
  // It says the API exists, not that a handler is registered: registration
  // follows installation, which is what the card is asking for.
  if ('launchQueue' in win) mark('fileHandlerApi');
}

// What an install is allowed to be sold as, decided in one place from receipts
// alone so the view cannot invent a stronger claim. Null means no card at all.
export function installCard(caps = {}) {
  if (!caps.installable) return null;
  const opens = caps.fileHandlerApi
    ? 'Install Airlock and every file gets an Open with Airlock entry.'
    : 'Install Airlock and it gets its own icon and window.';
  // Until a share has actually arrived, this says may. Chromium implements
  // share targets on Android and ChromeOS and not on Windows or macOS, and
  // nothing readable from in here tells the two apart.
  const shared = caps.shareTarget
    ? "Airlock is already in your device's share menu."
    : "It may also appear in your device's share menu.";
  return `${opens} ${shared}`;
}

// Everything a drop carries, folders included.
export async function filesFromDrop(dataTransfer) {
  const entries = [...(dataTransfer.items || [])]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  // No entry API, or items that yield nothing: the flat list is all there is.
  if (entries.length === 0) return [...dataTransfer.files];

  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      // The path goes in the name, because a File has nowhere else to carry one
      // and the staging list is a list of files. A file dropped at the top level
      // has no folder above it and is passed on untouched.
      out.push(prefix ? new File([file], prefix + file.name, { type: file.type }) : file);
      return;
    }
    const reader = entry.createReader();
    // readEntries yields at most 100 per call and signals the end with an empty
    // batch. Calling it once silently truncates any folder of 101 files or more,
    // and a truncated folder looks exactly like a folder that was that size.
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}
