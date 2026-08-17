import test from 'node:test';
import assert from 'node:assert/strict';
import { thumbnailable, makeThumbnail, THUMB_MAX } from './thumb.js';

test('only images and videos are thumbnailed', () => {
  assert.equal(thumbnailable('image/jpeg'), true);
  assert.equal(thumbnailable('image/png'), true);
  assert.equal(thumbnailable('video/mp4'), true);
  assert.equal(thumbnailable('application/pdf'), false);
  assert.equal(thumbnailable('text/plain'), false);
  assert.equal(thumbnailable(''), false);
  assert.equal(thumbnailable(undefined), false);
});

test('image/svg+xml is refused', () => {
  // An SVG is a document that can reference remote content and run script when
  // rendered. Drawing an untrusted one to a canvas to make a thumbnail is not
  // worth the surface for a format that is already tiny.
  assert.equal(thumbnailable('image/svg+xml'), false);
});

test('the long edge cap is small enough to stay inside a record', () => {
  // Thumbnails ride in the inbox listing, so one per transfer must stay well
  // under the server's record cap. The lower bound matters too: a cap of zero
  // or a fraction still satisfies the ceiling while reducing every thumbnail to
  // a single pixel, which reads as a working feature and is not one.
  assert.ok(Number.isInteger(THUMB_MAX));
  assert.ok(THUMB_MAX > 0);
  assert.ok(THUMB_MAX <= 256);
});

test('a video that never decodes yields no thumbnail rather than waiting forever', async () => {
  // The upload seals and stores the thumbnail before the first chunk goes up,
  // so a wait that never ends would hold an entire transfer open with no error
  // and nothing on screen to explain it. Stand in a video element that fires no
  // event at all and confirm the wait still ends, with null.
  const video = { addEventListener() {}, removeAttribute() {}, load() {} };
  const realDocument = globalThis.document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  globalThis.document = { createElement: () => video };
  URL.createObjectURL = () => 'blob:silent';
  URL.revokeObjectURL = () => {};

  let watchdog;
  // Races a deadline well past the module's own bound so a regression reports a
  // failure instead of hanging the suite.
  const stuck = new Promise((resolve) => {
    watchdog = setTimeout(() => resolve('never settled'), 20000);
  });
  try {
    assert.equal(await Promise.race([makeThumbnail({ type: 'video/mp4' }), stuck]), null);
  } finally {
    clearTimeout(watchdog);
    globalThis.document = realDocument;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
});
