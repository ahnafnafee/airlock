import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptRoute, createArrivalHandler, decodePushMessage, PUSH_PAYLOAD_VERSION,
} from './notification.js';

const TID = '0123456789abcdef0123456789abcdef';

test('Accept on an incomplete transfer opens its inbox row', () => {
  assert.equal(acceptRoute({ id: TID, complete: false }), '/#inbox');
});

test('Accept on a server-complete transfer keeps the one-tap download', () => {
  assert.equal(acceptRoute({ id: TID, complete: true }), `/dl/${TID}`);
});

const arrival = (extra = {}) => ({
  v: PUSH_PAYLOAD_VERSION,
  kind: 'arrival',
  id: TID,
  sender: 'desktop',
  createdAt: '2026-08-23T12:00:00Z',
  complete: true,
  ...extra,
});

test('push payloads admit only a versioned arrival or test', () => {
  assert.deepEqual(decodePushMessage(arrival({ meta: 'sealed' })), arrival({ meta: 'sealed' }));
  assert.deepEqual(decodePushMessage({ v: PUSH_PAYLOAD_VERSION, kind: 'test' }), {
    v: PUSH_PAYLOAD_VERSION, kind: 'test',
  });
  assert.equal(decodePushMessage(arrival({ complete: false })).complete, false);
  assert.equal(decodePushMessage({}), null);
  assert.equal(decodePushMessage(arrival({ id: '../inbox' })), null);
  assert.equal(decodePushMessage(arrival({ createdAt: 'not a date' })), null);
  assert.equal(decodePushMessage({ json: () => { throw new Error('bad payload'); } }), null);
});

test('an arrival is shown before a private-network refresh can finish', async () => {
  const shown = [];
  let finishRefresh;
  const handle = createArrivalHandler({
    notify: async (transfer) => shown.push(transfer),
    enrich: async () => new Promise((resolve) => { finishRefresh = resolve; }),
  });

  const pending = handle(arrival());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].id, TID);
  assert.equal(shown[0].meta, undefined);

  finishRefresh(null);
  await pending;
});

test('sealed metadata upgrades the notification without waiting for the server', async () => {
  const shown = [];
  const handle = createArrivalHandler({
    notify: async (transfer) => shown.push(transfer),
    enrich: async () => null,
  });

  await handle(arrival({ meta: 'sealed' }));
  assert.equal(shown.length, 2);
  assert.equal(shown[0].meta, undefined);
  assert.equal(shown[1].meta, 'sealed');
});

test('an old empty push still shows generically before inbox enrichment', async () => {
  const current = { id: TID, sender: 'desktop', meta: 'sealed' };
  const shown = [];
  const handle = createArrivalHandler({
    notify: async (transfer) => shown.push(transfer),
    enrich: async () => current,
  });

  assert.equal(await handle(null), null);
  assert.deepEqual(shown, [null, current]);
});
