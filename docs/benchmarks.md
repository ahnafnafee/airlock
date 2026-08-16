# Benchmarks

Several design decisions were left open until they could be measured: whether
the `host` Tailscale mode really beats `embedded`, whether the sealing toggle
buys anything at all, how many connections the direct path should open, how many
workers should seal, and whether the chunker's rolling hash is worth replacing.
This file records what was measured, on what, and what the numbers say about each
decision, including where they disagree with the reasoning the design was built
on.

The measurements split by what they need. Everything that runs on one machine has
been taken. Everything that needs a real tailnet and a second device has not, and
each of those sections is marked **not yet measured** and carries the exact
commands to take it.

## Machine

| | |
| --- | --- |
| CPU | Intel Core i9-14900K, 8 performance cores plus 16 efficiency cores, 32 logical |
| Memory | 64 GB |
| OS | Windows 11 Pro, build 10.0.22631 |
| Disk | WD SN550 1 TB NVMe, NTFS, `C:` volume (Go's `b.TempDir()` lands here) |
| Go | 1.26.5, windows/amd64 |
| Node | 22.17.1 |
| Defender real-time protection | off |
| Date | 2026-08-15 for sections 1 and 2, 2026-08-16 for sections 5 to 8 |

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

## 5. The direct path's link count, not yet measured

Needs a real tailnet and two devices, because the question is what a LAN does and
loopback cannot answer it.

`web/peer.js` spreads a transfer over `LINK_COUNT` peer connections, each
carrying `CHANNELS_PER_LINK` data channels. The plan for this measurement called
that one number, `CHANNEL_COUNT`. The code has two, and they are two because the
module's own comment claims they do different jobs: connections are separate SCTP
associations and their bandwidth adds up, while channels inside one connection
share a congestion window and exist only so a fragment waiting on a retransmit
does not block everything queued behind it.

Both of those are arguments. Neither has been measured. The constants have
deliberately not been changed, because moving a constant on the strength of an
argument is the thing this file exists to prevent.

### The measurement

Instrument the send loop, because the session's wall clock also contains the
handshake, the offer round trip and the receiver's dedup pass, and none of those
scale with link count. In `negotiate` in `web/peer.js`, wrap the one line that
fans out to the links:

```js
        const t0 = performance.now();
        await Promise.all(links.map((link, l) =>
          sendChunks(link, indexesFor(wanted, links.length, l), readChunk)));
        const ms = performance.now() - t0;
        console.log(`links=${links.length} chan=${links[0].channels.length} ` +
          `sent ${wanted.length} of ${manifest.cids.length} chunks, ` +
          `${manifest.size} B in ${ms.toFixed(0)} ms = ` +
          `${((manifest.size / 1048576) / (ms / 1000)).toFixed(1)} MB/s`);
```

That block is temporary and is not committed. It prints on the sending device's
console.

**Read the two counts before the throughput.** The MB/s figure divides the whole
file by the elapsed time, so it is only true when `wanted.length` equals
`manifest.cids.length`. A receiver that already holds part of the file answers
`NEED` with a shorter index list, fewer bytes cross, and the line then reports a
throughput the link never reached. It gets faster the more of the file the
receiver already has, which is the failure mode that looks like a finding.

The web assets are compiled into the binary by `//go:embed`, so every constant
change needs a rebuild and a reinstall on **both** devices, not just the sender:

```bash
# On EACH device, once per row of the table.
# Edit LINK_COUNT in web/peer.js, then:
go build -o airlock . && ./airlock      # airlock.exe on Windows
```

**Rebuilding only the sender loses three of the six rows, silently.** The
receiver's copy of the same constants gates the handshake. In `web/session.js`,
`decode` drops an offer outright when its list of descriptions is longer than the
receiving device's own `LINK_COUNT`, and `accept` further clamps what survives to
`sdps.slice(0, LINK_COUNT)` connections and `Math.min(msg.channels,
CHANNELS_PER_LINK * 2)` channels each. Against a stock receiver still at 4, the
6, 8 and 12 rows produce a discarded offer, no answer, and a sender that sits
until its handshake deadline expires. The symptom is an empty row rather than a
slow one, and taking it as data would read the knee at 4 for a reason that has
nothing to do with throughput. If a row hangs at the handshake instead of
transferring, check the receiver's build before believing anything about the
link.

The `CHANNELS_PER_LINK` table below is not exposed to the `decode` rejection, and
the `accept` clamp leaves values up to 4 intact because the answerer takes
`min(msg.channels, CHANNELS_PER_LINK * 2)`. Rebuild both devices for it anyway.
One rule for both tables is easier to follow than one rule with an exception, and
a value above 4 would hit the clamp.

Prepare the same 2 GB file for the other device once per row, let the direct
transfer run, and read the line off the sender's console. Take three runs per row
and report the median. Between rows, clear the receiving device's staged and
stored chunks, which is what keeps the two counts equal.

| `LINK_COUNT` | `CHANNELS_PER_LINK` | MB/s (median of 3) | Spread |
| --- | --- | --- | --- |
| 1 | 2 | not yet measured | |
| 2 | 2 | not yet measured | |
| 4 | 2 | not yet measured | |
| 6 | 2 | not yet measured | |
| 8 | 2 | not yet measured | |
| 12 | 2 | not yet measured | |

Then hold `LINK_COUNT` at whatever the first sweep chose and vary the second
number, because the two claims are independent and one table cannot separate
them:

| `LINK_COUNT` | `CHANNELS_PER_LINK` | MB/s (median of 3) | Spread |
| --- | --- | --- | --- |
| chosen | 1 | not yet measured | |
| chosen | 2 | not yet measured | |
| chosen | 4 | not yet measured | |

Confirm the link was direct before believing any of it. `tailscale status` on the
sending device must not show the peer as relayed. A run through DERP measures the
relay, and every row of both tables would then agree for a reason that has
nothing to do with either constant.

### What the result has to decide

Expect a knee: throughput climbing to some count and flattening after it. Set the
constant to the knee and not past it, because every extra link is another ICE
negotiation, another DTLS transport, another send buffer at the `HIGH_WATER`
ceiling and another reassembly map.

**If one connection already reaches what four reach, set `LINK_COUNT` to 1 and
take the fan-out out.** That result would mean the multiplexing earns nothing on
this hardware, and shipping complexity that earns nothing is worse than not
having built it. The same test applies to `CHANNELS_PER_LINK`: if 1 matches 2,
set it to 1, and `sendChunks` loses its round robin along with it.

Two things would make the sweep flat for reasons that are not the constants, and
both are worth checking before concluding anything. If the link itself saturates
at one connection, every row after the first is flat and the answer is 1 for this
link rather than 1 in general, so record the link's speed alongside the table. If
`usrsctp` saturates a core first, the sender's CPU is pinned and the rows are flat
for the reason the module's `ponytail:` note already names, which is a different
finding and calls for a different fix.

### Ordered against unordered

Same setup, one extra pair of rows. `openChannels` creates channels with
`{ ordered: false }`. Flip it to `{ ordered: true }` on the sending device,
rebuild, and take three more runs at the chosen `LINK_COUNT`. Only the offering
side's build matters, because only the offerer creates the channels and the
answering side inherits their ordering.

| `ordered` | MB/s (median of 3) | Spread |
| --- | --- | --- |
| `false` | not yet measured | |
| `true` | not yet measured | |

If the difference is inside the run to run spread, record that. Unordered stays
either way, because it is not there for throughput on a clean link: it is there
so one retransmit does not stall the fragments queued behind it, and a LAN with
no loss is exactly the case where that costs nothing and shows nothing.

## 6. Preparing a file, measured on Node

`prepare()` in `web/upload.js` reads the file, cuts it, hashes and seals each
chunk in a worker pool, and stages the sealed bytes. On the direct path it runs
before the peer is reachable, so its whole wall clock is time the sender waits
through no matter what the network later does. That makes it worth breaking apart
on its own, independently of the link measurement above.

**Caveat first: this is Node 22, not a browser.** Three things differ, and one of
them is not small.

- The crypto is real. Node and the browser reach the same native implementations
  through the same Web Crypto API, and the harness imports the app's own
  unmodified `web/crypto.js` and `web/cdc.js`.
- The pool is real. The harness imports `web/sealpool.js` unmodified and drives
  it through a small facade that gives a `worker_threads` Worker the five members
  the DOM shape needs. All of the pool's scheduling, backpressure and failure
  handling are the shipped ones. What differs is the thread primitive underneath.
- **Staging is a proxy, not the real thing.** Node has no OPFS, so the harness's
  worker writes the sealed bytes with `writeFileSync` where the real seal worker
  calls `writeStaged`, which goes through an OPFS sync access handle. The write is
  a synchronous write of the same bytes from the same thread, which is the shape
  that matters, but the number is NTFS rather than the browser's sandboxed
  filesystem.

The file is read from the OS page cache, since it was written moments before, so
the read row understates a cold read. That bias works against the conclusions
below rather than for them: a cheaper read makes cutting look like a larger share
than it is, and cutting is the thing under examination.

### The harness

Save both files in one directory outside the repo and set `REPO`. `bench36.mjs`:

```js
// Task 36 harness. Measures the local half of a transfer with the repo's own
// modules: read, cut, hash and seal, stage. It cannot measure a network, so it
// makes no claim about one.
//
//   node bench36.mjs gen      <path> <gib>
//   node bench36.mjs read     <path>
//   node bench36.mjs cut      <path>
//   node bench36.mjs pool     <path> <workers> [stageDir]
//   node bench36.mjs poolonly <workers> <chunks> <chunkBytes> [stageDir]
//   node bench36.mjs cutpoint <mib>
//   node bench36.mjs seal1    <chunkBytes> <rounds>
//
// REPO below is the only thing to change to run this elsewhere.

import { openAsBlob, createWriteStream } from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:/GitHub/transfer-local';
const CRYPTO_URL = pathToFileURL(resolve(REPO, 'web/crypto.js')).href;
const CDC_URL = pathToFileURL(resolve(REPO, 'web/cdc.js')).href;
const POOL_URL = pathToFileURL(resolve(REPO, 'web/sealpool.js')).href;
const WORKER_URL = pathToFileURL(resolve(HERE, 'seal-node-worker.mjs'));

// main.go cdcDefaults, verbatim.
const CDC = {
  min: 512 << 10,
  normal: 1 << 20,
  max: 8 << 20,
  maskS: (1 << 22) - 1,
  maskL: (1 << 20) - 1,
};

const PASSPHRASE = 'a benchmark passphrase';
const SALT = Buffer.alloc(16, 7).toString('base64');
const TRANSFER_ID = '0123456789abcdef0123456789abcdef';

const MB = (bytes, ms) => (bytes / 1048576) / (ms / 1000);

let peakRss = 0;
function watchRss() {
  const t = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }, 25);
  t.unref();
}

async function gen(path, gib) {
  const total = Math.round(gib * (1 << 30));
  const block = new Uint8Array(8 << 20);
  const view = new Uint32Array(block.buffer);
  let x = 0x12345678;
  const out = createWriteStream(path);
  let written = 0;
  while (written < total) {
    for (let i = 0; i < view.length; i++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      view[i] = x;
    }
    const n = Math.min(block.length, total - written);
    if (!out.write(Buffer.from(block.buffer, 0, n))) {
      await new Promise((r) => out.once('drain', r));
    }
    written += n;
  }
  await new Promise((r) => out.end(r));
  console.log(JSON.stringify({ op: 'gen', path, bytes: total }));
}

async function streamOf(path) {
  const blob = await openAsBlob(path);
  return { stream: blob.stream(), size: blob.size };
}

async function read(path) {
  const { stream } = await streamOf(path);
  const reader = stream.getReader();
  const t0 = performance.now();
  let bytes = 0;
  let reads = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    bytes += r.value.length;
    reads++;
  }
  const ms = performance.now() - t0;
  console.log(JSON.stringify({
    op: 'read', bytes, ms: +ms.toFixed(1), mbps: +MB(bytes, ms).toFixed(1),
    reads, meanRead: Math.round(bytes / reads),
  }));
}

async function cut(path) {
  const { chunkStream } = await import(CDC_URL);
  const { stream, size } = await streamOf(path);
  const t0 = performance.now();
  let chunks = 0;
  let bytes = 0;
  let min = Infinity;
  let max = 0;
  for await (const chunk of chunkStream(stream, CDC)) {
    chunks++;
    bytes += chunk.length;
    if (chunk.length < min) min = chunk.length;
    if (chunk.length > max) max = chunk.length;
  }
  const ms = performance.now() - t0;
  console.log(JSON.stringify({
    op: 'cut', bytes, ms: +ms.toFixed(1), mbps: +MB(bytes, ms).toFixed(1),
    chunks, meanChunk: Math.round(bytes / chunks), minChunk: min, maxChunk: max,
    ok: bytes === size,
  }));
}

// A DOM-shaped facade over a node worker_threads Worker, so web/sealpool.js runs
// unmodified. The pool's scheduling, backpressure and failure handling are the
// real ones; only the thread primitive underneath differs.
function spawn(stageDir) {
  return () => {
    const w = new NodeWorker(WORKER_URL, {
      workerData: { cryptoUrl: CRYPTO_URL, stageDir: stageDir || null },
    });
    const facade = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: (msg, transfer) => w.postMessage(msg, transfer),
      terminate: () => w.terminate(),
    };
    w.on('message', (data) => facade.onmessage?.({ data }));
    w.on('error', (err) => facade.onerror?.(err));
    return facade;
  };
}

async function pool(path, size, stageDir) {
  watchRss();
  const { chunkStream } = await import(CDC_URL);
  const { sealPool } = await import(POOL_URL);
  const p = sealPool(size, spawn(stageDir));
  await p.init({ passphrase: PASSPHRASE, salt: SALT }, 0x01, TRANSFER_ID);

  const { stream } = await streamOf(path);
  const limit = size + 1;
  const pending = new Set();
  let index = 0;
  let bytes = 0;
  const t0 = performance.now();
  for await (const plain of chunkStream(stream, CDC)) {
    bytes += plain.length;
    const job = p.seal(index++, plain).finally(() => pending.delete(job));
    job.catch(() => {});
    pending.add(job);
    if (pending.size >= limit) await Promise.race(pending);
  }
  await Promise.all(pending);
  const ms = performance.now() - t0;
  p.close();
  console.log(JSON.stringify({
    op: 'pool', size, staged: !!stageDir, bytes, chunks: index,
    ms: +ms.toFixed(1), mbps: +MB(bytes, ms).toFixed(1),
    peakRssMB: +(peakRss / 1048576).toFixed(1),
  }));
}

// Single-thread cost of the two crypto calls at the mean chunk size, so the
// total CPU work can be separated from the wall clock the pool hides it behind.
async function seal1(sizeBytes, rounds) {
  const { deriveMaster, chunkIdentity, sealChunk, MODE_SEALED } = await import(CRYPTO_URL);
  const mk = await deriveMaster(PASSPHRASE, SALT);
  const plain = new Uint8Array(sizeBytes);
  for (let off = 0; off < sizeBytes; off += 65536) {
    crypto.getRandomValues(plain.subarray(off, Math.min(off + 65536, sizeBytes)));
  }
  const time = async (fn) => {
    for (let i = 0; i < 5; i++) await fn();
    const t0 = performance.now();
    for (let i = 0; i < rounds; i++) await fn();
    return (performance.now() - t0) / rounds;
  };
  const idMs = await time(() => chunkIdentity(mk, MODE_SEALED, plain));
  const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
  const sealMs = await time(() => sealChunk(mk, MODE_SEALED, h, cid, plain));
  console.log(JSON.stringify({
    op: 'seal1', sizeBytes, rounds,
    identityMs: +idMs.toFixed(3), sealMs: +sealMs.toFixed(3),
    totalMs: +(idMs + sealMs).toFixed(3),
    mbps: +MB(sizeBytes, idMs + sealMs).toFixed(1),
  }));
}

// The pool with no cutter in front of it. Chunks are synthesized rather than
// read, so the only thing being measured is how far hashing and sealing scale
// with worker count. AES-GCM and SHA-256 have no data-dependent branches, so a
// buffer that is mostly zeros costs what a random one costs; every page is
// touched so none of it is a lazily mapped zero page.
async function poolonly(size, chunks, chunkBytes, stageDir) {
  watchRss();
  const { sealPool } = await import(POOL_URL);
  const p = sealPool(size, spawn(stageDir));
  await p.init({ passphrase: PASSPHRASE, salt: SALT }, 0x01, TRANSFER_ID);

  const make = () => {
    const b = new Uint8Array(chunkBytes);
    for (let i = 0; i < b.length; i += 4096) b[i] = (i >>> 12) & 0xff;
    return b;
  };
  // Warm the allocator and the workers before the clock starts.
  await Promise.all(Array.from({ length: size }, (_, i) => p.seal(i, make())));

  const limit = size + 1;
  const pending = new Set();
  const t0 = performance.now();
  for (let i = 0; i < chunks; i++) {
    const job = p.seal(i, make()).finally(() => pending.delete(job));
    job.catch(() => {});
    pending.add(job);
    if (pending.size >= limit) await Promise.race(pending);
  }
  await Promise.all(pending);
  const ms = performance.now() - t0;
  p.close();
  const bytes = chunks * chunkBytes;
  console.log(JSON.stringify({
    op: 'poolonly', size, staged: !!stageDir, chunks, chunkBytes, bytes,
    ms: +ms.toFixed(1), mbps: +MB(bytes, ms).toFixed(1),
    peakRssMB: +(peakRss / 1048576).toFixed(1),
    uvThreads: process.env.UV_THREADPOOL_SIZE || 'default',
  }));
}

// cutPoint in isolation: no I/O, no window rebuilding, no copies. This is the
// ceiling SeqCDC would be replacing, and the gap between it and the cut op above
// is what the refill concatenation costs.
async function cutpoint(mib) {
  const { cutPoint } = await import(CDC_URL);
  const size = mib * (1 << 20);
  const buf = new Uint8Array(size);
  const view = new Uint32Array(buf.buffer);
  let x = 0x12345678;
  for (let i = 0; i < view.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    view[i] = x;
  }
  const walk = () => {
    let at = 0;
    let chunks = 0;
    while (at < size) {
      const n = cutPoint(buf, at, Math.min(at + CDC.max, size), CDC);
      at += n;
      chunks++;
    }
    return chunks;
  };
  walk();
  const t0 = performance.now();
  const rounds = 8;
  let chunks = 0;
  for (let i = 0; i < rounds; i++) chunks = walk();
  const ms = (performance.now() - t0) / rounds;
  console.log(JSON.stringify({
    op: 'cutpoint', mib, chunks, ms: +ms.toFixed(1),
    mbps: +MB(size, ms).toFixed(1),
  }));
}

const [, , op, ...rest] = process.argv;
if (op === 'gen') await gen(rest[0], Number(rest[1]));
else if (op === 'read') await read(rest[0]);
else if (op === 'cut') await cut(rest[0]);
else if (op === 'pool') await pool(rest[0], Number(rest[1]), rest[2]);
else if (op === 'seal1') await seal1(Number(rest[0]), Number(rest[1]));
else if (op === 'cutpoint') await cutpoint(Number(rest[0]));
else if (op === 'poolonly') {
  await poolonly(Number(rest[0]), Number(rest[1]), Number(rest[2]), rest[3]);
}
else { console.error('unknown op'); process.exit(2); }
```

`seal-node-worker.mjs`:

```js
// Node stand-in for web/seal-worker.js. It runs the repo's own crypto.js
// unmodified and does the same two calls per chunk, then optionally writes the
// sealed bytes out. It cannot import web/seal-worker.js directly because that
// file stages through OPFS, which Node does not have.

import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { cryptoUrl, stageDir } = workerData;
const { deriveMaster, chunkIdentity, sealChunk } = await import(cryptoUrl);

let master = null;
let mode = null;
let transferId = null;

parentPort.on('message', async (msg) => {
  if (msg.type === 'init') {
    // The browser hands a non-extractable CryptoKey across the thread boundary.
    // Deriving here instead keeps the harness independent of whether Node's
    // structured clone carries a CryptoKey, and it happens before the timed
    // region either way.
    master = await deriveMaster(msg.mk.passphrase, msg.mk.salt);
    mode = msg.mode;
    transferId = msg.transferId;
    if (stageDir) mkdirSync(join(stageDir, transferId), { recursive: true });
    parentPort.postMessage({ type: 'ready' });
    return;
  }
  try {
    const { h, cid } = await chunkIdentity(master, mode, msg.plain);
    const sealed = await sealChunk(master, mode, h, cid, msg.plain);
    if (stageDir) {
      // Proxy for OPFS createSyncAccessHandle: a synchronous write of the
      // sealed bytes from the thread that produced them.
      writeFileSync(join(stageDir, transferId, String(msg.index)), sealed);
    }
    parentPort.postMessage({ index: msg.index, h, cid });
  } catch (err) {
    parentPort.postMessage({ index: msg.index, error: String(err?.message || err) });
  }
});
```

Every section below uses one 2 GiB file of pseudorandom bytes:

```bash
node bench36.mjs gen bench2g.bin 2
```

Under `cdcDefaults` that file cuts into **1,146 chunks with a mean of 1,873,895
bytes**, the smallest 529,214 and the largest at the 8 MiB ceiling.

The mean is 1.79 MiB rather than the 1 MiB `normal`, and the masks predict that.
Between `min` and `normal` a cut needs 22 bits to land zero, about one position
in 4.2 million, so the 512 KiB stretch there cuts only about an eighth of the
time. Past `normal` the mask loosens to 20 bits, about one position in 1.05
million, so a cut arrives after roughly another mebibyte. `normal` plus a
mebibyte, less the eighth that cut early and less what the 8 MiB ceiling clips,
is 1.79 MiB. Nothing is wrong here; it is worth writing down only because the
chunk size that everything else scales against is not the one the parameter name
suggests.

### Reading and cutting

```bash
node bench36.mjs read bench2g.bin      # three runs
node bench36.mjs cut  bench2g.bin      # three runs
node bench36.mjs cutpoint 256          # three runs
```

| | Wall clock for 2 GiB (median of 3) | MB/s | Spread |
| --- | --- | --- | --- |
| Read only, through `Blob.stream()` | 2,315 ms | 885 | 2,290 to 2,404 ms |
| Read and cut, through `chunkStream` | 5,457 ms | 375 | 5,418 to 5,466 ms |
| `cutPoint` alone, no I/O, no copies | 1,168 ms | 1,754 | 1,719 to 1,768 MB/s |

The `cutPoint` row is measured over 256 MiB and scaled to 2 GiB; its spread is
quoted as throughput because that is what the op reports, and it includes a
fourth confirming run taken after the harness was tidied.

The read is 32,768 reads of 64 KiB, so 885 MB/s is per-read overhead rather than
the disk, and the disk barely appears at all because the file is in the page
cache.

The gap is the finding. Cutting adds 3,142 ms on top of the read, but the rolling
hash that does the cutting accounts for only 1,168 ms of that. **The other 1,974
ms is copying**, and it is 69 percent larger than the hash it exists to serve.

The mechanism is in `chunkStream`'s refill, and `web/cdc.js` already carries a
`ponytail:` note naming it. Before every cut the window is rebuilt by
concatenating the remainder with the reads that top it back up to `max`, which
copies about 8.4 MB per chunk, and then the chunk itself is copied out with
`buf.slice(0, n)`, which is another 1.87 MB. That is 10.3 MB moved per 1.87 MB of
file delivered, an amplification of about 5.5x. Over 2 GiB it is 11.8 GB of
copying, and 1,974 ms of it works out at 6.0 GB/s, which is what a single
threaded memcpy looks like on this machine. The arithmetic and the measurement
agree closely enough that the residual can be trusted as the copy rather than as
whatever did not fit elsewhere.

### Where the 2 GiB goes

The full run, at the pool size section 7 chooses, with staging on:

```bash
node bench36.mjs pool bench2g.bin 2 stage
```

Median of 3: **5,718 ms, 358 MB/s**, spread 5,703 to 5,734 ms.

| Step | Wall clock | Share | How it was obtained |
| --- | --- | --- | --- |
| Reading the file | 2,315 ms | 40% | measured directly |
| Rolling hash, finding the cuts | 1,168 ms | 20% | measured directly |
| Rebuilding the cut window | 1,974 ms | 35% | read and cut, less the two above |
| Hashing, sealing and staging | 261 ms | 5% | full run, less read and cut |
| Channel time | not measured | | needs section 5 |

The shares are rounded and sum to 100. The two measured rows and the total are
the load-bearing numbers; the other two are a difference each, which is why the
copying figure was checked against its own arithmetic above before being
believed.

The sealing row is the surprise, and it is the one that decides section 7.
Hashing, sealing and staging cost **4,565 ms of CPU** for this file on one
thread, which is more than the read and the cut together. Almost none of it
reaches the wall clock, because it happens on worker threads while the main
thread is still reading and cutting, and the main thread is slower. What survives
is the tail: the last chunk cannot be sealed until it has been cut.

So the shape of `prepare()` on this machine is a main thread pinned at 375 MB/s
by reading and cutting, and a worker pool with most of its capacity idle. Nearly
four fifths of the main thread's own time is I/O and memcpy rather than the
rolling hash everyone assumes is the expensive part.

## 7. Seal pool size, measured on Node

Two tables, because one of them alone would give the wrong answer.

### The pool on its own

Synthetic chunks at the mean size, no cutter in front, so this is how far hashing
and sealing actually scale.

```bash
node bench36.mjs poolonly <workers> 1146 1873895        # two runs each
```

| Workers | Wall clock for 2 GiB | MB/s | Scaling | Peak RSS |
| --- | --- | --- | --- | --- |
| 1 | 2,522 ms | 812 | 1.00x | 105 MB |
| 2 | 1,385 ms | 1,479 | 1.82x | 147 MB |
| 4 | 854 ms | 2,398 | 2.95x | 229 MB |
| 8 | 653 ms | 3,137 | 3.86x | 395 MB |
| 16 | 656 ms | 3,121 | 3.84x | 761 MB |

Sealing scales, sublinearly, and stops at 8. Going to 16 buys nothing measurable
and doubles peak memory, which is what `sealPool`'s `MAX_WORKERS = 8` already
assumes. Two checks say that plateau is the crypto and not the harness: raising
`UV_THREADPOOL_SIZE` to 16 changes the 8-worker row by less than its own spread
(653, 656 and 665 ms), and the loop that synthesizes chunks runs at 10.0 GB/s on
its own, three times the plateau it would have to explain.

The single-worker row is also a check on section 2, by a different route. 812
MB/s here against 755 MB/s there for a 1 MiB chunk, the difference being the
larger chunk amortizing the per-call overhead.

### The pool behind the real cutter

The same sweep with `prepare()`'s actual input: the 2 GiB file, cut by
`chunkStream` on the main thread, staged by the workers.

```bash
node bench36.mjs pool bench2g.bin <workers> stage        # three runs each
```

| Workers | Wall clock for 2 GiB (median of 3) | MB/s | Peak RSS | Spread |
| --- | --- | --- | --- | --- |
| 1 | 5,923 ms | 346 | 173 MB | 5,828 to 6,060 ms |
| 2 | **5,718 ms** | **358** | 210 MB | 5,703 to 5,734 ms |
| 4 | 6,496 ms | 315 | 260 MB | 5,857 to 6,840 ms |
| 8 | 6,553 ms | 313 | 308 MB | 6,324 to 6,725 ms |

**The knee is at 2, and past it more workers make preparation slower.** Every
sample at 8 is slower than every sample at 1 or 2, so the effect is outside the
run to run spread even though it is only 15 percent. Peak memory meanwhile grows
by about 20 MB per worker with nothing to show for it.

The two tables together explain each other. A single worker seals and stages at
449 MB/s including the write, and the cutter can only feed it 375 MB/s, so one
worker already has headroom and a second only covers the tail and the jitter.
Everything past that is contending with the main thread for cores and for memory
bandwidth, and the main thread is the one holding the whole pipeline up.

The write is worth naming separately, since it is invisible in the table above.
At one worker, staging costs 2,043 ms per 2 GiB, just over 1,000 MB/s: sealing
alone is 2,522 ms and sealing plus staging is 4,565 ms (spread 4,475 to 4,579).
At eight workers the writes overlap and the same 2 GiB costs 366 ms, which is
5.6 GB/s and is the NTFS write-back cache rather than the disk. None of it
reaches `prepare()`'s wall clock, because the workers have the idle time to
absorb it.

### What was deliberately not changed

`poolSize()` returns `min(8, hardwareConcurrency)`, which is 8 on this machine.
The measurement says 2. **The constant was left alone anyway**, for two reasons
that are worth stating rather than quietly acting on:

- The knee is at 2 only because the cutter is slow. Section 6 says nearly four
  fifths of the cutter's time is I/O and memcpy, and the copy is already named as
  removable. A pipeline whose main thread got twice as fast would want more
  workers again, and a constant lowered now would have to be raised back.
- These are `worker_threads` in one Node process, not Web Workers in a browser
  tab. The scaling curve should carry over, since it is native crypto on the same
  cores, but the 20 MB per worker will not: a browser Worker's floor cost is its
  own, and a phone's is different again.

The trigger for changing it: measure `prepare()` on a phone, on a file of a few
hundred MB. If the knee is still at 2 there, drop `MAX_WORKERS` to 3, which keeps
one worker of headroom for a faster cutter at well under half the memory. Phones
commonly report 8 for `hardwareConcurrency`, so a phone opens the full pool and
pays for all of it on the device with the least memory to spare.

## 8. SeqCDC, considered and rejected on evidence

[SeqCDC](https://cs.uwaterloo.ca/~alkiswan/papers/SeqCDC_Middleware24.pdf)
replaces the gear-hash rolling hash with a scan for a run of monotonically
increasing bytes. It is faster and it is simpler code, and it lands within 4
percent of FastCDC's dedup ratio. Against that, its sequence length is a subtle
parameter, and getting it wrong collapses the dedup ratio silently rather than
failing, which for this product means transfers that quietly stop deduplicating
with nothing anywhere to notice.

The measurement is what settles it, and section 6 has it. **The rolling hash is
1,168 ms of a 5,718 ms preparation, 20 percent.** That is the whole of what
SeqCDC could touch, so even an infinitely fast cutter would leave 80 percent of
preparation exactly where it is. Put against a transfer rather than a
preparation, on a 50 MB/s tailnet where 2 GiB spends about 41 seconds on the
wire, the rolling hash is under 3 percent of the job.

The plan for this measurement set the bar at "under about a tenth of the total".
Which side of that line the hash falls on depends on what "the total" means, and
the honest answer is that it is over the line against preparation and under it
against a transfer. The decision does not turn on picking one, because the same
table names something better to do first:

**The copying that surrounds the hash costs 1,974 ms, 69 percent more than the
hash itself.** Removing it is the change `web/cdc.js` already proposes in its own
`ponytail:` note, a preallocated window with `copyWithin` after each cut. It
cannot change a single chunk boundary, so it carries none of SeqCDC's risk, and
it is worth more.

**SeqCDC is rejected.** Not because cutting is cheap, but because within cutting
it is the smaller half, and the larger half is both safer and already specified.
Reconsider it only after the copy is gone, when the hash would be roughly a third
of a faster preparation and the trade would be a real one. Any reconsideration
also has to answer the parameter question with a dedup measurement across two
versions of a real file, not with a throughput number.

## The open decisions

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

### How many connections should the direct path open?

**Undecided. The measurement in section 5 has not been taken.** `LINK_COUNT`
stays at 4 and `CHANNELS_PER_LINK` at 2, which is where an argument put them. The
argument is a good one and may well be right. It is not evidence, and the sweep
is cheap once two devices share a tailnet.

### How many workers should seal?

**The knee is at 2 on this machine. `poolSize()` asks for 8.**

The cap itself is vindicated. `sealPool`'s comment predicts that a machine with
four times the cores would hold four times the memory for no more throughput than
memory bandwidth allows, and section 7's first table shows exactly that: 16
workers reach 3,121 MB/s against 8 workers' 3,137 MB/s, at nearly twice the peak
memory.

What the comment does not anticipate is that a real file never asks the pool for
that. The main thread reads and cuts at 375 MB/s and a single worker seals and
stages at 449 MB/s, so the pool is starved from the first chunk to the last, and
six of its eight workers are memory that never becomes throughput. Preparation at
8 workers is 15 percent slower than at 2 and holds 100 MB more.

The constant is unchanged, because the knee is at 2 only for as long as the
cutter is slow, and because a Node thread's memory is not a browser Worker's.
Section 7 records the trigger: measure `prepare()` on a phone, and if the knee is
still at 2, drop `MAX_WORKERS` to 3.

### Is SeqCDC worth adopting?

**No, on the evidence in section 8.** The rolling hash it would replace is 20
percent of preparing a file and under 3 percent of sending one over a tailnet.
The copying that surrounds the hash costs 69 percent more than the hash does, is
already named for removal in `web/cdc.js`, and cannot move a chunk boundary,
where SeqCDC's whole risk is that a badly chosen sequence length moves all of
them and says nothing.

**The reasoning this contradicts is the assumption that cutting is where the CPU
goes when a file is prepared.** It is not. Reading the file is a larger share
than the rolling hash, and so is the memcpy the chunker does around it. Any
future attempt to make preparation faster should start from section 6's table
rather than from the intuition that content-defined chunking is expensive.

**Open question this leaves behind.** Every number in sections 6, 7 and 8 was
taken on Node on a desktop i9-14900K, and the shares are what matter rather than
the absolute rates. A phone changes both halves of the ratio, and not by the same
factor: the cut loop is JavaScript and the sealing is native AES and SHA with
hardware support. If the cut loop slows down more than the crypto does, the case
against SeqCDC gets stronger and the case for a smaller pool gets stronger with
it. If it slows down less, both weaken. Re-run section 6 under a mobile browser
before treating either conclusion as settled off this desk.

---

# Live end-to-end measurements, two devices

Everything above this line was measured in isolation, a phase at a time. This
section is the whole pipeline running: a file picked on one device, sealed,
handed to another device over the peer path, and opened there, with the phases
timed separately so it is clear which one costs what.

## What was measured against

Two genuinely distinct devices against one server, using the fact that token
mode names a device by its remote address. Device A is `127.0.0.1`, device B is
`::1`. Different hosts, and because they are different origins, separate browser
storage, separate identities, separate event streams and a real WebRTC session
between them.

**Read the caveat before the numbers.** Both peers run inside one browser on one
machine, so they share a CPU and the same SCTP stack. This measures the software
path. It is not a LAN measurement, and the connection-count result in particular
cannot be carried over to two machines, because a fan-out across connections is
least able to help when both ends are competing for the same cores.

Chunking parameters are the shipped defaults: 512 KiB minimum, 1 MiB target,
8 MiB maximum. Every transfer below was verified by comparing a SHA-256 of the
assembled file against the sender's, and every one matched.

## The three phases

**Secure**, meaning cut into content-defined chunks, seal each under AES-256-GCM,
and write the sealed chunks to this device's own storage:

| Size | Time | Rate |
| --- | --- | --- |
| 8 MB | 202 ms | 41 MB/s |
| 16 MB | 310 ms | 52 MB/s |
| 32 MB | 410 ms | 78 MB/s |
| 128 MB | 1.5 to 1.8 s | 76 MB/s |

Sealing alone, without the write to storage, is considerably faster and is what
the crypto itself costs:

| Size | Chunks | Rate |
| --- | --- | --- |
| 1 MB | 1 | 29 MB/s |
| 8 MB | 4 | 149 MB/s |
| 32 MB | 20 | 242 MB/s |
| 128 MB | 74 | 305 MB/s |
| 256 MB | 138 | 304 MB/s |

Small files are dominated by starting the worker pool, which is why 1 MB looks
slow and is not. The rate plateaus near 304 MB/s.

**Transfer**, peer to peer, with the server holding no chunk at any point:

| Size | Session setup | Moving | Rate while moving |
| --- | --- | --- | --- |
| 16 MB | 662 ms | 7.0 s | 2.3 MB/s |
| 128 MB | 662 ms | 11.4 s | 11.2 MB/s |

Opening a session costs about two thirds of a second and does not grow with the
file. The 16 MB row is slower per byte than the 128 MB row because the watcher
taking the measurement polled ten times a second during it, and each poll lists a
directory on the same disk the transfer is writing to. That is a lesson about
measuring, not about the product: the instrument was a meaningful share of the
load. The 128 MB row polled once a second and is the trustworthy one.

**Assemble**, meaning decrypt every chunk, verify its tag, and write one file:

| Size | Time | Rate |
| --- | --- | --- |
| 8 MB | 115 ms | 70 MB/s |
| 32 MB | 314 ms | 102 MB/s |
| 128 MB | 1.24 s | 104 MB/s |

## Where the time actually goes

Sealing runs about 27 times faster than the transport moves bytes, and assembly
about 9 times faster. **The encryption is not the bottleneck and is not close to
being it.** A 128 MB transfer spends 1.8 s being secured, 11.4 s in flight and
1.2 s being opened.

So the question is what bounds the transport. A loopback data channel pair was
benchmarked directly, with no Airlock code in the path, using Airlock's own
parameters and then varying them:

| Fragment | Channels per link | Links | Rate |
| --- | --- | --- | --- |
| 16 KiB | 2 | 4 | 18 to 20 MB/s |
| 32 KiB | 2 | 4 | 17 MB/s |
| 64 KiB | 2 | 4 | 19 MB/s |
| 64 KiB | 1 | 4 | 21 MB/s |
| 64 KiB | 4 | 4 | 21 MB/s |
| 64 KiB | 2 | 1 | 23 MB/s |
| 64 KiB | 2 | 8 | 18 MB/s |

Two things fall out of that table.

**The ceiling is the data channel, at roughly 20 MB/s here, and it barely moves.**
Quadrupling the fragment size changes nothing. Neither does the number of
channels. Airlock's 11.2 MB/s is a little over half of that ceiling, and the
remaining gap is its own per-chunk work: reading each sealed chunk from the
sender's storage, reassembling fragments on the other side, and writing each
chunk to the receiver's storage.

**The fan-out does not pay for itself in this configuration.** One link measured
faster than four, and eight measured slowest of all. That is the expected shape
when both ends share a CPU, and it is exactly why this result must not be used to
change `LINK_COUNT`. The question the fan-out exists to answer is whether several
connections beat one *between two machines*, where the ends do not compete, and
that has not been measured. Measure it there before touching the constant.

## Content type

At 32 MB, sealing only:

| Content | Chunks | Distinct chunks | Rate |
| --- | --- | --- | --- |
| Incompressible random | 21 | 21 | 235 MB/s |
| All zeros | 4 | 1 | 258 MB/s |
| Repeating log lines | 4 | 4 | 296 MB/s |
| Repeated 64 KiB blocks | 5 | 5 | 307 MB/s |

Type barely moves the sealing rate, which is expected: AES-GCM does not care what
it is encrypting. What type moves is **how many distinct chunks come out**, and
that is what decides how many bytes ever leave the device. Thirty two megabytes of
zeros reduces to one distinct chunk, so a re-send of it, or a send of anything
else that contains the same run, transfers nothing.

## Delta

A 16 MB file, then the same file with a 256 KiB slice replaced at its midpoint:
**7 of 8 chunks were already held**, so one chunk moved for a change of one and a
half percent of the file. Content-defined chunking re-synchronized immediately
either side of the edit rather than shifting every boundary after it.

## What these numbers do not tell you

- **Nothing here crossed a network.** No LAN, no tailnet, no second machine.
- The connection-count sweep is measured in the one configuration where a
  fan-out is least likely to help. It says nothing about two machines.
- Chrome only. Firefox and Safari data channel throughput is unmeasured, and
  Safari's is the one most likely to differ.
- No mobile device, so nothing about a phone's crypto rate or radio.

## The other transfer mode, and a result worth acting on

The section above measured the direct peer path, which is the product default.
The hold-on-server path had never been measured at all. It is:

| Size | Seal and upload to the server | Fetch, decrypt and assemble |
| --- | --- | --- |
| 8 MB | 42 MB/s | 66 MB/s |
| 32 MB | 53 MB/s | 97 MB/s |
| 128 MB | 43 MB/s | 109 MB/s |

Set beside the direct path, on the same machine, in the same session:

| Path | Rate |
| --- | --- |
| Sealing alone, no transport | 304 MB/s |
| Hold on the server, upload leg, sealing included | 43 to 53 MB/s |
| Hold on the server, download leg, decrypt included | 66 to 109 MB/s |
| Direct, peer to peer | 11.2 MB/s |
| A raw data channel with no Airlock in it | about 20 MB/s |

**The server path is roughly four times faster than the peer path here.** Both
legs of it beat the direct transfer, and the download leg beats it by nearly ten
times. The reason is not Airlock: an HTTP body over TCP is simply a faster way to
move bytes in a browser than SCTP over DTLS in a data channel, and the raw
measurement above puts the data channel ceiling near 20 MB/s before any of this
project's code runs.

That inverts how the two modes are presented. The checkbox reads as a
convenience for going offline, and the direct path reads as the better one
because it keeps bytes off the server. On this hardware the direct path is the
slower choice, and by a wide margin.

**Do not change the default on the strength of this.** The comparison is between
two tabs in one browser, which is the configuration least favourable to the peer
path, since both ends contend for the same cores while the server path has a
whole separate process doing its share. The same table taken between two
machines could look completely different, and that is the measurement that
should decide it. What this does establish is that the direct path is not free,
that its cost is the transport rather than the encryption, and that the
comparison is worth taking properly.

## Closing the gap to the transport ceiling

The table above left the direct path at 11.2 MB/s against a data channel that
raw measurement put near 20 MB/s, and attributed the difference to Airlock's own
per-chunk work rather than to the transport. That was worth acting on, and the
cause turned out to be one line of control flow.

`sendChunks` read a chunk from storage, sent all of its fragments, and only then
read the next one. A chunk is megabytes, so the link sat idle for the length of a
storage read once per chunk, and that idle time was most of the missing
throughput. One read now runs ahead of the send, so the next chunk is being
fetched while the current one is on the wire.

Measured on the same two devices, 128 MB, sealed and delivered peer to peer with
the server holding nothing:

| | Run 1 | Run 2 | Rough mean |
| --- | --- | --- | --- |
| Before | 10.7 MB/s | 11.2 MB/s | 11 MB/s |
| After | 21.4 MB/s | 16.0 MB/s | 19 MB/s |

About 1.7 times faster, which puts the direct path at the raw data channel
ceiling rather than a little over half of it. Run-to-run variance is wide, as the
two "after" figures show, because both peers and the server share one machine, so
treat these as a range rather than a number.

There is no unit test for this. One was written and then deleted: the fake link
in `peer.test.mjs` delivers asynchronously, so its timing rather than the code's
decided the result, and the test passed against both the fixed and the original
version. A test that cannot tell those apart claims coverage it does not have,
which is worse than leaving the change to the measurement above. A test would
need a fake whose sends take observable time.

**The remaining ceiling is not Airlock's.** At roughly 20 MB/s the direct path is
now bounded by what a browser data channel does, which the parameter sweep above
showed is insensitive to fragment size and connection count. Beating it means
either not using a data channel or not being in a browser.
