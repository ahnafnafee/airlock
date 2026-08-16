import test from 'node:test';
import assert from 'node:assert/strict';
import { bitmapOf, indexesFrom } from './staging.js';

test('a bitmap sets exactly the bits it is given', () => {
  assert.deepEqual([...bitmapOf(new Set([0]), 1)], [0b1]);
  assert.deepEqual([...bitmapOf(new Set([0, 1, 2]), 3)], [0b111]);
  assert.deepEqual([...bitmapOf(new Set([7]), 8)], [0b10000000]);
  assert.deepEqual([...bitmapOf(new Set([8]), 9)], [0, 0b1]);
  assert.deepEqual([...bitmapOf(new Set(), 9)], [0, 0]);
});

test('a bitmap is exactly as long as the chunk count needs', () => {
  assert.equal(bitmapOf(new Set(), 1).length, 1);
  assert.equal(bitmapOf(new Set(), 8).length, 1);
  assert.equal(bitmapOf(new Set(), 9).length, 2);
  assert.equal(bitmapOf(new Set(), 5000).length, 625);
});

test('bitmap and index list round trip', () => {
  const held = new Set([0, 3, 9, 4999]);
  assert.deepEqual(new Set(indexesFrom(bitmapOf(held, 5000), 5000)), held);
});

test('bits past the chunk count are ignored', () => {
  // The last byte of a 9-chunk bitmap has seven spare bits. A peer that sets
  // them must not make us believe in chunks that do not exist.
  const bitmap = new Uint8Array([0xff, 0xff]);
  assert.deepEqual(indexesFrom(bitmap, 9), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('an index outside the chunk count sets no bit', () => {
  // The mirror of the case above, on the writing side. Index 9 of a 9-chunk
  // transfer lands in the final byte's spare bits, which is in range of the
  // array and so would be written silently without the bound.
  assert.deepEqual([...bitmapOf(new Set([9]), 9)], [0, 0]);
  assert.deepEqual([...bitmapOf(new Set([-1, 0]), 9)], [0b1, 0]);
});
