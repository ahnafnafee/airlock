import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_PLAIN, MODE_SEALED, DOMAIN,
  deriveMaster, chunkIdentity, sealChunk, openChunk,
  sealRecord, openRecord, makeCheck, verifyCheck,
  packHashes, unpackHashes, modeOf, b64encode, hex,
} from './crypto.js';

const SALT = b64encode(new Uint8Array(16).fill(7));
const OTHER_SALT = b64encode(new Uint8Array(16).fill(9));
const TID = 'a'.repeat(32);
const OTHER_TID = 'b'.repeat(32);
const enc = (s) => new TextEncoder().encode(s);

// Derived once: 600k PBKDF2 iterations are deliberately slow.
const mkP = deriveMaster('correct horse battery staple', SALT);
const wrongP = deriveMaster('hunter2', SALT);
const otherSaltP = deriveMaster('correct horse battery staple', OTHER_SALT);

test('the same plaintext always yields the same chunk id', async () => {
  // This is the dedup property. If it ever stops holding, dedup silently stops
  // working and every duplicate re-uploads.
  const mk = await mkP;
  const a = await chunkIdentity(mk, MODE_SEALED, enc('the same bytes'));
  const b = await chunkIdentity(mk, MODE_SEALED, enc('the same bytes'));
  assert.equal(a.cid, b.cid);
  assert.deepEqual(a.h, b.h);
  assert.match(a.cid, /^[0-9a-f]{64}$/);
});

test('different plaintext yields a different chunk id', async () => {
  const mk = await mkP;
  const seen = new Set();
  for (let i = 0; i < 64; i++) {
    const { cid } = await chunkIdentity(mk, MODE_SEALED, enc(`chunk number ${i}`));
    assert.ok(!seen.has(cid), `collision at ${i}`);
    seen.add(cid);
  }
});

test('a different master key yields a different id for the same plaintext', async () => {
  // This is the defense against confirmation of file contents. Plain convergent
  // encryption would let anyone who can hash the plaintext compute its id and
  // ask the server whether it is present.
  const a = await chunkIdentity(await mkP, MODE_SEALED, enc('secret document'));
  const b = await chunkIdentity(await otherSaltP, MODE_SEALED, enc('secret document'));
  assert.deepEqual(a.h, b.h, 'the content hash itself is key independent');
  assert.notEqual(a.cid, b.cid);
});

test('the same plaintext always yields the same ciphertext', async () => {
  const mk = await mkP;
  const plain = enc('deterministic please');
  const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
  const a = await sealChunk(mk, MODE_SEALED, h, cid, plain);
  const b = await sealChunk(mk, MODE_SEALED, h, cid, plain);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, plain);
});

test('sealed chunk round trip', async () => {
  const mk = await mkP;
  const plain = new Uint8Array([1, 2, 3, 4, 5]);
  const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
  const sealed = await sealChunk(mk, MODE_SEALED, h, cid, plain);
  assert.deepEqual(await openChunk(mk, MODE_SEALED, h, cid, sealed), plain);
});

test('plaintext mode passes bytes through and hashes directly', async () => {
  const mk = await mkP;
  const plain = enc('not a secret');
  const { h, cid } = await chunkIdentity(mk, MODE_PLAIN, plain);
  assert.equal(cid, hex(h), 'in plaintext mode the id is the content hash itself');
  const stored = await sealChunk(mk, MODE_PLAIN, h, cid, plain);
  assert.deepEqual(stored, plain);
  assert.deepEqual(await openChunk(mk, MODE_PLAIN, h, cid, stored), plain);
});

test('an empty chunk round trips in both modes', async () => {
  const mk = await mkP;
  for (const mode of [MODE_SEALED, MODE_PLAIN]) {
    const empty = new Uint8Array(0);
    const { h, cid } = await chunkIdentity(mk, mode, empty);
    const sealed = await sealChunk(mk, mode, h, cid, empty);
    assert.equal((await openChunk(mk, mode, h, cid, sealed)).length, 0);
  }
});

test('a chunk opened under the wrong id fails', async () => {
  const mk = await mkP;
  const plain = enc('bound to its id');
  const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
  const sealed = await sealChunk(mk, MODE_SEALED, h, cid, plain);
  const wrongCid = 'f'.repeat(64);
  await assert.rejects(async () => openChunk(mk, MODE_SEALED, h, wrongCid, sealed));
});

