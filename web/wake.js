// A phone that stops being looked at parks its radio, and a transfer running at
// that moment does not merely pause: TCP backs off and stays backed off long
// after the screen comes back. Measured on a link good for about 180 Mbps, the
// same file moved at 3 to 11 Mbps whenever the device was left alone and at 124
// to 182 Mbps when it was not, and two transfers to that phone at the same
// instant showed one crawling while the other flew, which is a stall rather
// than a shortage of bandwidth.
//
// A screen wake lock is what a page is given to prevent that, and it holds only
// for as long as the app is open. Nothing a web application can do keeps a
// closed app running.

let impl = typeof navigator !== 'undefined' && navigator.wakeLock
  ? () => navigator.wakeLock.request('screen')
  : null;

// Test seam. Production never calls this.
export function __setWakeLockImpl(fn) { impl = fn; }

let active = 0;
let lock = null;

export function activeCount() { return active; }

async function acquire() {
  if (!impl) return;
  // Holding a reference is not the same as holding a lock. The browser releases
  // the sentinel on its own when the page is hidden, and what is left behind is
  // an object that says so, so this asks again rather than trusting the
  // reference.
  if (lock && !lock.released) return;
  lock = null;
  try {
    lock = await impl();
  } catch {
    // Some browsers refuse a lock on a background tab. The transfer still
    // works; it is just more likely to be interrupted, so this is not worth
    // failing over.
    lock = null;
  }
}

async function release() {
  const held = lock;
  lock = null;
  if (held) {
    try {
      await held.release();
    } catch {
      // Already released by the browser, which happens when the page is hidden.
    }
  }
}

// Every acquire and release runs in turn on one chain, and each step reads the
// count as it starts rather than as it was queued. A request that is still in
// flight cannot be overtaken by the release meant to end it, which is the way a
// lock outlives the last transfer and is never given back.
let chain = Promise.resolve();
function settle() {
  chain = chain.then(() => (active > 0 ? acquire() : release()));
  return chain;
}

// transfersActive(+1) when a transfer starts, (-1) when it ends. One lock is
// held for any number of concurrent transfers: taking one each would leak all
// but the last.
export function transfersActive(delta) {
  active = Math.max(0, active + delta);
  return settle();
}

if (typeof document !== 'undefined') {
  // A wake lock is dropped when the page is hidden and is not restored on its
  // own. Without this the lock silently stops working after the first time the
  // user switches away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') settle();
  });
}
