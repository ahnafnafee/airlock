# Benchmarks

Two design decisions were left open until they could be measured: whether the
`host` Tailscale mode really beats `embedded`, and whether the sealing toggle
buys anything at all. This file records what was measured, on what, and what the
numbers say about each decision, including where they disagree with the
reasoning the design was built on.

Two of the four measurements are done. Two need hardware this was not run on and
are marked **not yet measured**, with the exact commands to take them.

## Machine

| | |
| --- | --- |
| CPU | Intel Core i9-14900K |
| Memory | 64 GB |
| OS | Windows 11 Pro, build 10.0.22631 |
| Disk | WD SN550 1 TB NVMe, NTFS, `C:` volume (Go's `b.TempDir()` lands here) |
| Go | 1.26.5, windows/amd64 |
| Node | 22.17.1 |
| Defender real-time protection | off |
| Date | 2026-08-15 |

Every number below is a median of the repeat count named with it. The spread is
reported too, because on one of these the spread is the finding.

## 1. Server chunk store, measured

```
go test -bench=. -benchmem -run='^$' -count=5 ./...
```

`BenchmarkChunkStorePut` times one `ChunkStore.Put`: a temp file created, the
body streamed into it, the file closed, renamed into its shard and stat'd. No
network, no HTTP, no crypto.

| Chunk size | ns/op (median of 5) | MB/s | Spread across 5 runs |
| --- | --- | --- | --- |
| 64 KiB | 1,914,465 | 34.2 | 0.94 ms to 5.94 ms |
| 1 MiB | 1,508,637 | 695 | 1.45 ms to 1.55 ms |
| 8 MiB | 4,865,831 | 1,724 | 4.77 ms to 5.97 ms |

Allocations are flat at about 36 KB and 20 to 22 allocations per Put regardless
of chunk size, which is what streaming through `io.Copy` is supposed to look
like: the body never becomes a buffer.

Taking the fastest sample at each size, the three fit `t = 0.9 ms + size /
2.1 GB/s` within 5 percent. The fixed 0.9 ms is the NTFS metadata work, and it
is per chunk rather than per byte. That is the whole reason the 64 KiB row is
slow: at 64 KiB the fixed cost is 97 percent of the operation, so throughput
collapses even though the disk is doing almost nothing. It is also why the
64 KiB row is the noisy one. A 6x spread on a measurement whose cost is almost
entirely filesystem metadata is the operating system's write-back behavior
showing through, not the store's, and the median of a distribution that skewed
understates the store more than the minimum overstates it.

The configured chunker never emits a chunk that small: `cdcDefaults` sets a
512 KiB minimum, a 1 MiB target and an 8 MiB maximum. The 64 KiB row is here as
a floor probe, and it retroactively justifies that minimum. Below roughly
512 KiB the store stops being a throughput problem and becomes a syscall-count
problem.

**At the size the app actually uses, the server stores at about 695 MB/s.** That
is between 5 and 50 times faster than any tailnet link, so the store is not the
bottleneck in an upload and a slow end-to-end number should not be blamed on it.

`BenchmarkSweep` times one full mark-and-sweep against 5,000 chunks, all of them
referenced by one live transfer.

| | ns/op (median of 3) | B/op | allocs/op |
| --- | --- | --- | --- |
| Sweep, 5,000 chunks | 63,319,344 | 4.00 MB | 28,441 |

63 ms for 5,000 chunks is about 12.7 us per chunk, and it is linear in the store
size by construction. Against the hourly sweep interval that is four orders of
magnitude of headroom: on time alone the sweep would need roughly 280 million
chunks before it outlasted its own interval.

Time is not the binding constraint, though, and the same benchmark says so. At
4.00 MB per sweep over 5,000 chunks, the reference set costs about 800 bytes per
chunk, because `Referenced()` materializes every id as a string in a map before
`Sweep` walks anything. A store large enough to make the sweep slow would need
hundreds of gigabytes to mark. Memory runs out first, by a wide margin.

The `ponytail:` note on `ChunkStore.Sweep` proposes moving to per-chunk
refcounts if the sweep ever outlasts its interval. On the trigger it names it
can stay parked, since no personal node reaches a store where 63 ms per 5,000
chunks becomes an hour. The trigger worth watching instead is the mark set's
footprint, which is the number that grows first.

## 2. Browser sealing pipeline, measured on Node

**Caveat first: this is Node 22, not a browser.** Node and the browser reach the
same native implementations through the same Web Crypto API, and this runs the
app's own unmodified `web/crypto.js`, so the crypto cost is real. What it does
not include is the page's own overhead: structured-clone of the chunk into and
out of the crypto threadpool, and whatever else the tab is doing. Treat these as
a floor on browser cost, not as the browser cost.

1 MiB chunks. Each run discards 20 warm-up rounds and reports the mean of 200;
the table is the median of 5 such runs, which agreed within 3 percent.

| Step | Sealed | Plain | Difference |
| --- | --- | --- | --- |
| `chunkIdentity` | 0.706 ms | 0.600 ms | 0.106 ms |
| `sealChunk` | 0.650 ms | 0.184 ms | 0.466 ms |
| **Total per 1 MiB chunk** | **1.356 ms** | **0.784 ms** | **0.572 ms** |
| Equivalent throughput | 737 MB/s | 1,276 MB/s | |

Reproduce it by saving this as `cryptobench.mjs` outside the repo and running
`node cryptobench.mjs file:///<abs-path>/web/crypto.js`:

```js
const { deriveMaster, chunkIdentity, sealChunk, MODE_SEALED, MODE_PLAIN } =
  await import(process.argv[2]);

const SIZE = 1 << 20;
const ROUNDS = 200;

const mk = await deriveMaster('a benchmark passphrase', Buffer.alloc(16, 7).toString('base64'));

// getRandomValues caps at 64 KiB per call, so fill in blocks.
const plain = new Uint8Array(SIZE);
for (let off = 0; off < SIZE; off += 65536) {
  crypto.getRandomValues(plain.subarray(off, Math.min(off + 65536, SIZE)));
}

async function time(label, fn) {
  for (let i = 0; i < 20; i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < ROUNDS; i++) await fn();
  const ms = (performance.now() - t0) / ROUNDS;
  console.log(`${label.padEnd(24)} ${ms.toFixed(3)} ms/chunk   ${(1000 / ms).toFixed(0)} MB/s`);
  return ms;
}

const idSealed = await time('chunkIdentity sealed', () => chunkIdentity(mk, MODE_SEALED, plain));
const idPlain = await time('chunkIdentity plain', () => chunkIdentity(mk, MODE_PLAIN, plain));
const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
const sealSealed = await time('sealChunk sealed', () => sealChunk(mk, MODE_SEALED, h, cid, plain));
const sealPlain = await time('sealChunk plain', () => sealChunk(mk, MODE_PLAIN, h, cid, plain));
console.log(`sealed total ${(idSealed + sealSealed).toFixed(3)} ms, plain total ${(idPlain + sealPlain).toFixed(3)} ms`);
```

The result the design did not anticipate is in the `chunkIdentity` row.
**Turning sealing off does not remove the hashing.** A chunk's content hash is
what the chunk list is made of and what the id derives from, so SHA-256 runs in
both modes. 0.600 of the 0.784 ms that plain mode costs is that hash. The
toggle can therefore never remove more than 42 percent of the crypto time, no
matter how fast the rest of the machine is.

### Which of these two rows is on the critical path

The uploader reads the file twice, and the two passes are not equal.

Pass one (`upload.js`, the loop that fills `ids`) hashes every chunk in the file
before a single byte goes out, because the transfer cannot be created until the
whole id list exists. Nothing overlaps it. Its cost lands on the wall clock in
full: **0.706 ms per MiB sealed, 0.600 ms plain.**

Pass two seals each chunk and hands it to an uploader running four requests in
flight, so `sealChunk` overlaps with the network. Its 0.650 ms per MiB is
invisible until it becomes the bottleneck, which needs a link faster than about
1,540 MB/s, or 12 gigabits.

So of the 0.572 ms per MiB the toggle removes, only the 0.106 ms in pass one is
wall clock a user could feel. The rest was already hiding behind the wire.

## 3. Tailscale host against embedded, not yet measured

Needs a real tailnet and two devices. Run on the server, once in each mode, with
the client on another tailnet device:

```bash
head -c 8388608 /dev/urandom > /tmp/chunk8m
time for i in $(seq 1 128); do
  id=$(printf '%064x' $i)
  curl -s -o /dev/null -X PUT --data-binary @/tmp/chunk8m \
    "https://<node>.<tailnet>.ts.net/api/chunk/$id"
done
```

1 GiB per run. Record MB/s for `--tailscale-mode=host` and again for
`--tailscale-mode=embedded`, and fill in the table below.

| Mode | Wall clock for 1 GiB | MB/s |
| --- | --- | --- |
| `host` | not yet measured | |
| `embedded` | not yet measured | |

Two things to watch when taking it. Send the 128 chunks under distinct ids, as
the loop above does, or `Put`'s first-write-wins short circuit turns run 2
onwards into a stat and the number becomes meaningless. And confirm from
`tailscale status` whether the link went direct or relayed through DERP, because
a DERP-relayed run measures the relay and not the mode.

## 4. Sealed against plaintext end to end, not yet measured

Needs a browser and the same tailnet. Upload one file twice with a warm cache,
once with the sealing toggle on and once off, and use the Performance panel to
separate time inside `chunkIdentity` and `sealChunk` from time inside `fetch`.

| | Wall clock | Crypto time | Network time |
| --- | --- | --- | --- |
| Sealed | not yet measured | | |
| Plaintext | not yet measured | | |

Use a file of at least a few hundred MB. At the numbers in section 2 the whole
crypto contribution for a 100 MB file is about 0.13 seconds, and the part the
toggle removes from the critical path is about 0.01 seconds. A small file will
not resolve that above the noise.

Separate the two passes in the trace rather than totalling `chunkIdentity` and
`sealChunk` together. Pass one runs before the first `fetch` and is the only
part that is unoverlapped, so it is the only part where a difference between the
two modes can show up as wall clock. If the measured difference is larger than
pass one alone accounts for, the pipeline is not overlapping the way section 2
assumes, and that is worth knowing.

## The two open decisions

### Does `host` beat `embedded`?

**Undecided. The measurement in section 3 has not been taken.** The default
should not be changed on the strength of the argument alone.

### Is the sealing toggle worth anything?

**The prediction recorded before the run was that encryption would not be
measurable against network time. The conclusion holds. The reasoning behind it
does not, and the corrected reasoning happens to hold more strongly.**

The prediction's arithmetic was that AES-GCM and SHA-256 reach native code at
gigabytes per second against a tailnet's tens of megabytes per second, so crypto
disappears by three orders of magnitude. The measured pipeline runs at 737 MB/s
on a desktop i9-14900K, not at gigabytes per second, because a sealed chunk gets
three passes rather than one: SHA-256, then HKDF, then AES-GCM. Against a
50 MB/s tailnet that is 15 times the wire, not a thousand. Against a saturated
gigabit direct link it is 6 times. That is headroom rather than invisibility,
and on a phone with a CPU 3 to 5 times slower it would be thinner still.

What rescues the conclusion is not the ratio but the pipeline. Only pass one is
unoverlapped, and pass one is the hash, which the toggle cannot remove. So:

- The crypto the toggle **cannot** remove, on the critical path, is 0.600 ms per
  MiB, about 0.61 seconds per gigabyte. That is the floor in both modes.
- The crypto the toggle **can** remove from the critical path is 0.106 ms per
  MiB, about 0.11 seconds per gigabyte. On a 50 MB/s tailnet a gigabyte takes 21
  seconds, so the toggle is worth about half a percent of the transfer.
- The remaining 0.466 ms per MiB, the AES-GCM itself, is already hidden behind
  four in-flight uploads and would only surface on a link past 12 gigabits.

So the toggle stays, and it is not a performance setting. Turning sealing off
buys well under one percent of a transfer and gives up the entire threat model.
The UI reflects that: the control is labeled by what it does to secrecy, its off
state states the consequence in `--breach` rather than softening it, and no
speed claim appears anywhere near it.

**Open question this file leaves behind.** Every crypto number here was taken on
a desktop i9-14900K. A phone is the case where the ratio is thinnest and it is
also the common sending device. Re-run section 2's script under a mobile
browser, or take section 4 on a phone, before anyone concludes the margin is
comfortable everywhere.
