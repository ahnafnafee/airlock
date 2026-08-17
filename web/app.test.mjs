import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensurePaired, arrivalChannel, listen, notifyStatus, onDevices, onInbox, pushCapable, retryDelay,
  secureEnough,
  state, __setStreamImpl, RETRY_BASE_MS, RETRY_CAP_MS,
} from './app.js';

// EventSource readyState, per the HTML standard. Restated here rather than
// imported, because these are what the fake has to report for app.js to read it
// the way it reads a real stream.
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

test('an unlocked device retries a failed paired marker on the next boot', async () => {
  const me = { node: 'phone', paired: false };
  let attempts = 0;
  const mark = async () => {
    attempts++;
    if (attempts === 1) throw new Error('network down');
  };

  assert.equal(await ensurePaired(me, mark), false);
  assert.equal(me.paired, false);
  assert.equal(await ensurePaired(me, mark), true);
  assert.equal(me.paired, true);
  assert.equal(attempts, 2);

  assert.equal(await ensurePaired(me, mark), true);
  assert.equal(attempts, 2, 'a confirmed device does not write the marker again');
});

// A stream the test drives by hand. The two states that matter are the two the
// browser distinguishes: an error while CONNECTING is one EventSource is already
// retrying, and an error while CLOSED is one it has given up on.
function fakeSource(path) {
  const handlers = new Map();
  return {
    path,
    readyState: CONNECTING,
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    emit(type, event) {
      for (const fn of handlers.get(type) || []) fn(event);
    },
    connect() {
      this.readyState = OPEN;
      this.emit('open', {});
    },
    // The server answered with an HTTP error, or went away. EventSource does not
    // come back from this on its own.
    giveUp() {
      this.readyState = CLOSED;
      this.emit('error', {});
    },
    // A transient drop. EventSource is already dialing again.
    blip() {
      this.readyState = CONNECTING;
      this.emit('error', {});
    },
  };
}

// Timers are collected rather than run, so a test decides when a reopen happens
// and can read the delay that was asked for.
function fakeStream() {
  const opened = [];
  const waits = [];
  __setStreamImpl({
    open: (path) => {
      const source = fakeSource(path);
      opened.push(source);
      return source;
    },
    wait: (fn, ms) => { waits.push({ fn, ms }); },
  });
  return {
    opened,
    waits,
    last: () => opened[opened.length - 1],
    runNextWait() {
      const pending = waits[waits.length - 1];
      assert.ok(pending, 'expected a reopen to be scheduled');
      pending.fn();
    },
  };
}

test('a stream the server gave up on is reopened', () => {
  const s = fakeStream();
  listen();
  assert.equal(s.opened.length, 1);
  s.last().connect();

  s.last().giveUp();
  assert.equal(s.opened.length, 1, 'the reopen waits out the backoff first');
  assert.equal(s.waits.length, 1);

  s.runNextWait();
  assert.equal(s.opened.length, 2, 'a closed stream is replaced');
  assert.equal(s.opened[1].path, '/api/events');
});

test('a transient drop is left to EventSource', () => {
  const s = fakeStream();
  listen();
  s.last().connect();

  s.last().blip();
  assert.equal(s.waits.length, 0, 'nothing is scheduled while EventSource is still dialing');
  assert.equal(s.opened.length, 1, 'a second stream would duplicate the one still connecting');
});

test('one closed stream produces one reopen however often it reports itself', () => {
  const s = fakeStream();
  listen();
  s.last().connect();

  const dead = s.last();
  dead.giveUp();
  dead.giveUp();
  dead.giveUp();
  assert.equal(s.waits.length, 1, 'a retired stream must not start a second chain of reopens');
});

