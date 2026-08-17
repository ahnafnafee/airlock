import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptRoute, createArrivalQueue } from './notification.js';

const TID = '0123456789abcdef0123456789abcdef';

test('Accept on an incomplete transfer opens its inbox row', () => {
  assert.equal(acceptRoute({ id: TID, complete: false }), '/#inbox');
});

test('Accept on a server-complete transfer keeps the one-tap download', () => {
  assert.equal(acceptRoute({ id: TID, complete: true }), `/dl/${TID}`);
});

test('two quick arrivals produce distinct notifications', async () => {
  const older = { id: '11111111111111111111111111111111' };
  const newer = { id: '22222222222222222222222222222222' };
  const shown = [];
  let releaseFirst;

  const announce = createArrivalQueue({
    list: async () => [newer, older],
    visible: async () => [],
    notify: async (transfer) => {
      shown.push(transfer.id);
      if (shown.length === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
    },
  });

  const first = announce();
  const second = announce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(shown, [newer.id], 'the second push must wait for the first notification');

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(shown, [newer.id, older.id]);
});
