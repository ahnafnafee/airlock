import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOutboundRegistryStore,
  forgetOutboundStage, rememberOutboundStage, reconcileOutboundStages,
  snapshotOutboundStages,
} from './local-transfers.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const SA = '1'.repeat(32);
const SB = '2'.repeat(32);

function memoryStore() {
  const entries = new Map();
  return {
    set: async (transfer, stage) => { entries.set(transfer, stage); },
    remove: async (transfer) => { entries.delete(transfer); },
    all: async () => Object.fromEntries(entries),
    removeIf: async (transfer, stage) => {
      if (entries.get(transfer) !== stage) return false;
      entries.delete(transfer);
      return true;
    },
    value: () => Object.fromEntries(entries),
  };
}

test('outbound stage ownership survives until it is explicitly forgotten', async () => {
  const store = memoryStore();
  await rememberOutboundStage(A, SA, store);
  await rememberOutboundStage(B, SB, store);
  assert.deepEqual(store.value(), { [A]: SA, [B]: SB });

  await forgetOutboundStage(A, store);
  assert.deepEqual(store.value(), { [B]: SB });
});

test('queue reconciliation clears only terminal outbound stages', async () => {
  const store = memoryStore();
  await rememberOutboundStage(A, SA, store);
  await rememberOutboundStage(B, SB, store);
  const cleared = [];
  const candidates = await snapshotOutboundStages(store);

  const result = await reconcileOutboundStages(candidates, new Set([A]), {
    store,
    openStage: async (id) => ({ clear: async () => { cleared.push(id); } }),
  });

  assert.deepEqual(cleared, [SB]);
  assert.deepEqual(result, { cleared: [B], failed: [] });
  assert.deepEqual(store.value(), { [A]: SA });
});

test('a local cleanup failure stays registered for the next drain', async () => {
  const store = memoryStore();
  await rememberOutboundStage(A, SA, store);
  const candidates = await snapshotOutboundStages(store);

  const result = await reconcileOutboundStages(candidates, new Set(), {
    store,
    openStage: async () => ({ clear: async () => { throw new Error('disk busy'); } }),
  });

  assert.deepEqual(result, { cleared: [], failed: [A] });
  assert.deepEqual(store.value(), { [A]: SA });
});

test('reconciliation never clears a mapping remembered after its snapshot', async () => {
  const store = memoryStore();
  await rememberOutboundStage(A, SA, store);
  const candidates = await snapshotOutboundStages(store);

  // This is the interval occupied by the server queue GET. A newly queued
  // transfer can be registered here, but it was not part of the older server
  // snapshot and therefore cannot be judged terminal by that snapshot.
  await rememberOutboundStage(B, SB, store);
  const cleared = [];
  const result = await reconcileOutboundStages(candidates, new Set(), {
    store,
    openStage: async (id) => ({ clear: async () => { cleared.push(id); } }),
  });

  assert.deepEqual(cleared, [SA]);
  assert.deepEqual(result, { cleared: [A], failed: [] });
  assert.deepEqual(store.value(), { [B]: SB });
});

test('two tabs remembering different outbound stages cannot overwrite each other', async () => {
  // Query strings give this test two independent module realms, including two
  // independent in-memory write queues, exactly as two tabs have. The shared
  // storage boundary holds both reads until each realm has observed the same
  // old value, making the lost-update interval deterministic.
  const [left, right] = await Promise.all([
    import('./local-transfers.js?outbound-realm=left'),
    import('./local-transfers.js?outbound-realm=right'),
  ]);
  const store = concurrentRealmStore();

  const first = left.rememberOutboundStage(A, SA, store);
  const second = right.rememberOutboundStage(B, SB, store);
  await store.bothEntered();
  store.release();
  await Promise.all([first, second]);

  assert.deepEqual(await left.snapshotOutboundStages(store), { [A]: SA, [B]: SB });
});

test('a legacy registry is imported once and cannot replace a newer mapping', async () => {
  const database = fakeIndexedDB({
    'outbound-stages': { [A]: SA, malformed: 'not-an-id' },
  });
  const firstRealm = createOutboundRegistryStore(() => database);

  assert.deepEqual(await snapshotOutboundStages(firstRealm), { [A]: SA });
  await rememberOutboundStage(A, SB, firstRealm);

  // Model stale legacy data surviving an interrupted cleanup, then open a new
  // realm with no in-memory migration state. The transaction marker must keep
  // that older aggregate from winning over the per-transfer record.
  database.seed('outbound-stages', { [A]: SA });
  const secondRealm = createOutboundRegistryStore(() => database);
  assert.deepEqual(await snapshotOutboundStages(secondRealm), { [A]: SB });

  await forgetOutboundStage(A, secondRealm);
  assert.deepEqual(await snapshotOutboundStages(secondRealm), {});
});

