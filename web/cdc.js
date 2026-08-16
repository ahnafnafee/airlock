// Content-defined chunking, FastCDC style. Boundaries are chosen by the data
// rather than by offset, so inserting a byte near the front of a file
// invalidates only the chunks around the insertion instead of every chunk after
// it. That property is what makes delta sync work.

// A table of 256 pseudorandom 32-bit values, generated deterministically from a
// fixed seed rather than hardcoded. Every device must produce identical
// boundaries or dedup quietly stops working between them, with no error
// anywhere to notice.
const GEAR = (() => {
  const g = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    g[i] = x;
  }
  return g;
})();

const PARAM_NAMES = ['min', 'normal', 'max', 'maskS', 'maskL'];

// checkParams fails closed on a malformed params object. Without it a missing
// field is silently falsy: an absent max makes the refill loop never run and the
// whole file chunks to nothing, and an absent mask makes every position a
// boundary because a bitwise and with undefined is zero. Both destroy the
// manifest while the transfer still reports success, which is exactly the class
// of failure this module has no other way to notice. Cost is one call per chunk,
// not per byte.
function checkParams(p) {
  if (p === null || typeof p !== 'object') {
    throw new Error('cdc params: expected an object with min, normal, max, maskS, maskL');
  }
  for (const name of PARAM_NAMES) {
    const v = p[name];
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`cdc params: ${name} must be a non-negative integer, got ${String(v)}`);
    }
  }
  if (p.min < 1) {
    throw new Error(`cdc params: min must be at least 1, got ${p.min}`);
  }
  if (p.min > p.normal) {
    throw new Error(`cdc params: min (${p.min}) must not exceed normal (${p.normal})`);
  }
  if (p.normal > p.max) {
    throw new Error(`cdc params: normal (${p.normal}) must not exceed max (${p.max})`);
  }
}

// cutPoint returns the length of the chunk beginning at start. It never returns
// zero for a non-empty range, because a zero-length chunk would spin the caller
// forever.
export function cutPoint(buf, start, end, p) {
  checkParams(p);
  let n = end - start;
  if (n <= p.min) return n;
  if (n > p.max) n = p.max;
  const normal = Math.min(p.normal, n);

  let fp = 0;
  let i = p.min;
  // Below the target size the stricter mask makes a cut unlikely, which is what
  // stops chunks from clustering at the minimum. Past it, the looser mask makes
  // one likely, which pulls the average toward the target.
  for (; i < normal; i++) {
    fp = ((fp << 1) + GEAR[buf[start + i]]) >>> 0;
    if ((fp & p.maskS) === 0) return i + 1;
  }
  for (; i < n; i++) {
    fp = ((fp << 1) + GEAR[buf[start + i]]) >>> 0;
    if ((fp & p.maskL) === 0) return i + 1;
  }
  return n;
}

// chunkStream yields plaintext chunks from a ReadableStream of Uint8Array. It
// holds at most one maximum-sized window plus the incoming slice, so a 20 GB
// file costs the same memory as a 20 MB one.
//
// The buffer is refilled to at least max before every cut, which is what makes
// the output independent of how the source stream happens to slice its reads.
// Cutting from a short buffer would produce different boundaries on a device
// with a different read size, and dedup between those two devices would fail.
export async function* chunkStream(stream, p) {
  checkParams(p);
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  let done = false;

  while (true) {
    if (!done && buf.length < p.max) {
      // Collect the incoming slices and join them once. Growing the window on
      // every read instead would copy the entire window per read, and a browser
      // hands out reads of tens of kilobytes against a multi-megabyte window, so
      // that is on the order of a hundred full-window copies per chunk. The
      // bytes are identical either way, so boundaries are unaffected.
      const parts = [buf];
      let total = buf.length;
      while (total < p.max) {
        const r = await reader.read();
        if (r.done) { done = true; break; }
        parts.push(r.value);
        total += r.value.length;
      }
      if (parts.length > 1) {
        const joined = new Uint8Array(total);
        let off = 0;
        for (const part of parts) { joined.set(part, off); off += part.length; }
        buf = joined;
      }
    }
    if (buf.length === 0) return;

    const n = cutPoint(buf, 0, buf.length, p);
    // The chunk is copied out and the window becomes a view of what is left,
    // rather than the other way round. A chunk that owns its whole buffer can be
    // handed to a seal worker in a transfer list instead of being structured
    // cloned into it, and that clone is a second full copy of the file. A view
    // could not be: transferring it would detach the window this loop is still
    // cutting from, and the file would end at the first chunk.
    //
    // The remainder is copied anyway by the next refill, which joins it with
    // what it reads, so this costs no copy that was not already being paid.
    // ponytail: the window is rebuilt by concatenation on every refill rather
    // than held in a preallocated max-plus-slice buffer. The ceiling is that one
    // copy of the remainder per chunk, on top of the chunk's own. Lift it with a
    // fill offset and copyWithin after each cut, and the index bookkeeping that
    // comes with them.
    const chunk = buf.slice(0, n);
    buf = buf.subarray(n);
    yield chunk;
    if (done && buf.length === 0) return;
  }
}

export function chunkFile(file, p) {
  return chunkStream(file.stream(), p);
}
