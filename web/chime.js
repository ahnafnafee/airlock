// The two moments worth hearing: a file arriving, and one finishing its save.
//
// Synthesised rather than played from a file. A sound file would be another
// asset to embed, another request, and another thing to get wrong on a codec
// this or that browser will not decode; two oscillators are a few hundred bytes
// of code that every engine renders identically.
//
// Nothing here is allowed to matter. Audio is blocked outright until a page has
// been interacted with, a device can be muted, and a browser may have no audio
// at all, so every call is best effort and every failure is swallowed. A missed
// sound is not a missed transfer.

// Rising, because something has been added. The second note is a fifth above
// the first, which is the interval most obviously "up" without sounding like an
// alarm.
const ARRIVE = [
  { at: 0, hz: 587.33, for: 0.09 },
  { at: 0.085, hz: 880, for: 0.14 },
];

// Falling and single-bodied, because this is a thing completing rather than a
// thing appearing. Deliberately unlike the arrival: the two happen minutes
// apart and must not be confused across a room.
const SAVED = [
  { at: 0, hz: 783.99, for: 0.1 },
  { at: 0.09, hz: 587.33, for: 0.18 },
];

export const VOICES = { arrive: ARRIVE, saved: SAVED };

let shared = null;

// One context for the life of the page. They are a limited resource and a
// browser will refuse to keep minting them, which on a long-running inbox is
// the difference between a sound every time and a sound for the first few.
function context(make) {
  if (shared) return shared;
  const Ctor = make
    || globalThis.AudioContext
    || globalThis.webkitAudioContext;
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    shared = null;
  }
  return shared;
}

// Test seam, and what a locked device needs after its passphrase is accepted.
export function forgetContext() { shared = null; }

// A tone with an envelope rather than a bare gain. An oscillator switched on and
// off at full volume produces a click at each end, which is louder and more
// noticeable than the note itself.
function tone(ctx, note, at, volume) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = note.hz;
  const start = at + note.at;
  const end = start + note.for;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(end + 0.02);
}

// Play one of the two voices. Returns whether anything was scheduled, which is
// what a test can assert on and what nothing in the app should ever branch on.
export async function chime(name, { make = null, volume = 0.06 } = {}) {
  const notes = VOICES[name];
  if (!notes) return false;
  const ctx = context(make);
  if (!ctx) return false;
  try {
    // A context created before the page was interacted with starts suspended,
    // and scheduling into a suspended context silently produces nothing at all.
    if (ctx.state === 'suspended') await ctx.resume();
    if (ctx.state !== 'running') return false;
    const at = ctx.currentTime + 0.01;
    for (const note of notes) tone(ctx, note, at, volume);
    return true;
  } catch {
    return false;
  }
}
