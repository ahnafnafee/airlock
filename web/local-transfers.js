const DB_NAME = 'airlock';
const STORE_NAME = 'kv';
const LEGACY_KEY = 'outbound-stages';
const MIGRATION_KEY = 'outbound-stages-v2';
const ENTRY_PREFIX = 'outbound-stage:';
const ID = /^[0-9a-f]{32}$/;

function checked(value, label) {
  if (!ID.test(value || '')) throw new Error(`malformed ${label}`);
  return value;
}

function validEntries(raw) {
  const entries = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return entries;
  for (const [transfer, stage] of Object.entries(raw)) {
    if (ID.test(transfer) && ID.test(stage)) entries[transfer] = stage;
  }
  return entries;
}

export function createOutboundRegistryStore(factory = () => globalThis.indexedDB) {
  let migration;

  function openDB() {
    return new Promise((resolve, reject) => {
      const api = factory();
      if (!api) {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }
      const req = api.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function transact(mode, schedule) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const objectStore = tx.objectStore(STORE_NAME);
      let result;
      let scheduledError;

      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onabort = () => {
        db.close();
        reject(scheduledError || tx.error || new Error('IndexedDB transaction aborted'));
      };
      tx.onerror = () => {};

      try {
        schedule(objectStore, (value) => { result = value; });
      } catch (err) {
        scheduledError = err;
        try { tx.abort(); } catch { reject(err); }
      }
    });
  }

  // The old registry was one object at LEGACY_KEY. The marker, imported
  // entries, and removal of that object share one transaction. That makes two
  // tabs migrating together idempotent and prevents a late migration from
  // restoring a mapping another tab has already removed.
  function migrate() {
    return transact('readwrite', (store) => {
      const marker = store.get(MIGRATION_KEY);
      marker.onsuccess = () => {
        if (marker.result === true) {
          store.delete(LEGACY_KEY);
          return;
        }

        const legacy = store.get(LEGACY_KEY);
        legacy.onsuccess = () => {
          const pairs = Object.entries(validEntries(legacy.result));
          let index = 0;
          const copyNext = () => {
            if (index === pairs.length) {
              store.put(true, MIGRATION_KEY);
              store.delete(LEGACY_KEY);
              return;
            }
            const [transfer, stage] = pairs[index++];
            const key = `${ENTRY_PREFIX}${transfer}`;
            const current = store.get(key);
            current.onsuccess = () => {
              // A per-transfer record is newer than the legacy aggregate and
              // must win if an interrupted migration left both behind.
              if (current.result === undefined) store.put(stage, key);
              copyNext();
            };
          };
          copyNext();
        };
      };
    });
  }

  function ready() {
    if (!migration) {
      migration = migrate().catch((err) => {
        // A temporary refusal must not wedge every later registry operation.
        migration = null;
        throw err;
      });
    }
    return migration;
  }

  return {
    async set(transfer, stage) {
      await ready();
      return transact('readwrite', (store) => {
        store.put(stage, `${ENTRY_PREFIX}${transfer}`);
      });
    },

    async remove(transfer) {
      await ready();
      return transact('readwrite', (store) => {
        store.delete(`${ENTRY_PREFIX}${transfer}`);
      });
    },

    async all() {
      await ready();
      return transact('readonly', (store, setResult) => {
        const entries = {};
        setResult(entries);
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          if (typeof item.key === 'string' && item.key.startsWith(ENTRY_PREFIX)) {
            const transfer = item.key.slice(ENTRY_PREFIX.length);
            if (ID.test(transfer) && ID.test(item.value || '')) entries[transfer] = item.value;
          }
          item.continue();
        };
      });
    },

    async removeIf(transfer, stage) {
      await ready();
      return transact('readwrite', (store, setResult) => {
        setResult(false);
        const key = `${ENTRY_PREFIX}${transfer}`;
        const current = store.get(key);
        current.onsuccess = () => {
          if (current.result !== stage) return;
          store.delete(key);
          setResult(true);
        };
      });
    },
  };
}

const defaultStore = createOutboundRegistryStore();

function registry(store) {
  const selected = store || defaultStore;
  for (const method of ['set', 'remove', 'all', 'removeIf']) {
    if (typeof selected[method] !== 'function') {
      throw new Error(`outbound registry store requires ${method}`);
    }
  }
  return selected;
}

// A sender stage has a random name because its chunks exist before the server
// assigns a transfer id. Keep the relationship outside sealed metadata too, so
// it remains recoverable after the server deletes that metadata on delivery,
// decline, expiry or deletion.
export function rememberOutboundStage(transferId, stageId, store = defaultStore) {
  checked(transferId, 'transfer id');
  checked(stageId, 'stage id');
  return registry(store).set(transferId, stageId);
}

export function forgetOutboundStage(transferId, store = defaultStore) {
  checked(transferId, 'transfer id');
  return registry(store).remove(transferId);
}

// Capture exactly the mappings a subsequent server queue read is allowed to
// judge. Per-transfer records make this a consistent IndexedDB snapshot without
// a shared object that another tab can replace after reading an older copy.
export async function snapshotOutboundStages(store = defaultStore) {
  return Object.freeze({ ...await registry(store).all() });
}

// The server queue is authoritative about what this device still owes. A stage
// captured before the queue read but absent from its successful response is
// terminal and can be reclaimed. A mapping registered or replaced after that
// capture is never eligible. Failed clears remain registered so the next drain
// retries.
export async function reconcileOutboundStages(candidates, activeTransferIds, {
  store = defaultStore,
  openStage,
} = {}) {
  if (typeof openStage !== 'function') throw new Error('openStage is required');
  const records = registry(store);
  const active = new Set(activeTransferIds);
  const current = await records.all();
  const cleared = [];
  const failed = [];

  for (const [transfer, stageId] of Object.entries(candidates)) {
    if (active.has(transfer) || current[transfer] !== stageId) continue;
    try {
      await (await openStage(stageId)).clear();
      // Removal is a compare-and-delete transaction. If another tab repaired
      // this transfer's mapping while the local clear was in flight, its newer
      // record remains registered.
      if (await records.removeIf(transfer, stageId)) cleared.push(transfer);
    } catch {
      failed.push(transfer);
    }
  }
  return { cleared, failed };
}
