import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFLIGHT_FACTOR, hasRoomFor, isIOS, isStandalone, needsInstallGate, setBadge,
} from './ios.js';

// The window a browser tab presents: the media query answers, and it answers no.
const tab = { matchMedia: () => ({ matches: false }), navigator: {} };
// An installed window. The query is compared rather than ignored, so a changed
// query string fails here instead of gating every installed app forever.
const installed = {
  matchMedia: (query) => ({ matches: query === '(display-mode: standalone)' }),
  navigator: {},
};
// WebKit's own signal, and the only one a Home Screen web app has always had.
const homeScreen = { navigator: { standalone: true } };

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)' };
const IPAD_DESKTOP = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15',
  maxTouchPoints: 5,
};
const MAC = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15',
  maxTouchPoints: 0,
};
const WINDOWS = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/1x' };

test('an iPhone in a Safari tab is gated', () => {
  assert.equal(isIOS(IPHONE), true);
  assert.equal(isStandalone(tab), false);
  assert.equal(needsInstallGate(IPHONE, tab), true);
});

test('the same iPhone in the installed app is not gated', () => {
  // The gate exists because the two have separate storage. Once the app is the
  // one that opened, there is nothing left to install.
  assert.equal(needsInstallGate(IPHONE, installed), false);
  assert.equal(needsInstallGate(IPHONE, homeScreen), false);
});

test('an iPad reporting itself as a Macintosh is still iOS', () => {
  // iPadOS asks for desktop sites by default, so the user agent alone says Mac.
  // Touch points are what separate it from a real one.
  assert.equal(isIOS(IPAD_DESKTOP), true);
  assert.equal(needsInstallGate(IPAD_DESKTOP, tab), true);
});

test('a desktop is never gated', () => {
  for (const nav of [MAC, WINDOWS]) {
    assert.equal(isIOS(nav), false);
    assert.equal(needsInstallGate(nav, tab), false);
    assert.equal(needsInstallGate(nav, installed), false);
  }
});

test('a navigator with no user agent at all is not mistaken for iOS', () => {
  assert.equal(isIOS({}), false);
  assert.equal(needsInstallGate({}, tab), false);
});

const withQuota = (quota, usage) => ({ storage: { estimate: async () => ({ quota, usage }) } });

test('a transfer that fits under the headroom factor is allowed', async () => {
  // 600 free. 520 with 15 percent asked over it is 598, which fits.
  assert.equal(await hasRoomFor(520, PREFLIGHT_FACTOR, withQuota(1000, 400)), true);
});

test('a transfer that fits the disk but not the headroom is refused', async () => {
  // 600 free and 530 wanted, so a check that forgot the factor would allow this.
  // 530 with 15 percent over it is 609.5, which does not fit.
  assert.equal(await hasRoomFor(530, PREFLIGHT_FACTOR, withQuota(1000, 400)), false);
  // And the factor is what decides it, rather than the numbers happening to sit
  // either side of some other line.
  assert.equal(await hasRoomFor(530, 1, withQuota(1000, 400)), true);
});

test('a transfer far larger than the quota is refused', async () => {
  assert.equal(await hasRoomFor(80e9, PREFLIGHT_FACTOR, withQuota(76e9, 0)), false);
});

test('a browser with no estimate is not stopped by the preflight', async () => {
  assert.equal(await hasRoomFor(1e12, PREFLIGHT_FACTOR, {}), true);
  assert.equal(await hasRoomFor(1e12, PREFLIGHT_FACTOR, { storage: {} }), true);
});

test('a size the preflight cannot read allows the transfer through', async () => {
  // The size arrives in a peer's offer frame. A device that refused everything
  // it could not measure would stop receiving altogether, and the write path
  // still catches the quota failure.
  const nav = withQuota(1000, 400);
  for (const size of [undefined, null, 'lots', NaN, Infinity, -1]) {
    assert.equal(await hasRoomFor(size, PREFLIGHT_FACTOR, nav), true, `refused ${size}`);
  }
});

test('the badge carries the count, and zero clears it', async () => {
  const calls = [];
  const nav = {
    setAppBadge: async (n) => { calls.push(['set', n]); },
    clearAppBadge: async () => { calls.push(['clear']); },
  };
  await setBadge(3, nav);
  await setBadge(0, nav);
  assert.deepEqual(calls, [['set', 3], ['clear']]);
});

test('a browser with no badging api is left alone, and a refusal is not fatal', async () => {
  await setBadge(3, {});
  await setBadge(0, {});
  await setBadge(3, { setAppBadge: async () => { throw new Error('refused'); } });
});
