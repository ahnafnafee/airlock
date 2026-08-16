package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// benchCid builds a valid chunk id whose first two characters vary with i, so a
// benchmark's chunks land across the store's shards the way real ones do rather
// than piling into one directory whose entry count is its own bottleneck.
func benchCid(i int) string {
	return fmt.Sprintf("%02x%062x", i%256, i)
}

// BenchmarkChunkStorePut measures the server side of an upload in isolation, so
// a slow end-to-end number can be attributed to the network rather than guessed
// at.
func BenchmarkChunkStorePut(b *testing.B) {
	for _, size := range []int{64 << 10, 1 << 20, 8 << 20} {
		b.Run(fmt.Sprintf("%dKiB", size>>10), func(b *testing.B) {
			dir := b.TempDir()
			store, err := NewChunkStore(dir, int64(size)+1024, 1<<40)
			if err != nil {
				b.Fatal(err)
			}
			body := make([]byte, size)
			if _, err := rand.Read(body); err != nil {
				b.Fatal(err)
			}

			b.SetBytes(int64(size))
			// Every id is distinct, so no iteration reaches Put's
			// first-write-wins short circuit and times a stat instead of the
			// write this is here to measure.
			for i := 0; b.Loop(); i++ {
				if err := store.Put(benchCid(i), bytes.NewReader(body)); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkSweep measures mark-and-sweep against a realistic chunk count, which
// is the one operation whose cost grows with the store rather than the transfer.
func BenchmarkSweep(b *testing.B) {
	dir := b.TempDir()
	store, err := NewChunkStore(dir, 4096, 1<<40)
	if err != nil {
		b.Fatal(err)
	}
	transfers, err := NewTransfers(dir, store, time.Hour, 100000, 4096)
	if err != nil {
		b.Fatal(err)
	}

	cids := make([]string, 5000)
	for i := range cids {
		cids[i] = benchCid(i)
		if err := store.Put(cids[i], strings.NewReader("x")); err != nil {
			b.Fatal(err)
		}
	}
	if _, _, err := transfers.Create("bench", nil, cids); err != nil {
		b.Fatal(err)
	}

	for b.Loop() {
		referenced, err := transfers.Referenced()
		if err != nil {
			b.Fatal(err)
		}
		swept, err := store.Sweep(referenced)
		if err != nil {
			b.Fatal(err)
		}
		// The transfer references every chunk, so a sweep that removed one
		// would be emptying the store out from under the measurement and
		// getting cheaper each round. Asserting it keeps the number honest and
		// gives this benchmark the power to catch a mark that goes wrong.
		if swept != 0 {
			b.Fatalf("swept %d referenced chunks", swept)
		}
	}
}

// BenchmarkPutChunkAfterAnnouncement guards the hot upload path after the
// transfer's one notification has gone out. Looking the transfer up again for
// every chunk would stat every CID each time and turn an upload into quadratic
// filesystem work.
func BenchmarkPutChunkAfterAnnouncement(b *testing.B) {
	dir := b.TempDir()
	store, err := NewChunkStore(dir, 4096, 1<<40)
	if err != nil {
		b.Fatal(err)
	}
	transfers, err := NewTransfers(dir, store, time.Hour, 6000, 1<<20)
	if err != nil {
		b.Fatal(err)
	}

	cids := make([]string, 5000)
	for i := range cids {
		cids[i] = benchCid(i)
	}
	rec, _, err := transfers.Create("bench", nil, cids)
	if err != nil {
		b.Fatal(err)
	}
	if !transfers.markAnnounced(rec.ID) {
		b.Fatal("first announcement was already claimed")
	}
	server := &Server{cfg: ServerConfig{Chunks: store, Transfers: transfers}}

	b.ResetTimer()
	for b.Loop() {
		req := httptest.NewRequest(
			http.MethodPut, "/?transfer="+rec.ID, strings.NewReader("x"))
		req.SetPathValue("cid", cids[0])
		req = req.WithContext(context.WithValue(
			req.Context(), identKey{}, Identity{Node: "bench"}))
		w := httptest.NewRecorder()
		server.putChunk(w, req)
		if w.Code != http.StatusNoContent {
			b.Fatalf("put chunk: status %d: %s", w.Code, w.Body.String())
		}
	}
}
