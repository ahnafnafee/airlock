import test from 'node:test';
import assert from 'node:assert/strict';
import { __setWakeLockImpl, transfersActive, activeCount } from './wake.js';

// The module holds one refcount for the whole page, and the tests in this file
// share it. Whatever the previous test left running is drained before the next
// fake goes in, so a leftover count cannot make a later assertion pass for a
// reason that has nothing to do with what it names.
async function reset(fn) {
  await transfersActive(-activeCount());
  __setWakeLockImpl(fn);
}

// A sentinel the browser has released is still an object. The fake says so the
// same way the real one does, through a `released` flag, because code that only
// checks whether it holds a reference would never ask for a new lock.
async function fakeLock() {
  const state = { held: 0, released: 0, last: null };
  await reset(async () => {
    state.held++;
    state.last = {
      released: false,
      release: async () => {
        state.last.released = true;
        state.released++;
      },
    };
    return state.last;
  });
  return state;
}

test('a lock is taken for the first transfer and released after the last', async () => {
  const state = await fakeLock();

  await transfersActive(1);
  assert.equal(state.held, 1);
  await transfersActive(1);
  // Two concurrent transfers, still one lock. Taking a second would leak it.
  assert.equal(state.held, 1);
  assert.equal(activeCount(), 2);

  await transfersActive(-1);
  assert.equal(state.released, 0, 'still one transfer running');
  await transfersActive(-1);
  assert.equal(state.released, 1);
  assert.equal(activeCount(), 0);
});

test('the count never goes negative', async () => {
  await fakeLock();
  await transfersActive(-1);
  await transfersActive(-1);
  assert.equal(activeCount(), 0);
  // A stray release must not make the next transfer fail to take a lock.
  await transfersActive(1);
  assert.equal(activeCount(), 1);
});

test('a browser without the API degrades quietly', async () => {
  await reset(null);
  await transfersActive(1);
  await transfersActive(-1);
  assert.equal(activeCount(), 0);
});

test('a rejected request does not wedge the count', async () => {
  // Some browsers refuse a lock on a background tab. That must not stop the
  // transfer or leave the refcount stuck.
  await reset(async () => { throw new Error('refused'); });
  await transfersActive(1);
  assert.equal(activeCount(), 1);
  await transfersActive(-1);
  assert.equal(activeCount(), 0);
});

test('the lock is taken again once the page is visible', async () => {
  // The browser drops a wake lock when the page is hidden and never restores
  // it. Nothing tells the page, so the sentinel this module holds is simply a
  // released one, and asking for a new lock is the only way back. The listener
  // that does it exists only where there is a document, so this loads a second
  // instance of the module with one in place.
  const handlers = [];
  const doc = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => {
      if (name === 'visibilitychange') handlers.push(fn);
    },
  };
  globalThis.document = doc;
  try {
    const wake = await import('./wake.js?with-document');
    let held = 0;
    let sentinel = null;
    wake.__setWakeLockImpl(async () => {
      held++;
      sentinel = { released: false, release: async () => { sentinel.released = true; } };
      return sentinel;
    });

    await wake.transfersActive(1);
    assert.equal(held, 1);
    assert.equal(handlers.length, 1, 'the visibility listener was never registered');

    // Away: the browser releases the lock on its own.
    sentinel.released = true;
    doc.visibilityState = 'hidden';
    for (const fn of handlers) fn();
    assert.equal(held, 1, 'a hidden page has no lock to take');

    // Back: the transfer is still running, so a new lock has to be taken.
    doc.visibilityState = 'visible';
    for (const fn of handlers) fn();
    // A no-op delta queues behind the re-acquisition on the module's own chain,
    // which is what makes waiting for it enough.
    await wake.transfersActive(0);
    assert.equal(held, 2);

    await wake.transfersActive(-1);
    assert.equal(wake.activeCount(), 0);
    assert.equal(sentinel.released, true);
  } finally {
    delete globalThis.document;
  }
});
