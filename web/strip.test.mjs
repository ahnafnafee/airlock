import test from 'node:test';
import assert from 'node:assert/strict';
// Imported before the fake document exists on purpose. Nothing in this module
// touches the DOM while it evaluates, and the helper it borrows reads `document`
// at call time, so the stub below is in place by the time a strip is built.
import { segmentCount, renderStrip } from './strip.js';

// The gap the stylesheet puts between two segments, restated here so an
// assertion about segment width has something to assert against. This is the
// test's own arithmetic rather than a second copy of a decision: if the
// stylesheet's gap changes, this number is what should fail.
const GAP_PX = 1;

// A DOM small enough to say what it stands for: a block child fills the content
// box of the block it is appended to, which is the whole of what the strip ever
// asks the layout for.
function fakeDom(width) {
  const make = (tag) => ({
    tag,
    className: '',
    attrs: {},
    children: [],
    clientWidth: 0,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    append(...kids) {
      for (const kid of kids) {
        kid.clientWidth = this.clientWidth;
        this.children.push(kid);
      }
    },
  });
  globalThis.document = { createElement: make };
  const container = make('div');
  container.clientWidth = width;
  return container;
}

const widthOf = (strip, count) => (strip - (count - 1) * GAP_PX) / count;

test('no strip is ever thinner per segment than the gap between two of them', () => {
  // A phone column is 288px at the 320px floor the design promises, and 361px on
  // a common phone. Both used to draw the cap, which put 0.2px and 0.5px of
  // segment between 1px gaps: more gap than mark, which is a texture and not a
  // reading of state.
  for (const strip of [240, 288, 328, 361, 448, 602, 728, 1100]) {
    const count = segmentCount(strip, 4096);
    assert.ok(
      widthOf(strip, count) >= 3,
      `${strip}px drew ${count} segments of ${widthOf(strip, count)}px`,
    );
    // And not so few that the strip stops being a strip: one more segment would
    // have to break the floor for this count to be the right one.
    assert.ok(
      count === 240 || widthOf(strip, count + 1) < 3,
      `${strip}px had room for more than ${count} segments`,
    );
  }
});

test('a file with fewer chunks than the strip has room for gets one segment each', () => {
  // The whole point of the element. Twelve chunks are twelve marks, not twelve
  // twelfths of a bar, and never more marks than there are chunks to put in them.
  assert.equal(segmentCount(728, 12), 12);
  assert.equal(segmentCount(288, 1), 1);
});

test('the cap still holds where the width would allow more', () => {
  assert.equal(segmentCount(4000, 4096), 240);
});

test('a strip built before its section is on screen keeps the count it asked for', () => {
  // The pairing screen builds its strip while the section is still hidden, so
  // the width reads as zero. Zero there means not laid out yet, not no room, and
  // collapsing to a single segment would leave that screen with a lone block.
  assert.equal(segmentCount(0, 48), 48);
  assert.equal(segmentCount(0, 4096), 240);
});

test('a strip sizes itself to the container it is put in', () => {
  const narrow = renderStripInto(288, 4096);
  const wide = renderStripInto(728, 4096);
  assert.equal(narrow.count, 72);
  assert.equal(wide.count, 182);
});

test('every chunk reaches a segment whatever count the width chose', () => {
  // The scaling that maps chunks onto segments has to stay right for the count
  // the width picked, not for the cap. A bucket of ceil(total / count) overshoots
  // whenever the division is inexact and strands the tail, so a finished transfer
  // would render as a strip with unlit segments on the end.
  for (const [width, total] of [[288, 4096], [361, 1000], [728, 517], [288, 73]]) {
    const container = fakeDom(width);
    const strip = renderStrip(container, total);
    const segments = container.children[0].children;

    strip.setAll('pending');
    strip.set(total - 1, 'stored');
    assert.equal(
      segments[segments.length - 1].className, 'seg stored',
      `the last chunk of ${total} missed the last of ${segments.length} segments`,
    );

    strip.setAll('pending');
    strip.setRange(0, total, 'held');
    assert.ok(
      segments.every((s) => s.className === 'seg held'),
      `a full range over ${total} chunks left ${segments.length} segments unpainted`,
    );
  }
});

function renderStripInto(width, total) {
  const container = fakeDom(width);
  renderStrip(container, total);
  return { count: container.children[0].children.length };
}
