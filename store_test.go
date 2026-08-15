package main

import (
	"errors"
	"io"
	"math"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(t.TempDir(), 16, 1<<20, 4<<20, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestCreateAssignsHexID(t *testing.T) {
	s := newTestStore(t)
	m, err := s.Create("pixel", 3)
	if err != nil {
		t.Fatal(err)
	}
	if !idRe.MatchString(m.ID) {
		t.Fatalf("id %q is not 32 lowercase hex", m.ID)
	}
	if m.ChunkCount != 3 || m.Sender != "pixel" {
		t.Fatalf("unexpected meta %+v", m)
	}
}

func TestPutChunksOutOfOrderAndComplete(t *testing.T) {
	s := newTestStore(t)
	m, _ := s.Create("pixel", 3)

	for _, n := range []int{2, 0, 1} {
		if err := s.PutChunk(m.ID, n, strings.NewReader("chunk")); err != nil {
			t.Fatalf("chunk %d: %v", n, err)
		}
	}
	info, err := s.Get(m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Have; len(got) != 3 || got[0] != 0 || got[1] != 1 || got[2] != 2 {
		t.Fatalf("Have = %v, want sorted [0 1 2]", got)
	}
	if info.Complete {
		t.Fatal("blob is complete without a manifest")
	}
	if err := s.PutMeta(m.ID, strings.NewReader("sealed")); err != nil {
		t.Fatal(err)
	}
	info, _ = s.Get(m.ID)
	if !info.Complete {
		t.Fatal("blob should be complete once manifest and all chunks exist")
	}
	if info.EncMeta == "" {
		t.Fatal("EncMeta should be the base64 manifest")
	}
}

func TestPutChunkIsIdempotent(t *testing.T) {
	s := newTestStore(t)
	m, _ := s.Create("pixel", 1)
	for i := 0; i < 3; i++ {
		if err := s.PutChunk(m.ID, 0, strings.NewReader("same")); err != nil {
			t.Fatal(err)
		}
	}
	info, _ := s.Get(m.ID)
	if len(info.Have) != 1 {
		t.Fatalf("Have = %v, want one entry", info.Have)
	}
}

func TestPutChunkRejectsIndexOutOfRange(t *testing.T) {
	s := newTestStore(t)
	m, _ := s.Create("pixel", 2)
	for _, n := range []int{-1, 2, 99} {
		if err := s.PutChunk(m.ID, n, strings.NewReader("x")); !errors.Is(err, ErrBadIndex) {
			t.Fatalf("index %d: err = %v, want ErrBadIndex", n, err)
		}
	}
}

func TestMalformedIDNeverTouchesFilesystem(t *testing.T) {
	s := newTestStore(t)
	bad := []string{
		"../../etc/passwd",
		"..",
		"",
		"ABCDEF01234567890123456789012345", // uppercase
		strings.Repeat("a", 31),
		strings.Repeat("a", 33),
		"a/b",
	}
	for _, id := range bad {
		if _, err := s.Get(id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Get(%q) = %v, want ErrNotFound", id, err)
		}
		if err := s.PutChunk(id, 0, strings.NewReader("x")); !errors.Is(err, ErrNotFound) {
			t.Fatalf("PutChunk(%q) = %v, want ErrNotFound", id, err)
		}
	}
}

func TestCreateRejectsOversizeBlob(t *testing.T) {
	s := newTestStore(t) // chunkSize 16, maxBlob 1 MiB
	if _, err := s.Create("pixel", 1<<20); !errors.Is(err, ErrQuota) {
		t.Fatalf("err = %v, want ErrQuota", err)
	}
}

func TestCreateRejectsWhenTotalQuotaExhausted(t *testing.T) {
	// 4 KiB total budget, 1 KiB reserved per transfer. Writing real chunk bytes
	// makes the budget deplete predictably, where asserting "the Nth create
	// fails" would depend on the serialized size of meta.json.
	s, err := NewStore(t.TempDir(), 1<<10, 1<<20, 4<<10, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	payload := strings.Repeat("x", 1<<10)

	first, err := s.Create("pixel", 1)
	if err != nil {
		t.Fatalf("first create should fit: %v", err)
	}
	if err := s.PutChunk(first.ID, 0, strings.NewReader(payload)); err != nil {
		t.Fatal(err)
	}

	var last error
	for i := 0; i < 10; i++ {
		m, e := s.Create("pixel", 1)
		if e != nil {
			last = e
			break
		}
		if err := s.PutChunk(m.ID, 0, strings.NewReader(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if !errors.Is(last, ErrQuota) {
		t.Fatalf("err = %v, want ErrQuota once the budget is spent", last)
	}
}

func TestCreateRejectsOverflowingChunkCount(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create("pixel", math.MaxInt/2); !errors.Is(err, ErrQuota) {
		t.Fatalf("err = %v, want ErrQuota", err)
	}
}

func TestNewStoreRejectsNonPositiveChunkSize(t *testing.T) {
	if _, err := NewStore(t.TempDir(), 0, 1<<20, 4<<20, time.Hour); err == nil {
		t.Fatal("want a non-nil error for a non-positive chunk size")
	}
}

func TestConcurrentCreatesRespectTotalQuota(t *testing.T) {
	const chunkSize = 1 << 10 // 1 KiB
	// The budget fits exactly one reservation. Create only ever writes
	// meta.json on disk (chunk bytes land later, via a separate PutChunk),
	// so a looser budget would let many more than "a handful" of creates
	// through on real usage alone, long before declared bytes ever landed,
	// which would make the assertion below depend on meta.json's serialized
	// size rather than on the lock. A budget of exactly one reservation
	// does not have that problem: once the first create's meta.json exists,
	// any positive usage at all is enough to push every other concurrent
	// caller over maxTotal, regardless of how small that file is.
	const maxTotal = chunkSize
	s, err := NewStore(t.TempDir(), chunkSize, 1<<20, maxTotal, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	declared := int64(1) * chunkSize // the same arithmetic Create uses

	var wg sync.WaitGroup
	var mu sync.Mutex
	successes := 0
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Create("pixel", 1); err == nil {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if successes < 1 {
		t.Fatal("want at least one create to succeed against a budget that fits exactly one")
	}
	if int64(successes)*declared > maxTotal {
		t.Fatalf("successes = %d: %d bytes reserved exceeds the %d budget", successes, int64(successes)*declared, int64(maxTotal))
	}
}

func TestOpenChunk(t *testing.T) {
	s := newTestStore(t)
	m, err := s.Create("pixel", 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PutChunk(m.ID, 0, strings.NewReader("hello")); err != nil {
		t.Fatal(err)
	}

	f, err := s.OpenChunk(m.ID, 0)
	if err != nil {
		t.Fatalf("uploaded chunk: %v", err)
	}
	got, err := io.ReadAll(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello" {
		t.Fatalf("content = %q, want %q", got, "hello")
	}

	if _, err := s.OpenChunk(m.ID, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("never-uploaded chunk: err = %v, want ErrNotFound", err)
	}
	if _, err := s.OpenChunk(m.ID, 2); !errors.Is(err, ErrBadIndex) {
		t.Fatalf("out of range index: err = %v, want ErrBadIndex", err)
	}
	if _, err := s.OpenChunk("not-a-valid-id", 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("malformed id: err = %v, want ErrNotFound", err)
	}
}

func TestPutChunkRejectsOversizeBody(t *testing.T) {
	s := newTestStore(t) // chunkSize 16, so the per-write limit is 16+64 = 80
	m, err := s.Create("pixel", 1)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Repeat("x", 200)
	if err := s.PutChunk(m.ID, 0, strings.NewReader(body)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	info, err := s.Get(m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Have) != 0 {
		t.Fatalf("Have = %v, want no chunk to survive an oversize write", info.Have)
	}
}

func TestPutMetaRejectsOversizeManifest(t *testing.T) {
	s := newTestStore(t)
	m, err := s.Create("pixel", 1)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Repeat("x", maxManifestBytes+1)
	if err := s.PutMeta(m.ID, strings.NewReader(body)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	// All chunks present, so the manifest is the only possible reason
	// Complete could be true; confirm the rejected write did not leave one.
	if err := s.PutChunk(m.ID, 0, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	info, err := s.Get(m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if info.Complete {
		t.Fatal("blob should not be complete when the manifest was rejected as oversize")
	}
}
