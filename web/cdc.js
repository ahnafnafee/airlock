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

// cutPoint returns the length of the chunk beginning at start. It never returns
// zero for a non-empty range, because a zero-length chunk would spin the caller
// forever.
export function cutPoint(buf, start, end, p) {
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

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
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
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  let done = false;

  while (true) {
    while (!done && buf.length < p.max) {
      const r = await reader.read();
      if (r.done) { done = true; break; }
      buf = concat(buf, r.value);
    }
    if (buf.length === 0) return;

    const n = cutPoint(buf, 0, buf.length, p);
    yield buf.subarray(0, n);
    // slice rather than subarray: a view would keep the whole original buffer
    // alive and defeat the streaming property.
    buf = buf.slice(n);
    if (done && buf.length === 0) return;
  }
}

export function chunkFile(file, p) {
  return chunkStream(file.stream(), p);
}
