// Cutting a file is inherently sequential, because a content-defined boundary
// depends on the bytes before it. Hashing and sealing a chunk depend on nothing
// but that chunk, which is what makes them the half that parallelizes: the main
// thread keeps cutting and hands each chunk to this pool, which is the
// difference between one core and all of them on the CPU-bound half.
//
// Each worker is told the key, the mode and where to stage once, so a per-chunk
// message carries only an index and bytes, and the sealed bytes are written to
// disk by the worker that produced them rather than sent back. A chunk crosses a
// thread boundary once, going in, and never comes back.

// Every busy worker holds a chunk and its sealed copy, so the pool is capped
// rather than opened at the core count. At the largest chunk the server permits
// that is on the order of a hundred megabytes at this cap, and a machine with
// four times the cores would hold four times that for no more throughput than
// memory bandwidth already allows.
const MAX_WORKERS = 8;
const DEFAULT_CORES = 4;

export function poolSize() {
  const cores = globalThis.navigator?.hardwareConcurrency;
  return Math.max(1, Math.min(MAX_WORKERS, Number.isInteger(cores) ? cores : DEFAULT_CORES));
}

// The workers are taken as a factory so the pool's own logic is testable without
// one, which is where the bugs are: a reply matched to the wrong chunk, a caller
// left waiting on a worker that is never coming, or a pool that quietly runs one
// chunk at a time.
export function sealPool(size, spawn) {
  const workers = [];
  const free = [];
  // Callers holding a chunk with no worker to give it to. This is the
  // backpressure: without it the main thread would cut faster than the pool
  // seals and hold the whole file in memory, which is the thing the streaming
  // chunker exists to avoid.
  const waiting = [];
  const running = new Map();
  const starting = new Map();
  let broken = null;

  // Nothing is retried. Every chunk of one transfer is sealed by one pool, so a
  // pool that has lost a worker cannot finish the job it was made for, and
  // failing at once is what lets the caller take the partial stage back down
  // rather than leaving a preparation that neither finishes nor fails.
  function fail(reason) {
    broken = broken || new Error(reason);
    const stranded = [...running.values(), ...starting.values(), ...waiting];
    running.clear();
    starting.clear();
    waiting.length = 0;
    for (const job of stranded) job.reject(broken);
  }

  function release(worker) {
    const next = waiting.shift();
    if (next) next.resolve(worker);
    else free.push(worker);
  }

  for (let i = 0; i < size; i++) {
    const worker = spawn();
    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'ready') {
        const start = starting.get(worker);
        starting.delete(worker);
        start?.resolve();
        return;
      }
      const job = running.get(worker);
      // A reply to a chunk nobody is waiting on is a worker that answered after
      // the pool was closed or had already failed.
      if (!job) return;
      running.delete(worker);
      release(worker);
      if (msg.error) job.reject(new Error(msg.error));
      else job.resolve(msg);
    };
    worker.onerror = () => fail('a seal worker stopped');
    worker.onmessageerror = () => fail('a seal worker stopped');
    workers.push(worker);
    free.push(worker);
  }

  // One round trip per worker, carrying everything that is the same for every
  // chunk. A non-extractable CryptoKey survives structured clone, so no key
  // material is serialized to get there.
  function init(mk, mode, transferId) {
    if (broken) return Promise.reject(broken);
    return Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
      starting.set(worker, { resolve, reject });
      worker.postMessage({ type: 'init', mk, mode, transferId });
    })));
  }

  async function seal(index, plain) {
    if (broken) throw broken;
    const worker = free.pop()
      || await new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    if (broken) throw broken;
    return new Promise((resolve, reject) => {
      running.set(worker, { resolve, reject });
      // The chunk is handed over rather than copied. Without the transfer list
      // every chunk is duplicated on the way in, which is a full extra copy of
      // the file and appears in no profile line by name. Only a view that owns
      // its whole buffer may be transferred: detaching a buffer another view
      // still reads from would empty that view instead of costing a copy.
      const whole = plain.byteOffset === 0 && plain.byteLength === plain.buffer.byteLength;
      try {
        worker.postMessage({ index, plain }, whole ? [plain.buffer] : []);
      } catch (err) {
        running.delete(worker);
        release(worker);
        reject(err);
      }
    });
  }

  function close() {
    fail('the seal pool was closed');
    for (const worker of workers) worker.terminate();
  }

  return { size, init, seal, close };
}
