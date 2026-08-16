import {
  DOMAIN, MODE_SEALED, openChunk, openRecord, unpackHashes, modeOf, loadMaster,
  b64decode, kvPut,
} from './crypto.js';
import { contentDisposition } from './naming.js';
import { markCapability } from './inbound.js';
import { inboundTo, setBadge } from './ios.js';

// Registered with {type:'module'} so these imports work.

// Whether a notification on this browser can carry more than words. WebKit
// ignores actions, image, icon, badge, renotify, requireInteraction and vibrate,
// and its tag does not coalesce, so an arrival there announces and the decision
// happens in the app after a tap. Feature-detected rather than sniffed: the
// question is what this browser honors and the answer is readable.
const RICH = typeof Notification !== 'undefined' && 'actions' in Notification.prototype;

const TRANSFER_ID = /^[0-9a-f]{32}$/;
const CHUNK_ID = /^[0-9a-f]{64}$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.method === 'GET' && url.pathname.startsWith('/dl/')) {
    event.respondWith(download(url.pathname.slice(4)));
    return;
  }
  if (event.request.method === 'GET' && url.pathname.startsWith('/thumb/')) {
    event.respondWith(thumbnail(url.pathname.slice(7)));
    return;
  }
  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(stashShare(event.request));
  }
});

// The share payload arrives as plaintext and the server can never see it, so it
// is stashed locally and the page encrypts and uploads it. This request must
// never reach the network: it is answered here whatever happens, including when
// the stash fails, because a POST that falls through to the server would hand it
// the very bytes the design exists to keep from it.
//
// A stash is not consent. A worker intercepts every in-scope navigation whoever
// started it, so an auto-submitting form on a hostile page can reach this with a
// payload of its choosing. The page therefore stages what it finds here and
// waits for a Send, which is the gate the server's own Sec-Fetch-Site check is
// for the routes that do reach the mux.
//
// ponytail: the stash itself is unauthenticated, so a hostile page can spend one
// database write and put a list of names it chose in front of the owner. The
// ceiling is that nothing about the request is checked. Lift it by refusing the
// stash when Sec-Fetch-Site is neither 'none' nor 'same-origin', once the value
// a genuine Android share carries has been read off real hardware. It is not
// checked on faith, because guessing wrong makes every real share vanish.
async function stashShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f instanceof File);
    const text = [form.get('title'), form.get('text'), form.get('url')]
      .filter(Boolean).join('\n');
    await kvPut('pending-share', { files, text });
    // The only honest evidence a share target works. Firefox on Android parses
    // share_target from the manifest and then ignores it, with no error and
    // nothing to feature-detect, so until a share actually arrives here the app
    // says installing may put Airlock in the share menu and never that it will.
    // A payload with nothing in it is not that evidence: this route is a
    // navigation any page can start, and an empty POST proves only that
    // something reached it.
    // Caught here rather than left to the handler below, so a receipt that
    // could not be written does not report a stash that worked as a failure.
    if (files.length || text) {
      await markCapability('shareTarget').catch(
        (err) => console.warn('the share receipt was not recorded', err));
    }
  } catch (err) {
    console.warn('share stash failed', err);
  }
  // 303 so the browser turns the POST into a GET. The page reads the stash.
  return Response.redirect('/?share=1', 303);
}

self.addEventListener('push', (event) => {
  event.waitUntil(announce());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;

  event.waitUntil((async () => {
    // Decline completes entirely in here. No window opens, and the server stops
    // holding a file nobody wanted.
    if (event.action === 'decline' && id) {
      try {
        await fetch(`/api/transfer/${id}/decline`, { method: 'POST' });
      } catch {
        // The tailnet is down. The transfer simply stays in the inbox, which is
        // the same place it would have been anyway.
      }
      return;
    }
    // Accept downloads without opening the app first: this worker answers /dl/,
    // so the navigation returns an attachment and the browser saves it with its
    // own progress UI.
    if (event.action === 'accept' && id) {
      return self.clients.openWindow(`/dl/${id}`);
    }
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      if (client.url.startsWith(self.location.origin)) {
        await client.focus();
        client.postMessage({ type: 'show', view: 'inbox' });
        return;
      }
    }
    return self.clients.openWindow('/#inbox');
  })());
});

