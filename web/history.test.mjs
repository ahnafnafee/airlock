import test from 'node:test';
import assert from 'node:assert/strict';

// The view registers itself against the app shell on import, and the shell
// reaches for a document. Only the paging arithmetic is under test here, and it
// is written to touch no element at all.
globalThis.document = {
  createElement: () => ({
    setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {},
    classList: { add() {}, remove() {} }, dataset: {}, style: { setProperty() {} },
    children: [],
  }),
  getElementById: () => ({ append() {}, children: [] }),
  documentElement: { dataset: {} },
  createTextNode: (t) => ({ text: t }),
  // boot() reports a failure by prepending to the body, and it will fail here
  // because there is no server to reach. Somewhere to put that is all it needs.
  body: { prepend() {} },
  addEventListener() {},
};
globalThis.addEventListener = () => {};
globalThis.location = { hash: '' };

const { PAGE, pageOf, took } = await import('./views/history.js');

// A row that says how long a send took is the only place the numbers behind a
// "why was that slow" question are ever visible, so the reading has to stay
// honest at both ends of the range.
test('a duration reads at a resolution worth acting on', () => {
  assert.equal(took(0), '0.0s');
  assert.equal(took(3240), '3.2s');
  assert.equal(took(9949), '9.9s');
  // Tenths stop mattering once a send is long enough to walk away from.
  assert.equal(took(10000), '10s');
  assert.equal(took(42600), '43s');
  assert.equal(took(60000), '1m 00s');
  assert.equal(took(125400), '2m 05s');
});

// A transfer sent before the sender recorded timings, or a record that would not
// open, has no duration. The row must drop it rather than claim it took no time.
test('a missing or nonsense duration is absent, not zero', () => {
  assert.equal(took(null), null);
  assert.equal(took(undefined), null);
  assert.equal(took(NaN), null);
  assert.equal(took(-1), null);
});

// The arithmetic is the behaviour. An off-by-one here is a row nobody can reach.
test('a page covers the slice it names, and the last one is short', () => {
  assert.deepEqual(pageOf(60, 1, 25), { page: 1, pages: 3, from: 0, to: 25 });
  assert.deepEqual(pageOf(60, 2, 25), { page: 2, pages: 3, from: 25, to: 50 });
  // The last page stops at the end of the list rather than at a page boundary.
  assert.deepEqual(pageOf(60, 3, 25), { page: 3, pages: 3, from: 50, to: 60 });

  // Every row is reachable: the pages tile the list with no gap and no overlap.
  const covered = [];
  for (let p = 1; p <= pageOf(60, 1, 25).pages; p++) {
    const at = pageOf(60, p, 25);
    for (let i = at.from; i < at.to; i++) covered.push(i);
  }
  assert.deepEqual(covered, Array.from({ length: 60 }, (_, i) => i));
});

test('an exact multiple does not leave an empty page at the end', () => {
  assert.equal(pageOf(50, 1, 25).pages, 2);
  assert.deepEqual(pageOf(50, 2, 25), { page: 2, pages: 2, from: 25, to: 50 });
});

// A history that shortens while the view is open must not leave it on a page
// that no longer exists, which would render as an empty list and read as a
// history that had been wiped.
test('a page beyond the end clamps to the last one', () => {
  assert.equal(pageOf(60, 9, 25).page, 3);
  assert.equal(pageOf(60, 0, 25).page, 1);
  assert.equal(pageOf(60, -4, 25).page, 1);
});

test('an empty history is one empty page rather than none', () => {
  assert.deepEqual(pageOf(0, 1, 25), { page: 1, pages: 1, from: 0, to: 0 });
});

test('a list shorter than a page is one page', () => {
  assert.deepEqual(pageOf(7, 1, 25), { page: 1, pages: 1, from: 0, to: 7 });
  assert.equal(PAGE, 10, 'a page holds ten rows');
});
