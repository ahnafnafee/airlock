import {
  DOMAIN, MODE_SEALED, openChunk, openRecord, unpackHashes, modeOf, loadMaster,
  b64decode,
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
  }
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