test('a corrupted chunk is rejected rather than returning garbage', async () => {
  const mk = await mkP;
  const plain = enc('tamper with me');
  const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
  const sealed = await sealChunk(mk, MODE_SEALED, h, cid, plain);
  sealed[sealed.length - 1] ^= 0xff;
  await assert.rejects(async () => openChunk(mk, MODE_SEALED, h, cid, sealed));
});

test('record round trip and mode byte', async () => {
  const mk = await mkP;
  const body = enc(JSON.stringify({ name: 'holiday photo.jpg', size: 12345 }));
  const sealed = await sealRecord(mk, MODE_SEALED, DOMAIN.META, TID, body);
  assert.equal(modeOf(sealed), MODE_SEALED);
  // The wire format other modules read: mode byte, 12 byte IV, ciphertext, 16 byte tag.
  assert.equal(sealed.length, 1 + 12 + body.length + 16);
  assert.deepEqual(await openRecord(mk, DOMAIN.META, TID, sealed), body);

  const plain = await sealRecord(mk, MODE_PLAIN, DOMAIN.META, TID, body);
  assert.equal(modeOf(plain), MODE_PLAIN);
  // The reader is never told which mode was used; it reads the byte.
  assert.deepEqual(await openRecord(mk, DOMAIN.META, TID, plain), body);
});

test('a record bound to one domain cannot be opened as another', async () => {
  const mk = await mkP;
  const sealed = await sealRecord(mk, MODE_SEALED, DOMAIN.META, TID, enc('x'));
  await assert.rejects(async () => openRecord(mk, DOMAIN.LIST, TID, sealed));
  await assert.rejects(async () => openRecord(mk, DOMAIN.THUMB, TID, sealed));
});

test('a record from one transfer cannot be spliced into another', async () => {
  const mk = await mkP;
  const sealed = await sealRecord(mk, MODE_SEALED, DOMAIN.LIST, TID, enc('chunk list'));
  await assert.rejects(async () => openRecord(mk, DOMAIN.LIST, OTHER_TID, sealed));
});

test('the check blob accepts the right passphrase and rejects the wrong one', async () => {
  const record = await makeCheck(await mkP);
  assert.equal(await verifyCheck(await mkP, record), true);
  assert.equal(await verifyCheck(await wrongP, record), false);
});

test('a forged plaintext check blob is rejected under any key', async () => {
  // The check blob comes from the untrusted server. A plaintext record has no
  // authentication tag, so without a mode guard anyone could hand over a blob
  // that decodes to the expected literal and pass the passphrase gate with no
  // key at all.
  const forged = new Uint8Array([MODE_PLAIN, ...enc('airlock-v1')]);
  assert.equal(await verifyCheck(await mkP, forged), false);
  assert.equal(await verifyCheck(await wrongP, forged), false);
});

test('a check blob passed as an ArrayBuffer is still accepted', async () => {
  // This is the shape response.arrayBuffer() hands back, so the mode guard has
  // to read the same normalized view openRecord does.
  const record = await makeCheck(await mkP);
  const buf = record.buffer.slice(record.byteOffset, record.byteOffset + record.byteLength);
  assert.equal(await verifyCheck(await mkP, buf), true);
  assert.equal(await verifyCheck(await wrongP, buf), false);
});

test('hash packing round trips', async () => {
  const hashes = [];
  for (let i = 0; i < 5; i++) hashes.push(new Uint8Array(32).fill(i));
  const packed = packHashes(hashes);
  assert.equal(packed.length, 160);
  assert.deepEqual(unpackHashes(packed), hashes);
});

test('unpacking a truncated hash list is refused', async () => {
  // A chunk list cut short would otherwise silently produce a short file.
  assert.throws(() => unpackHashes(new Uint8Array(33)));
});

test('a bad transfer id is refused before any crypto happens', async () => {
  const mk = await mkP;
  await assert.rejects(async () => sealRecord(mk, MODE_SEALED, DOMAIN.META, '../etc/passwd', enc('x')));
  await assert.rejects(async () => sealRecord(mk, MODE_PLAIN, DOMAIN.META, '../etc/passwd', enc('x')));
});
