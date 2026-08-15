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
};
