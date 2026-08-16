// Airlock runs on iOS only as a Home Screen web app. A Safari tab cannot request
// push at all, its wake lock does not work, and its staged transfers can be
// evicted after seven days without interaction.
//
// The reason this is a hard gate rather than a nudge: a Home Screen web app has
// its own storage partition. It shares no IndexedDB, OPFS or service worker
// registration with the same origin in a tab, so a passphrase set up in Safari
// simply does not exist in the installed app. Letting someone pair in a tab
// would silently waste that setup.
//
// Two of the exports below are not iOS branches and must never become them. The
// storage preflight and the Home Screen badge run on every platform that has
// them. iOS is only what made them worth writing.
export function isIOS(nav = navigator) {
  const ua = nav.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua)
    || (ua.includes('Macintosh') && nav.maxTouchPoints > 1);
}

// Two signals rather than one, because neither covers the whole floor on its
// own. The media query is the standard answer and is what a Chromium or Gecko
// installed window reports; navigator.standalone is WebKit's own, and it is the
// one that has always worked in a Home Screen web app.
export function isStandalone(win = window) {
  return Boolean(win.matchMedia?.('(display-mode: standalone)').matches
    || win.navigator?.standalone === true);
}

// iOS has no beforeinstallprompt, so the app cannot offer to install itself and
// has to explain the manual steps instead.
export function needsInstallGate(nav = navigator, win = window) {
  return isIOS(nav) && !isStandalone(win);
}

// Headroom asked for over the transfer's own size, because a staged transfer is
// not the only thing landing on that disk while it lands.
//
// It is one authored value rather than a literal at each call, because V6 in the
// iOS verification list can move it: if a save buffers the whole file in memory
// instead of streaming it to disk, iOS gains a size ceiling the other platforms
// do not have and this rises to 2.15.
export const PREFLIGHT_FACTOR = 1.15;

// The quota is not the constraint on iOS, free disk is. Since iOS 17 the
// per-origin ceiling is up to 60% of total disk, so estimate() on a 128 GB phone
// reports something like 76 GB while 12 GB is actually free. That number is a
// policy ceiling, not a reservation, and a write still fails when the disk is
// full, with no prompt and no way for the user to grant more.
//
// This is a courtesy rather than a control. It exists so a transfer that cannot
// fit is refused before a chunk is staged instead of failing at 90 percent, and
// a size it cannot evaluate is allowed through rather than refused, because the
// size travels in a peer's offer frame and a device that refused every transfer
// whose size it could not read would simply stop receiving. The write path
// catches the quota failure either way.
//
// It answers with the number of bytes short rather than a yes or a no, because
// the only useful thing to tell the person holding the full device is how much
// to free. Zero means it fits, or that nothing here can tell.
export async function roomShortfall(bytes, factor = PREFLIGHT_FACTOR, nav = navigator) {
  if (!nav.storage?.estimate) return 0;
  if (!Number.isFinite(bytes) || bytes < 0) return 0;
  const { quota = 0, usage = 0 } = await nav.storage.estimate();
  const needed = bytes * factor;
  const free = quota - usage;
  return free > needed ? 0 : Math.ceil(needed - free);
}

// What the badge counts and what an arrival notification speaks for. The inbox
// endpoint answers with this device's own outbound transfers alongside the ones
// addressed to it, so without this a phone that sent three files and received
// nothing would wear a badge of three until they were deleted or swept.
//
// Pending means still in the inbox. Nothing anywhere records that a file has
// been saved, so a transfer leaves this list on a decline, a delete, or the
// server's own sweep and on nothing else.
export function inboundTo(transfers, node) {
  // Without a name for this device there is nothing to compare against, and
  // guessing would hide real arrivals. The count is wrong in the same direction
  // it was before rather than wrong in the direction that loses files.
  if (!node) return transfers;
  return transfers.filter((t) => t.sender !== node);
}

// The Home Screen badge is the one rich notification affordance WebKit honors,
// so on iOS it carries what the buttons and the image cannot. It is not an iOS
// branch: every platform with the Badging API gets the same count, and a
// platform without it gets nothing and says nothing.
export async function setBadge(count, nav = navigator) {
  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch (err) {
    // A badge is a second rendering of a number the inbox already carries, so
    // failing to draw it is never worth failing anything else for.
    console.warn('the badge was not set', err);
  }
}