// getOk stops a refused request from arriving as a parse failure two lines
// later, where the message would name JSON rather than the status that actually
// ended the download.
async function getOk(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  return res;
}

// The mode byte decides whether the rest of a record is authenticated at all,
// and it carries no tag of its own. A plaintext record opens with no key, so
// its contents are whatever the writer chose, and a plaintext chunk is returned
// unverified. Every record a download rests on is therefore required to be
// sealed before it is opened, which is the same gate verifyCheck applies for
// the same reason.
async function openSealed(mk, domain, id, record) {
  if (modeOf(record) !== MODE_SEALED) throw new Error('this transfer is not sealed');
  return openRecord(mk, domain, id, record);
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// The push that woke us says nothing, by design. Everything below is read from
// the inbox and decrypted on this device, which is the only place a filename
// exists in the clear. An unsealed meta record is refused for the same reason a
// download refuses one: its name would be whatever the writer chose, and a
// notification is a very good place to put a name nobody can vouch for.
async function announce() {
  const base = {
    icon: '/icon-192.png',
    badge: '/icon-badge.png',
    tag: 'airlock-generic',
  };

  let mk = null;
  let inbox = [];
  try {
    mk = await loadMaster();
    // Both, because /api/inbox answers with this device's own outbound transfers
    // as well as the ones addressed to it, and only the device's own name can
    // tell those apart. Announcing a file this phone sent, or badging it, would
    // be an arrival that never happened.
    const [inboxRes, whoRes] = await Promise.all([getOk('/api/inbox'), getOk('/api/whoami')]);
    inbox = inboundTo(await inboxRes.json(), (await whoRes.json()).node);
  } catch {
    return self.registration.showNotification('Airlock', { ...base, body: 'A file is waiting' });
  }

  // Every path below this line has the count, so the badge is set once here
  // rather than at each of them. It is the one rich affordance WebKit honors and
  // it needs no key: how many transfers have arrived is not a secret the server
  // keeps from itself.
  await setBadge(inbox.length);
  const [newest] = inbox;

  if (!mk) {
    // Reachable but locked. Say so, because "a file is waiting" would leave the
    // owner wondering why tapping it shows nothing.
    return self.registration.showNotification('Airlock', {
      ...base, body: 'A file is waiting. Unlock this device to open it.',
    });
  }
  // Named from the metadata record, not from the server's completeness. Complete
  // means the server holds every chunk, which is only ever true of a transfer
  // held on the server; a directly delivered one would otherwise never name
  // itself, and every notification for the product's default would read as the
  // same anonymous nudge. The record is sealed and this device has the key, so
  // the filename is opened here and never learned by the server.
  if (!newest || !newest.meta) {
    return self.registration.showNotification('Airlock', { ...base, body: 'A file is waiting' });
  }

  let meta;
  try {
    meta = JSON.parse(new TextDecoder().decode(
      await openSealed(mk, DOMAIN.META, newest.id, b64decode(newest.meta))));
  } catch {
    return self.registration.showNotification('Airlock', { ...base, body: 'A file is waiting' });
  }

  const options = {
    // Where no button and no image will render, the body is the whole
    // notification, so it carries the sender too rather than leaving it to a
    // title the platform may present as the app's name.
    body: RICH
      ? `${meta.name}\n${humanSize(meta.size)}`
      : `${meta.name}\n${humanSize(meta.size)}\nfrom ${newest.sender}`,
    icon: '/icon-192.png',
    badge: '/icon-badge.png',
    // One tag per transfer, so several arrivals stack. A shared tag would
    // silently hide everything but the last file.
    tag: `airlock-${newest.id}`,
    timestamp: new Date(newest.createdAt).getTime(),
    data: { id: newest.id, name: meta.name },
  };
  if (RICH) {
    // Two is the practical maximum Android renders. Dismissing is already a
    // swipe, so neither button is spent on it.
    options.actions = [
      { action: 'accept', title: 'Accept' },
      { action: 'decline', title: 'Decline' },
    ];
    options.requireInteraction = true;
    // The thumbnail is not lost where this is skipped: it moves to the arrival
    // screen, which is where the tap lands and where Accept and Decline live.
    if (newest.thumb) options.image = `/thumb/${newest.id}`;
  }

  // The title is the sending device, because on a personal tailnet the useful
  // question is which of my machines this came from.
  return self.registration.showNotification(newest.sender, options);
}

// Notification images are fetched by the browser process rather than by script,
// so a blob URL minted here is not reliably reachable from there. An ordinary
// same-origin URL this worker answers keeps the bytes decrypted on demand and
// the URL boring.
async function thumbnail(id) {
  // This id comes from whatever asked for the image, so it is checked before it
  // reaches a URL, exactly as a download's is.
  if (!TRANSFER_ID.test(id)) return new Response('malformed id', { status: 400 });
  const mk = await loadMaster();
  if (!mk) return new Response('locked', { status: 403 });
  try {
    const info = await (await getOk(`/api/transfer/${id}`)).json();
    if (!info.thumb) return new Response('no thumbnail', { status: 404 });
    // Sealed only, for the reason openSealed gives. A plaintext record carries
    // no authentication tag, so a forged one would be shown as this transfer's
    // own picture.
    const bytes = await openSealed(mk, DOMAIN.THUMB, id, b64decode(info.thumb));
    return new Response(bytes, {
      headers: {
        'Content-Type': 'image/jpeg',
        // A transfer's thumbnail never changes, and the id is derived from the
        // transfer.
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch {
    return new Response('cannot open', { status: 500 });
  }
}

// This route is one rung of several and never the last one. Where it works it is
// the best thing a notification's Accept can do: one tap, no assembly, and the
// browser's own download UI. Where it does not, nothing is lost, because the
// same transfer has a Save in the inbox that assembles on the device and runs
// the export cascade. So every failure here lands on that row rather than on a
// plain-text error page, which would be a dead end wearing an explanation.
const toInbox = () => Response.redirect('/#inbox', 303);

async function download(id) {
  // This id comes from whatever navigated here, so it is the least trustworthy
  // one in the app and is checked before it reaches a URL. A malformed one names
  // no transfer, so there is no row to send anyone to.
  if (!TRANSFER_ID.test(id)) {
    return new Response('That download link is malformed.', { status: 400 });
  }
  const mk = await loadMaster();
  // The app is where a passphrase is entered, and the inbox is where this
  // transfer is once it has been.
  if (!mk) return toInbox();

  try {
    const info = await (await getOk(`/api/transfer/${id}`)).json();

    const listRecord = new Uint8Array(
      await (await getOk(`/api/transfer/${id}/chunklist`)).arrayBuffer());
    const hashes = unpackHashes(await openSealed(mk, DOMAIN.LIST, id, listRecord));
    const meta = JSON.parse(new TextDecoder().decode(
      await openSealed(mk, DOMAIN.META, id, b64decode(info.meta))));

    if (hashes.length !== info.cids.length) {
      throw new Error('the chunk list and the server record disagree on length');
    }
    if (!info.cids.every((cid) => CHUNK_ID.test(cid))) {
      throw new Error('the server named a malformed chunk id');
    }

    let next = 0;
    // ponytail: one chunk is fetched at a time, so a download runs at the
    // sequential rate while the uploader keeps four in flight. The ceiling is
    // one round trip per chunk. Lift it by reading ahead into a bounded queue
    // and enqueueing from that.
    const body = new ReadableStream({
      async pull(controller) {
        if (next >= hashes.length) { controller.close(); return; }
        const i = next++;
        const res = await fetch(`/api/chunk/${info.cids[i]}`);
        if (!res.ok) { controller.error(new Error(`chunk ${i}: ${res.status}`)); return; }
        const sealed = new Uint8Array(await res.arrayBuffer());
        // Throws if the chunk was substituted, reordered, or corrupted: its key
        // derives from the hash the sealed list gives for this position. The
        // mode is the constant the guard above already established, never a
        // byte the server had a say in.
        controller.enqueue(await openChunk(mk, MODE_SEALED, hashes[i], info.cids[i], sealed));
      },
    });

    // ponytail: a Range request is answered with the whole file, so a paused
    // download restarts from zero and media cannot be seeked. The ceiling is
    // the chunk list itself, which carries hashes and no lengths, so nothing
    // here can map a byte offset onto a chunk. Lift it by sealing the plaintext
    // lengths alongside the hashes and starting the stream at the chunk that
    // contains the offset.
    return new Response(body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(meta.size),
        'Content-Disposition': contentDisposition(meta.name),
      },
    });
  } catch (err) {
    console.warn(`the download stream could not be built for ${id}`, err);
    return toInbox();
  }
}
