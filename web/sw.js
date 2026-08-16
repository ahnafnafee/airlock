import {
  DOMAIN, MODE_SEALED, openChunk, openRecord, unpackHashes, modeOf, loadMaster,
  b64decode, kvPut,
} from './crypto.js';

// Registered with {type:'module'} so these imports work.

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
  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(stashShare(event.request));
  }
});

// The share payload arrives as plaintext and the server can never see it, so it
// is stashed locally and the page encrypts and uploads it. This request must
// never reach the network: it is answered here whatever happens, including when
// the stash fails, because a POST that falls through to the server would hand it
// the very bytes the design exists to keep from it.
async function stashShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f instanceof File);
    const text = [form.get('title'), form.get('text'), form.get('url')]
      .filter(Boolean).join('\n');
    await kvPut('pending-share', { files, text });
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
  event.waitUntil((async () => {
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      if (client.url.startsWith(self.location.origin)) return client.focus();
    }
    return self.clients.openWindow('/');
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

// The push itself carries nothing. Everything shown here is decrypted on this
// device, which is the only place the filename exists in the clear. An unsealed
// meta record is refused for the same reason a download refuses one: its name
// would be whatever the writer chose, and a notification is a very good place
// to put a name nobody can vouch for.
async function announce() {
  let body = 'A file is waiting';
  try {
    const mk = await loadMaster();
    const [newest] = await (await getOk('/api/inbox')).json();
    if (mk && newest && newest.complete) {
      const meta = JSON.parse(new TextDecoder().decode(
        await openSealed(mk, DOMAIN.META, newest.id, b64decode(newest.meta))));
      body = meta.name;
    }
  } catch {
    // Locked device, or a fetch that failed because Tailscale is down. The
    // generic line still tells the owner something arrived.
  }
  return self.registration.showNotification('Airlock', { body, tag: 'inbox' });
}

async function download(id) {
  // This id comes from whatever navigated here, so it is the least trustworthy
  // one in the app and is checked before it reaches a URL.
  if (!TRANSFER_ID.test(id)) {
    return new Response('That download link is malformed.', { status: 400 });
  }
  const mk = await loadMaster();
  if (!mk) return new Response('Locked. Open Airlock and unlock this device first.', { status: 403 });

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

    const filename = encodeURIComponent(meta.name);
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
        'Content-Disposition':
          `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
      },
    });
  } catch (err) {
    return new Response(`Could not open this transfer. ${err.message}`, { status: 500 });
  }
}
