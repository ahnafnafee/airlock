import { el } from './app.js';

// The chunk strip. A transfer renders as a row of segments, one per chunk,
// bucketed when there are thousands. It replaces the progress bar rather than
// joining it, because it shows the thing a progress bar hides: how much of this
// file the server already had.
const MAX_SEGMENTS = 240;

// The floor a segment must clear to be a segment rather than a smear. Below it
// the 1px gap is wider than the mark it separates, and the strip reads as
// texture instead of as state, which is the one thing this element exists to
// carry. A phone column is the narrowest place it is ever drawn and the place it
// is looked at most, so the floor is what decides the count, not the count that
// decides the width.
const MIN_SEGMENT_PX = 3;
const GAP_PX = 1;

// A strip of n segments spends n - 1 gaps between them, so the largest count
// that still clears the floor is floor((width + gap) / (min + gap)).
//
// A width of zero is a strip that has not been laid out yet rather than a strip
// with no room: the pairing screen builds its strip while its section is still
// hidden. Falling back to the cap there keeps that case exactly as wide as the
// chunk count asks for, and any strip that can be measured is measured.
export function segmentCount(width, total) {
  const room = width > 0
    ? Math.floor((width + GAP_PX) / (MIN_SEGMENT_PX + GAP_PX))
    : MAX_SEGMENTS;
  return Math.max(1, Math.min(total || 1, MAX_SEGMENTS, room));
}

export function renderStrip(container, total) {
  const span = total || 1;
  const segments = [];

  const row = el('div', { class: 'strip', role: 'img', 'aria-label': 'Transfer progress' });
  // Appended empty and measured before it is filled, because an empty flex row
  // is exactly as wide as the room the full one will have.
  //
  // ponytail: the count is fixed at the width the strip is built at. Rotating a
  // phone mid-transfer keeps the count it started with, because re-bucketing
  // live state onto a new grid costs more than the segments it would regain.
  container.append(row);
  const count = segmentCount(row.clientWidth, total);
  for (let i = 0; i < count; i++) {
    const seg = el('span', { class: 'seg pending' });
    segments.push(seg);
    row.append(seg);
  }

  // Chunks are mapped onto segments by scaling, not by dividing through a
  // rounded-up bucket size. A fixed bucket of ceil(total / count) overshoots
  // whenever the division is inexact, leaving the tail segments unreachable, so
  // a finished transfer would render as a strip that never fills.
  const segIndex = (i) => Math.min(count - 1, Math.floor((i * count) / span));
  const apply = (seg, state) => { seg.className = `seg ${state}`; };

  return {
    set(index, state) { apply(segments[segIndex(index)], state); },
    // Walks segments rather than chunks. Progress fires once per chunk and
    // repaints the whole run each time, so walking chunks here would make the
    // painting quadratic in the number of chunks. The result is identical: a
    // chunk range covers exactly the segments its endpoints land in.
    setRange(from, to, state) {
      if (to <= from) return;
      const last = segIndex(to - 1);
      for (let i = segIndex(from); i <= last; i++) apply(segments[i], state);
    },
    setAll(state) { segments.forEach((s) => apply(s, state)); },
  };
}