test('the backoff grows with each failure and is capped', () => {
  const s = fakeStream();
  listen();

  for (let i = 0; i < 10; i++) {
    s.last().giveUp();
    s.runNextWait();
  }

  const delays = s.waits.map((w) => w.ms);
  assert.equal(delays.length, 10);

  // The window each delay has to land in, restated here rather than imported.
  // Restating it is the assertion: a change to how the ceiling grows fails this
  // test instead of passing it by definition.
  const ceiling = (attempt) => Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  delays.forEach((ms, attempt) => {
    const c = ceiling(attempt);
    assert.ok(ms >= c / 2 && ms <= c, `failure ${attempt} waited ${ms}, outside ${c / 2}..${c}`);
  });

  // The windows above are what proves growth: they are the reason a listen that
  // forgot to count its failures fails here, because its fourth wait would land
  // in the first attempt's window instead of the fourth's. Two adjacent delays
  // cannot be compared directly, since jitter lets a later one land low.
  const growing = delays.filter((_, i) => ceiling(i) < RETRY_CAP_MS).length;
  assert.ok(growing >= 4, 'the ceiling should double several times before it caps');

  // Cap: ten consecutive failures is well past it, so the tail sits on the
  // ceiling rather than still doubling toward an hour-long wait.
  for (const ms of delays.slice(growing)) {
    assert.ok(ms >= RETRY_CAP_MS / 2 && ms <= RETRY_CAP_MS, `capped delay ${ms} left its ceiling`);
  }
});

test('a stream that opens resets the backoff', () => {
  const s = fakeStream();
  listen();

  for (let i = 0; i < 8; i++) {
    s.last().giveUp();
    s.runNextWait();
  }
  const beforeReset = s.waits.length;
  s.last().connect();

  s.last().giveUp();
  const after = s.waits[s.waits.length - 1].ms;
  assert.equal(s.waits.length, beforeReset + 1);
  assert.ok(after <= RETRY_BASE_MS, `a fresh failure waited ${after}, which is not a first attempt`);
});

test('a reopened stream re-runs the work an inbox nudge triggers', () => {
  const s = fakeStream();
  let caughtUp = 0;
  onInbox(() => { caughtUp++; });
  listen();

  s.last().connect();
  assert.equal(caughtUp, 0, 'the first open missed nothing: the app already read the inbox');

  s.last().giveUp();
  s.runNextWait();
  assert.equal(caughtUp, 0, 'the catch-up belongs to the reopened stream, not to scheduling it');

  s.last().connect();
  assert.equal(caughtUp, 1, 'a nudge that fired while the stream was down is gone unless this runs');

  // And the reopened stream is a live stream, not just a catch-up.
  s.last().emit('inbox', {});
  assert.equal(caughtUp, 2);
});

test('the catch-up runs once per reopen, not once per event on the reopened stream', () => {
  const s = fakeStream();
  let caughtUp = 0;
  onInbox(() => { caughtUp++; });
  listen();

  s.last().connect();
  s.last().giveUp();
  s.runNextWait();
  s.last().connect();
  s.last().connect();
  assert.equal(caughtUp, 1);
});

test('the delay doubles to a ceiling and stays there', () => {
  // Both ends of the jitter window, so the assertion is on the ceiling itself
  // rather than on wherever one draw happened to land.
  const low = (attempt) => retryDelay(attempt, () => 0);
  const high = (attempt) => retryDelay(attempt, () => 1);

  assert.equal(high(0), RETRY_BASE_MS);
  assert.equal(high(1), RETRY_BASE_MS * 2);
  assert.equal(high(2), RETRY_BASE_MS * 4);
  assert.equal(low(0), RETRY_BASE_MS / 2);
  assert.equal(low(1), RETRY_BASE_MS);

  for (const attempt of [5, 6, 20, 200]) {
    assert.equal(high(attempt), RETRY_CAP_MS, 'the ceiling has to stop doubling');
    assert.equal(low(attempt), RETRY_CAP_MS / 2);
  }
  // 2 ** 200 is a finite float but an unbounded doubling still overflows the
  // useful range long before that, so the cap is what keeps the delay a number
  // setTimeout can honor.
  assert.ok(Number.isFinite(high(2000)));
});

// EventSource repairs a transient drop by itself and reports nothing about it,
// which is what a server restart looks like from the page. A catch-up armed
// only on the failures this code reopens from would skip that case entirely,
// and every nudge sent during the gap is gone: a queued transfer then sits
// undelivered with both devices online, because the drain that failed while the
// server was unreachable is never retried.
test('a stream that heals itself still catches up on what it missed', () => {
  const s = fakeStream();
  let caughtUp = 0;
  onInbox(() => { caughtUp++; });
  listen();

  const source = s.last();
  source.connect();
  caughtUp = 0;

  // The browser reports the failure and then repairs it on its own, so the
  // stream never reaches the state this code reopens from.
  source.blip();
  assert.equal(s.waits.length, 0, 'a self-healing stream needs no reopen scheduled');

  source.connect();
  assert.equal(caughtUp, 1, 'the gap was never closed, so nothing re-read the inbox');
});

