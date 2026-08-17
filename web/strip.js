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

// The same two numbers the stylesheet lays the strip out with, written onto the
// element rather than restated in CSS. The count is computed here from the floor
// and the gap, so a stylesheet holding its own copy is a copy that drifts: it
// drifted to 4px and 2px, which made every full strip half again as wide as the
// width this file had fitted it to, and a large transfer ran off the panel.
function applyMetrics(row) {
  // Guarded because the element here is a stand-in under test, which has the
  // structure the strip reads and not the style object a browser attaches.
  if (!row.style?.setProperty) return;
  row.style.setProperty('--seg-min', `${MIN_SEGMENT_PX}px`);
  row.style.setProperty('--seg-gap', `${GAP_PX}px`);
}

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

// seam draws the same element as a divider rather than as a subject. A row's
// rule is that transfer's own chunk composition, so reading down a list shows
// which arrivals were mostly bytes this device already held. It is the same
// scale, the same colors and the same meanings, at the height of a hairline.
export function renderStrip(container, total, { seam = false, label = 'Transfer progress', sizes = null } = {}) {
  const span = total || 1;
  const segments = [];

  const row = el('div', {
    class: seam ? 'strip seam' : 'strip',
    role: 'img',
    'aria-label': label,
  });
  // Appended empty and measured before it is filled, because an empty flex row
  // is exactly as wide as the room the full one will have.
  //
  // ponytail: the count is fixed at the width the strip is built at. Rotating a
  // phone mid-transfer keeps the count it started with, because re-bucketing
  // live state onto a new grid costs more than the segments it would regain.
  applyMetrics(row);
  container.append(row);
  // The row's own width when it has one, and the space it was put into when it
  // has not. A strip built inside a hidden panel measures zero, and falling
  // straight to the cap there draws the widest possible strip in what may be the
  // narrowest possible place.
  const count = segmentCount(row.clientWidth || container.clientWidth || 0, total);
  // A segment's width is the share of the file its chunks occupy. Content
  // defined chunking cuts on content, so chunks are not equal, and drawing them
  // equal misplaces every boundary: an edit two thirds of the way through a file
  // would appear at the middle of the strip. Weights are summed per segment,
  // because one segment covers several chunks once a transfer is large.
  const weights = [];
  if (Array.isArray(sizes) && sizes.length) {
    for (let i = 0; i < count; i++) weights[i] = 0;
    for (let i = 0; i < span; i++) {
      const at = Math.min(count - 1, Math.floor((i * count) / span));
      weights[at] += Number(sizes[i]) || 0;
    }
  }
  const total_ = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < count; i++) {
    const seg = el('span', { class: 'seg pending' });
    // Falls back to equal shares when no sizes were reported, which is every
    // caller that has not cut the file yet.
    if (total_ > 0) seg.style.flex = `${(weights[i] / total_) * count} 1 0`;
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
    // Draws the key to whatever is on screen. Solid against outlined is the
    // pair that carries dedup, and it is the one distinction a reader cannot
    // guess: without this, a strip of outlines looks like a strip that failed
    // rather than one that had nothing to move.
    legend(container) {
      // Read the painted segments rather than remembering every state ever
      // applied. A final repaint can replace the last pending segment, and a
      // legend that retained that old state would contradict the strip above.
      const showing = new Set(segments.map((seg) => seg.className.slice(4)));
      const rendered = ORDER.filter((s) => showing.has(s.state));
      container.replaceChildren(...rendered.map((s) => el(
        'span',
        {},
        el('i', { class: s.state, 'aria-hidden': 'true' }),
        s.label,
      )));
      container.className = 'legend';
      container.hidden = rendered.length < 2;
    },
    // Points at the chunks that actually moved, under the segments they sit in.
    //
    // The strip already shows where a change landed, but only to someone who has
    // learned that solid means moved. This says it in words, once, at the
    // position it happened, which is the whole claim of content defined
    // chunking: an edit in the middle of a file costs the middle of the file
    // and nothing else.
    //
    // Drawn only when it is news. If everything moved there was no edit to
    // point at, just a first send, and a label on every segment would be noise
    // rather than a finding.
    // Byte offsets across the strip. Only meaningful once segments carry their
    // real widths, because until then a position in the row is not a position in
    // the file. Five marks: enough to locate something, few enough to read.
    ruler(container, fileSize) {
      if (!(total_ > 0) || !fileSize) {
        container.replaceChildren();
        container.hidden = true;
        return;
      }
      const STOPS = 5;
      const marks = [];
      for (let i = 0; i < STOPS; i++) {
        marks.push(el('span', {}, humanBytes((fileSize * i) / (STOPS - 1))));
      }
      container.className = 'ruler';
      container.hidden = false;
      container.replaceChildren(...marks);
    },
    marks(container, indexes, label) {
      const held = segments.filter((seg) => (seg.className || '').includes('held')).length;
      const wanted = new Set([...indexes].map(segIndex));
      if (!held || !wanted.size || wanted.size > segments.length / 2) {
        container.replaceChildren();
        container.hidden = true;
        return;
      }
      container.className = 'marks';
      container.hidden = false;
      // A run of adjacent changed chunks is one edit, so only its first segment
      // is named. Repeating the label under every segment of a run reads as
      // several separate edits, which is a different and wrong story.
      container.replaceChildren(...segments.map((_, i) => {
        if (!wanted.has(i)) return el('span', {});
        const opensRun = !wanted.has(i - 1);
        return el('span', { class: 'mark' }, el('i', {}), opensRun ? el('em', {}, label) : []);
      }));
    },
  };
}

// Canonical order, so the key reads the same on every screen it appears on.
const ORDER = [
  { state: 'pending', label: 'not here yet' },
  { state: 'sending', label: 'in transit' },
  { state: 'stored', label: 'sealed now' },
  { state: 'held', label: 'already held' },
];

// Short enough to sit under a segment without wrapping.
function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
