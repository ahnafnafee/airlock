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

Needs a real tailnet and two devices. The client runs on the second device and
uploads to the server, once with the server in each mode.

### Before the first run

Four things will each turn the run into a measurement of nothing. The script
below aborts on the ones it can see, so these are the setup steps it cannot do
for you. The first is the dangerous one, because it is the only one that can
still produce a plausible-looking number.

**The mode is chosen by `-tailscale-mode`, and the two modes do not share a
URL.** Start the server with `-tailscale-mode=host` for the first three runs and
`-tailscale-mode=embedded` for the second three. The flag defaults to `host`, so
a second server started without it is a second host-mode server, and the
comparison quietly becomes host against host. Nothing downstream can catch that:
the script cannot tell which mode answered, and two host runs agreeing to within
a few percent is exactly what a real finding of "the modes are equivalent" would
also look like.

The two modes answer on different names, which is the other half of the same
trap. `host` binds the server machine's own tailnet address, so it answers on
that machine's tailnet name. `embedded` joins as its own tsnet node named by
`-hostname`, default `airlock`, so it answers on `airlock.<tailnet>.ts.net`.
Take the base URL for each mode from that mode's own startup, and do not reuse
the first one for the second run. If the first server is still up when the
second run starts, reusing its URL measures the first mode twice and reports the
two as identical, which is a wrong answer that looks like a finding.

**The client device must be allowed through the gate**, or every request is 403
before the body is read. Two separate checks can produce that 403. The tailnet
allowlist defaults to the server node's owner, so a client device owned by a
different tailnet user is refused unless the server was started with
`-allow-users`. And with `-require-approval` set, a device that has never been
approved is refused even when its user is allowed. Confirm the client is through
both with `curl https://<base>/api/whoami`, which must answer
`"allowed":true`.

**`embedded` needs `TS_AUTHKEY`** in the environment the first time it starts,
or it never joins the tailnet.

**Each run stores a real gigabyte** and it is not swept for `-ttl-hours`, so six
runs need about 6 GiB free. Point `-data` at a scratch directory for this and
delete it afterward rather than benchmarking into a live store.

### The measurement

Save this as `benchmode.sh`. It takes the base URL and a two-hex-character tag
that must be different for every run this server has ever seen.

```bash
#!/bin/sh
# Usage: benchmode.sh https://<node>.<tailnet>.ts.net <tag>
set -eu
BASE=$1
TAG=$2

head -c 8388608 /dev/urandom > /tmp/chunk8m

# The tag prefixes all 128 ids, which is what keeps this run's chunks distinct
# from every other run's. See the note below on why that matters.
ids=$(i=1; while [ $i -le 128 ]; do printf '%s%062x\n' "$TAG" "$i"; i=$((i+1)); done)
json=$(printf '%s' "$ids" | sed 's/.*/"&"/' | paste -sd, -)

# PUT /api/chunk/{cid} requires the transfer it belongs to as a query
# parameter and rejects the request with 400 before reading the body without
# it, so the transfer has to exist first. The server's reply carries the
# subset it does not already hold, and that list is the guard: anything short
# of 128 means these ids are already stored and the run would time a stat
# rather than a write.
resp=$(curl -sS --fail-with-body -X POST -H 'Content-Type: application/json' \
  -d "{\"cids\":[$json],\"to\":[]}" "$BASE/api/transfer")
tid=$(printf '%s' "$resp" | sed -n 's/.*"id":"\([0-9a-f]\{32\}\)".*/\1/p')
missing=$(printf '%s' "$resp" | sed 's/.*"missing"://' | grep -o '[0-9a-f]\{64\}' | wc -l)
[ -n "$tid" ] || { echo "no transfer id in: $resp" >&2; exit 1; }
[ "$missing" -eq 128 ] || { echo "server already holds $((128 - missing)) of these ids; use a fresh tag" >&2; exit 1; }

start=$(date +%s%3N)
for id in $ids; do
  curl -sS -o /dev/null -w '%{http_code} %{size_upload}\n' \
    -X PUT --data-binary @/tmp/chunk8m "$BASE/api/chunk/$id?transfer=$tid"
done | sort | uniq -c
end=$(date +%s%3N)

echo "$BASE tag=$TAG: 1 GiB in $((end - start)) ms = $((1024 * 1000 / (end - start))) MB/s"
```

Run each mode three times with a fresh tag every time, and report the median:

```bash
./benchmode.sh https://<host-mode-base> a1     # server started -tailscale-mode=host,     then a2, a3
./benchmode.sh https://<embedded-mode-base> b1 # server started -tailscale-mode=embedded, then b2, b3
```

The result line repeats the base URL and the tag so the transcript of a run
carries the two facts that separate it from the other mode's runs, rather than
leaving them to the operator's memory. For the mode itself, keep the server's
own startup line with each number: it logs `host mode, allowing tailnet users
[...]` or `embedded mode, allowing tailnet users [...]` before it serves
anything. `/api/whoami` cannot stand in for that, because it reports the calling
client's node and user, not the server's mode.

**Read the count line before the throughput line.** A healthy run prints exactly
`128 204 8388608` and nothing else. Any other status code appearing there means
that many requests were rejected and the elapsed time is meaningless. To see
what the server objected to, repeat one request without `-o /dev/null`.

`date +%s%3N` is GNU date. On BSD or macOS drop the `%3N` and divide by seconds
instead, accepting the coarser resolution.

| Mode | Wall clock for 1 GiB (median of 3) | MB/s | Spread |
| --- | --- | --- | --- |
| `host` | not yet measured | | |
| `embedded` | not yet measured | | |

### Why the tag has to change between runs

`ChunkStore.Put` is first-write-wins: an id the store already holds makes it
discard the body and skip the write. The bytes still cross the network, so the
run does not look obviously wrong. It just gets faster.

The size of that error is not hypothetical. Running the block above twice over
loopback, once with fresh ids and once reusing them, 1 GiB took a median of
13,166 ms writing and 12,482 ms deduplicating. The 684 ms difference over 128
chunks is 5.3 ms per chunk, which agrees with the 4.87 ms that section 1
measured for an 8 MiB `Put` by a completely different route. On that 77 MB/s
link it was 5.2 percent of wall clock.

**5 percent is the same order as the difference this section exists to
measure.** Reusing the tag between the `host` and the `embedded` run would hand
whichever ran second a bias comparable to the effect, in its favor. The
`missing` check in the script is there to make that impossible to do by
accident, because the prose version of this warning is easy to read past.

### Confirm the link was direct

Check `tailscale status` for the client. A run relayed through DERP measures the
relay, not the mode, and the two modes would then look identical for a reason
that has nothing to do with either.

### What has and has not been verified here

The command block above was executed end to end before publication, byte for
byte as printed, against a token-mode server on loopback. The token went in
through a `curl` config file rather than an edit to the script, since on a
tailnet the identity comes from the network and the block needs no auth flags of
its own. 128 of 128 requests returned 204 having uploaded 8,388,608 bytes each,
the `missing` guard correctly refused a reused tag and exited 1, and the result
line printed with its base URL and tag. So the commands run and the guard works.

What has not happened is the measurement itself. No part of the table above was
taken over a tailnet, and loopback throughput says nothing about either mode.

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
