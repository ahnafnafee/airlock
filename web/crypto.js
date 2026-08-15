// All encryption happens here, in the browser. The server holds ciphertext and
// nothing else. Node exposes the same Web Crypto API, so this module is tested
// directly with `node --test`.

const PBKDF2_ITERATIONS = 600000;
const IV_LEN = 12;
const TAG_LEN = 16;
const HASH_LEN = 32;
const CHECK_PLAINTEXT = 'airlock-v1';

export const MODE_PLAIN = 0x00;
export const MODE_SEALED = 0x01;

// Domain bytes keep the four kinds of sealed record from being substituted for
// each other.
export const DOMAIN = { META: 0x4d, LIST: 0x4c, THUMB: 0x54, CHECK: 0x4b };

const enc = (s) => new TextEncoder().encode(s);

export function b64encode(bytes) {
  // Built one character at a time on purpose: String.fromCharCode.apply blows
  // the stack on large arrays.
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(s, expectedLength) {
  if (!new RegExp(`^[0-9a-f]{${expectedLength * 2}}$`).test(s)) {
    throw new Error('malformed id');
  }
  const out = new Uint8Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function deriveMaster(passphrase, saltB64) {
  const base = await crypto.subtle.importKey(
    'raw', enc(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64decode(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, 256);
  // Imported non-extractable, so it can live in IndexedDB and be used by the
  // service worker without ever being readable by script.
  return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

function hkdfBits(mk, salt, info, byteLength) {
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc(info) }, mk, byteLength * 8)
    .then((b) => new Uint8Array(b));
}

function hkdfAesKey(mk, salt, info) {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc(info) }, mk,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// chunkIdentity computes the content hash and the server-facing id.
//
// In sealed mode the id mixes the master key in, so only passphrase holders can
// compute an id from a plaintext. Plain convergent encryption, where the id is
// just a hash of the content, would let anyone test whether the server holds a
// file they already have.
export async function chunkIdentity(mk, mode, plain) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', plain));
  if (mode === MODE_PLAIN) return { h, cid: hex(h) };
  return { h, cid: hex(await hkdfBits(mk, h, 'airlock-cid-v1', 32)) };
}

// sealChunk is deterministic by design: the key and the IV both derive from the
// plaintext's own hash, so identical bytes always produce identical ciphertext
// and the server can recognize a duplicate.
//
// A deterministic IV is safe only because of that derivation. GCM's nonce-reuse
// catastrophe needs one key and IV pair used on two different plaintexts, which
// cannot happen when the key itself is a function of the plaintext.
export async function sealChunk(mk, mode, h, cid, plain) {
  if (mode === MODE_PLAIN) return new Uint8Array(plain);
  const key = await hkdfAesKey(mk, h, 'airlock-key-v1');
  const iv = await hkdfBits(mk, h, 'airlock-iv-v1', IV_LEN);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: hexToBytes(cid, 32) }, key, plain);
  return new Uint8Array(ct);
}

export async function openChunk(mk, mode, h, cid, sealed) {
  if (mode === MODE_PLAIN) return new Uint8Array(sealed);
  const key = await hkdfAesKey(mk, h, 'airlock-key-v1');
  const iv = await hkdfBits(mk, h, 'airlock-iv-v1', IV_LEN);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: hexToBytes(cid, 32) }, key, sealed);
  return new Uint8Array(plain);
}

// The record key seals everything that is per transfer rather than per chunk.
// Records are not content-addressed, so they use random IVs.
const recordKey = (mk) => hkdfAesKey(mk, new Uint8Array(32), 'airlock-meta-v1');

function recordAAD(domain, transferId) {
  if (domain === DOMAIN.CHECK) return new Uint8Array([DOMAIN.CHECK]);
  const a = new Uint8Array(1 + 16);
  a[0] = domain;
  a.set(hexToBytes(transferId, 16), 1);
  return a;
}

export function modeOf(record) {
  return record[0];
}

// Records carry their mode in the first byte, so a reader never has to be told
// which scheme was used and the server needs no field for it.
export async function sealRecord(mk, mode, domain, transferId, bytes) {
  const aad = recordAAD(domain, transferId);
  if (mode === MODE_PLAIN) {
    const out = new Uint8Array(1 + bytes.length);
    out[0] = MODE_PLAIN;
    out.set(bytes, 1);
    return out;
  }
  const key = await recordKey(mk);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad }, key, bytes));
  const out = new Uint8Array(1 + IV_LEN + ct.length);
  out[0] = MODE_SEALED;
  out.set(iv, 1);
  out.set(ct, 1 + IV_LEN);
  return out;
}

export async function openRecord(mk, domain, transferId, record) {
  const b = record instanceof Uint8Array ? record : new Uint8Array(record);
  const aad = recordAAD(domain, transferId);
  if (b.length < 1) throw new Error('empty record');
  if (b[0] === MODE_PLAIN) return b.slice(1);
  if (b.length < 1 + IV_LEN + TAG_LEN) throw new Error('record too short');
  const key = await recordKey(mk);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b.subarray(1, 1 + IV_LEN), additionalData: aad },
    key, b.subarray(1 + IV_LEN));
  return new Uint8Array(plain);
}

export const makeCheck = (mk) =>
  sealRecord(mk, MODE_SEALED, DOMAIN.CHECK, null, enc(CHECK_PLAINTEXT));

export async function verifyCheck(mk, record) {
  try {
    const got = await openRecord(mk, DOMAIN.CHECK, null, record);
    return new TextDecoder().decode(got) === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

// The chunk list is raw concatenated hashes rather than JSON: 32 bytes per
// chunk instead of about 70, which matters at thousands of chunks per file.
export function packHashes(hashes) {
  const out = new Uint8Array(hashes.length * HASH_LEN);
  hashes.forEach((h, i) => out.set(h, i * HASH_LEN));
  return out;
}

export function unpackHashes(bytes) {
  if (bytes.length % HASH_LEN !== 0) {
    // A truncated list would otherwise silently produce a short file.
    throw new Error('chunk list is not a whole number of hashes');
  }
  const out = [];
  for (let i = 0; i < bytes.length; i += HASH_LEN) {
    out.push(bytes.slice(i, i + HASH_LEN));
  }
  return out;
}

// Key storage. IndexedDB is reachable from both the page and the service worker,
// which is what lets the worker decrypt downloads and notification metadata on
// its own.
const DB_NAME = 'airlock';
const STORE_NAME = 'kv';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvPut(k, v) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvGet(k) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(k);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const saveMaster = (mk) => kvPut('master', mk);
export const loadMaster = () => kvGet('master');