test('a device roster event has its own live subscribers', () => {
  const s = fakeStream();
  let changed = 0;
  onDevices(() => { changed++; });
  listen();
  s.last().connect();

  s.last().emit('devices', {});
  assert.equal(changed, 1);
  s.last().emit('inbox', {});
  assert.equal(changed, 1, 'an inbox nudge is not a roster mutation');
});

// Web Crypto exists only on a secure origin, and every key this client holds
// comes from it. Without this check the passphrase field accepts a passphrase
// and then reports a TypeError from inside the key derivation, which reads as a
// broken app rather than as the wrong address. The configuration that reaches
// it is token mode opened by a LAN address, which is the one Airlock's own
// instructions can lead someone to.
test('an origin without web crypto is refused rather than half-run', () => {
  const subtle = {};
  assert.equal(secureEnough({ isSecureContext: true, crypto: { subtle } }), true);

  // A LAN address over plain HTTP: the flag is false and subtle is absent.
  assert.equal(secureEnough({ isSecureContext: false, crypto: {} }), false);
  // Some engines leave the flag true but still withhold subtle.
  assert.equal(secureEnough({ isSecureContext: true, crypto: {} }), false);
  assert.equal(secureEnough({ isSecureContext: true }), false);
  assert.equal(secureEnough({}), false);
});

// iOS refuses Notification.requestPermission unless a user gesture is asking,
// and it records that refusal as the answer. Boot has no gesture to spend, so a
// prompt fired there burns the only chance the device gets and background
// receive, the whole reason to leave the app closed, never works on the platform
// that needs it most. The ask therefore belongs to a click, and this decides
// whether a view offers one.
test('what this device can do about notifications is two facts, not one', () => {
  const config = state.config;
  const scope = (permission, push = true) => (push
    ? { Notification: { permission }, PushManager: function () {} }
    : { Notification: { permission } });
  try {
    state.config = { vapidKey: 'k' };
    assert.equal(notifyStatus(scope('default')), 'unset');
    assert.equal(notifyStatus(scope('granted')), 'on');

    // A page cannot prompt again after this, so a view that treated it like 'on'
    // would leave the device quiet forever with nothing on screen to act on.
    assert.equal(notifyStatus(scope('denied')), 'blocked');

    // No Notification at all. This is the case that used to render nothing,
    // which is indistinguishable from the app being broken.
    assert.equal(notifyStatus({}), 'unavailable');

    // Permission is independent of push. An engine can show notifications while
    // it runs and still have nowhere to receive a push, and reporting that as
    // "no notifications" would be wrong in the direction that loses arrivals.
    assert.equal(notifyStatus(scope('granted', false)), 'on');
    assert.equal(pushCapable(scope('granted', false)), false);
    assert.equal(pushCapable(scope('granted', true)), true);

    // Push also needs a server that can sign one.
    state.config = { vapidKey: '' };
    assert.equal(pushCapable(scope('granted', true)), false);
    state.config = null;
    assert.equal(pushCapable(scope('granted', true)), false);
  } finally {
    state.config = config;
  }
});

// Exactly one channel speaks per arrival. Two notices for one file is worse than
// a plain one, and none at all is how an arrival goes unnoticed for hours.
test('an arrival is announced once, by whichever channel can reach', () => {
  const visible = { visibilityState: 'visible' };
  const hidden = { visibilityState: 'hidden' };
  const perm = (permission) => ({ Notification: { permission } });

  // Being looked at. The page says it, whatever else is available, because a
  // system banner over the window you are already reading is noise.
  assert.equal(arrivalChannel(perm('granted'), visible, true), 'toast');
  assert.equal(arrivalChannel(perm('denied'), visible, false), 'toast');

  // Subscribed and out of sight: the worker will be woken and will speak. Doing
  // anything here would double it.
  assert.equal(arrivalChannel(perm('granted'), hidden, true), 'push');

  // The case that was silent. Permission granted, window not in front, and no
  // push to carry it, which is every engine that has notifications without push.
  assert.equal(arrivalChannel(perm('granted'), hidden, false), 'local');

  // Refused, so nothing outside the page can speak. The notice waits in the page
  // rather than being dropped.
  assert.equal(arrivalChannel(perm('denied'), hidden, true), 'toast');
  assert.equal(arrivalChannel({}, hidden, true), 'toast');
});