test('reconciliation keeps a mapping replaced while its old stage is clearing', async () => {
  const store = memoryStore();
  await rememberOutboundStage(A, SA, store);
  const candidates = await snapshotOutboundStages(store);
  let enteredClear;
  let releaseClear;
  const clearing = new Promise((resolve) => { enteredClear = resolve; });
  const released = new Promise((resolve) => { releaseClear = resolve; });

  const reconciling = reconcileOutboundStages(candidates, new Set(), {
    store,
    openStage: async () => ({
      clear: async () => {
        enteredClear();
        await released;
      },
    }),
  });
  await clearing;
  await rememberOutboundStage(A, SB, store);
  releaseClear();

  assert.deepEqual(await reconciling, { cleared: [], failed: [] });
  assert.deepEqual(await snapshotOutboundStages(store), { [A]: SB });
});

function concurrentRealmStore() {
  let legacy;
  const entries = new Map();
  let entered = 0;
  let announceBoth;
  let releaseBoth;
  const both = new Promise((resolve) => { announceBoth = resolve; });
  const released = new Promise((resolve) => { releaseBoth = resolve; });
  const rendezvous = async () => {
    entered++;
    if (entered === 2) announceBoth();
    await released;
  };

  return {
    // The existing whole-object boundary. Kept here so this regression fails
    // against the implementation it is replacing.
    get: async () => {
      const seen = structuredClone(legacy);
      await rendezvous();
      return seen;
    },
    put: async (_key, value) => { legacy = structuredClone(value); },

    // The per-transfer boundary used by the fixed implementation. Distinct
    // keys can complete in either order without replacing each other.
    set: async (transfer, stage) => {
      await rendezvous();
      entries.set(transfer, stage);
    },
    remove: async (transfer) => { entries.delete(transfer); },
    all: async () => Object.fromEntries(entries),
    removeIf: async (transfer, stage) => {
      if (entries.get(transfer) !== stage) return false;
      entries.delete(transfer);
      return true;
    },

    bothEntered: () => both,
    release: () => releaseBoth(),
  };
}

function fakeIndexedDB(seed = {}) {
  const values = new Map(Object.entries(structuredClone(seed)));

  const transaction = () => {
    let pending = 0;
    let completed = false;
    let completionQueued = false;

    const finishSoon = () => {
      if (pending !== 0 || completionQueued || completed) return;
      completionQueued = true;
      queueMicrotask(() => {
        completionQueued = false;
        if (pending !== 0 || completed) return;
        completed = true;
        tx.oncomplete?.();
      });
    };

    const request = (read) => {
      pending++;
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        req.result = read();
        req.onsuccess?.();
        pending--;
        finishSoon();
      });
      return req;
    };

    const objectStore = {
      get: (key) => request(() => structuredClone(values.get(key))),
      put: (value, key) => request(() => {
        values.set(key, structuredClone(value));
        return key;
      }),
      delete: (key) => request(() => values.delete(key)),
      openCursor: () => {
        const items = [...values.entries()].map(([key, value]) => [key, structuredClone(value)]);
        let index = 0;
        pending++;
        const req = { result: undefined, error: null, onsuccess: null, onerror: null };
        const advance = () => queueMicrotask(() => {
          if (index >= items.length) {
            req.result = null;
            req.onsuccess?.();
            pending--;
            finishSoon();
            return;
          }
          const [key, value] = items[index++];
          req.result = { key, value, continue: advance };
          req.onsuccess?.();
        });
        advance();
        return req;
      },
    };

    const tx = {
      error: null,
      oncomplete: null,
      onabort: null,
      onerror: null,
      objectStore: () => objectStore,
      abort: () => {
        completed = true;
        tx.onabort?.();
      },
    };
    return tx;
  };

  return {
    open: () => {
      const req = { result: null, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction,
          close() {},
        };
        req.onsuccess?.();
      });
      return req;
    },
    seed: (key, value) => values.set(key, structuredClone(value)),
  };
}
