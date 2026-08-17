import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICES, chime, forgetContext } from './chime.js';

// A stand-in for the Web Audio graph. It records what was scheduled rather than
// making a sound, which is the only part of this a test can hold an opinion
// about: that the right number of notes were started, at the right times, and
// that the envelope never reaches zero through an exponential ramp, which is
// the one way to write this that throws at runtime rather than sounding wrong.
function fakeAudio({ state = 'running', resumeTo = 'running' } = {}) {
  const started = [];
  const ramps = [];
  class Ctx {
    constructor() {
      this.state = state;
      this.currentTime = 100;
      this.destination = { name: 'out' };
    }

    async resume() { this.state = resumeTo; }

    createOscillator() {
      const osc = {
        type: '', frequency: { value: 0 }, connect() {},
        start: (at) => started.push({ hz: osc.frequency.value, at }),
        stop() {},
      };
      return osc;
    }

    createGain() {
      return {
        connect() {},
        gain: {
          setValueAtTime(v) { ramps.push(v); },
          exponentialRampToValueAtTime(v) { ramps.push(v); },
        },
      };
    }
  }
  return { Ctx, started, ramps };
}

test('an arrival and a save do not sound the same', () => {
  // Confused across a room is the failure here: the two happen minutes apart
  // and one means "something is waiting" while the other means "it is done".
  const arrive = VOICES.arrive.map((n) => n.hz);
  const saved = VOICES.saved.map((n) => n.hz);
  assert.notDeepEqual(arrive, saved);
  // One rises and the other falls, which is the difference a person actually
  // hears without having learned the tones.
  assert.ok(arrive.at(-1) > arrive[0], 'an arrival rises');
  assert.ok(saved.at(-1) < saved[0], 'a completion falls');
});

test('every note is scheduled ahead of the clock, in order', async () => {
  forgetContext();
  const { Ctx, started } = fakeAudio();
  assert.equal(await chime('arrive', { make: Ctx }), true);

  assert.equal(started.length, VOICES.arrive.length);
  // Scheduling at or before currentTime is how a note gets dropped or clipped.
  for (const note of started) assert.ok(note.at > 100, `${note.hz} scheduled too late`);
  for (let i = 1; i < started.length; i++) {
    assert.ok(started[i].at > started[i - 1].at, 'notes must not collapse together');
  }
});

// exponentialRampToValueAtTime throws on a zero target, and a gain that starts
// at zero produces no sound at all. Both are silent-in-production mistakes.
test('the envelope never touches zero', async () => {
  forgetContext();
  const { Ctx, ramps } = fakeAudio();
  await chime('saved', { make: Ctx });
  assert.ok(ramps.length > 0);
  for (const v of ramps) assert.ok(v > 0, `an envelope value of ${v} is silent or throws`);
});

test('a suspended context is resumed before anything is scheduled', async () => {
  forgetContext();
  const { Ctx, started } = fakeAudio({ state: 'suspended', resumeTo: 'running' });
  assert.equal(await chime('arrive', { make: Ctx }), true);
  assert.ok(started.length > 0, 'a resumed context should still play');
});

// A page that has never been interacted with cannot play audio, and scheduling
// into a context that stays suspended silently produces nothing. Saying so lets
// the caller stay indifferent rather than believing a sound happened.
test('a context that will not start reports that it did not play', async () => {
  forgetContext();
  const { Ctx, started } = fakeAudio({ state: 'suspended', resumeTo: 'suspended' });
  assert.equal(await chime('arrive', { make: Ctx }), false);
  assert.equal(started.length, 0, 'nothing may be scheduled into a suspended context');
});

test('an unknown voice is refused rather than played as silence', async () => {
  forgetContext();
  const { Ctx, started } = fakeAudio();
  assert.equal(await chime('nonsense', { make: Ctx }), false);
  assert.equal(started.length, 0);
});

// Contexts are a limited resource, and a browser stops handing them out. On an
// inbox left open for hours that is the difference between a sound every time
// and a sound for the first few.
test('one context serves every sound', async () => {
  forgetContext();
  let built = 0;
  const { Ctx } = fakeAudio();
  class Counted extends Ctx {
    constructor() { super(); built++; }
  }
  await chime('arrive', { make: Counted });
  await chime('saved', { make: Counted });
  await chime('arrive', { make: Counted });
  assert.equal(built, 1);
});

test('audio the browser does not offer at all is not an error', async () => {
  forgetContext();
  const missing = class { constructor() { throw new Error('no audio here'); } };
  assert.equal(await chime('arrive', { make: missing }), false);
});
