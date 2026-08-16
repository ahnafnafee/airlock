import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFLIGHT_FACTOR, inboundTo, isIOS, isStandalone, needsInstallGate, roomShortfall, setBadge,
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

test('direct receive reserves both its sealed stage and assembled output', () => {
  assert.equal(PREFLIGHT_FACTOR, 2.15);
});

test('a transfer that fits under the headroom factor is short by nothing', async () => {
  // 600 free. Both copies plus headroom for 270 bytes need 580.5, which fits.
  assert.equal(await roomShortfall(270, PREFLIGHT_FACTOR, withQuota(1000, 400)), 0);
});

test('a transfer that fits the disk but not the headroom names what it is short', async () => {
  // 600 free and 283 wanted, so a check that forgot the second copy would allow
  // this. Two copies plus headroom need 608.45, rounded to 9 bytes short.
  assert.equal(await roomShortfall(283, PREFLIGHT_FACTOR, withQuota(1000, 400)), 9);
  // And the factor is what decides it, rather than the numbers happening to sit
  // either side of some other line.
  assert.equal(await roomShortfall(283, 1, withQuota(1000, 400)), 0);
});

test('a transfer far larger than the quota is short by the whole difference', async () => {
  // The shortfall is what the person has to free, not what was asked for, which
  // is the number the message is built out of.
  assert.equal(await roomShortfall(80e9, PREFLIGHT_FACTOR, withQuota(76e9, 0)), 96e9);
});

test('a browser with no estimate is not stopped by the preflight', async () => {
  assert.equal(await roomShortfall(1e12, PREFLIGHT_FACTOR, {}), 0);
  assert.equal(await roomShortfall(1e12, PREFLIGHT_FACTOR, { storage: {} }), 0);
});

test('a size the preflight cannot read allows the transfer through', async () => {
  // The size arrives in a peer's offer frame. A device that refused everything
  // it could not measure would stop receiving altogether, and the write path
  // still catches the quota failure.
  const nav = withQuota(1000, 400);
  for (const size of [undefined, null, 'lots', NaN, Infinity, -1]) {
    assert.equal(await roomShortfall(size, PREFLIGHT_FACTOR, nav), 0, `refused ${size}`);
  }
});

test('the badge counts what arrived and never what this device sent', async () => {
  // /api/inbox answers with this device's own outbound transfers alongside the
  // ones addressed to it, so a phone that sent three files and received nothing
  // would otherwise wear a badge of three.
  const list = [
    { id: 'a', sender: 'phone' },
    { id: 'b', sender: 'laptop' },
    { id: 'c', sender: 'phone' },
    { id: 'd', sender: 'desktop' },
  ];
  assert.deepEqual(inboundTo(list, 'phone').map((t) => t.id), ['b', 'd']);
  assert.equal(inboundTo([{ sender: 'phone' }], 'phone').length, 0);
  // Nothing to compare against leaves the list alone rather than hiding arrivals.
  assert.equal(inboundTo(list, '').length, 4);
  assert.equal(inboundTo(list, undefined).length, 4);
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
