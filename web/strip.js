import { el } from './app.js';

// The chunk strip. A transfer renders as a row of segments, one per chunk,
// bucketed when there are thousands. It replaces the progress bar rather than
// joining it, because it shows the thing a progress bar hides: how much of this
// file the server already had.
const MAX_SEGMENTS = 240;

export function renderStrip(container, total) {
  const count = Math.min(total, MAX_SEGMENTS) || 1;
  const span = total || 1;
  const segments = [];

  const row = el('div', { class: 'strip', role: 'img', 'aria-label': 'Transfer progress' });
  for (let i = 0; i < count; i++) {
    const seg = el('span', { class: 'seg pending' });
    segments.push(seg);
    row.append(seg);
  }
  container.append(row);

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
