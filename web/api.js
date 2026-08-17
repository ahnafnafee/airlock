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

const postJSON = (path, body) => req(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Split from postJSON because not every POST answers with a body, and asking an
// empty 204 for its JSON fails as loudly as a real error while the write it
// reports on actually succeeded.
const sendJSON = async (path, body) => (await postJSON(path, body)).json();

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
  createTransfer: (cids, to, held = false) =>
    sendJSON('/api/transfer', { cids, to, held }),
  transfer: (id) => json(`/api/transfer/${id}`),
  putRecord: (id, kind, bytes) => sendBytes(`/api/transfer/${id}/${kind}`, bytes),
  getRecord: async (id, kind) =>
    new Uint8Array(await (await req(`/api/transfer/${id}/${kind}`)).arrayBuffer()),
  deleteTransfer: (id) => req(`/api/transfer/${id}`, { method: 'DELETE' }),

  // Declining is a server-side record, not a dismissal. It hides the transfer
  // from this device, and deletes it once every addressee has refused.
  decline: (id) => req(`/api/transfer/${id}/decline`, { method: 'POST' }),

  // The transfer id is required on upload. Chunks live in a store shared by
  // every transfer, so writing one leaves the transfer's own directory
  // untouched, and without this the server could not refresh its inactivity
  // clock and a long upload would be swept out from under itself.
  putChunk: (cid, transferId, bytes) =>
    sendBytes(`/api/chunk/${cid}?transfer=${transferId}`, bytes),
  getChunk: async (cid) =>
    new Uint8Array(await (await req(`/api/chunk/${cid}`)).arrayBuffer()),

  inbox: () => json('/api/inbox'),
  history: () => json('/api/history'),

  // The four calls direct delivery is made of. presence says who can be reached
  // right now, signal hands one opaque string to one of them, queue says what
  // this device still owes, and the two progress calls are how a sender learns
  // what actually landed. A signal to a device with no open stream answers 503,
  // which is not an error to hide: it is how the sender decides to stay queued.
  presence: () => json('/api/presence'),
  signal: (to, payload) => postJSON('/api/signal', { to, payload }),
  queue: () => json('/api/queue'),
  putProgress: (id, bitmap) => sendBytes(`/api/transfer/${id}/progress`, bitmap),
  getProgress: async (id, node) =>
    new Uint8Array(await (await req(
      `/api/transfer/${id}/progress?node=${encodeURIComponent(node)}`)).arrayBuffer()),

  // The node this endpoint belongs to comes from the connection, not from here,
  // so the body is only the browser's own PushSubscription.
  subscribePush: (sub) => postJSON('/api/push/subscribe', sub),
};
