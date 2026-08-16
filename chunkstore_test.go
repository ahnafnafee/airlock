package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func cid(n byte) string { return strings.Repeat(string("0123456789abcdef"[n&15]), 64) }

func newChunks(t *testing.T) *ChunkStore {
	t.Helper()
	c, err := NewChunkStore(t.TempDir(), 64, 4096)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestPutAndOpenRoundTrip(t *testing.T) {
	c := newChunks(t)
	if err := c.Put(cid(1), strings.NewReader("hello")); err != nil {
		t.Fatal(err)
	}
	if !c.Has(cid(1)) {
		t.Fatal("Has should report the chunk present")
	}
	f, err := c.Open(cid(1))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	b, _ := io.ReadAll(f)
	if string(b) != "hello" {
		t.Fatalf("read %q", b)
	}
}

func TestPutIsFirstWriteWins(t *testing.T) {
	c := newChunks(t)
	if err := c.Put(cid(1), strings.NewReader("original")); err != nil {
		t.Fatal(err)
	}
	// A second write under the same id must not replace the first. Chunk ids
	// are content-derived, so a differing body is either a bug or an attempt to
	// poison a chunk other transfers share.
	if err := c.Put(cid(1), strings.NewReader("poisoned")); err != nil {
		t.Fatalf("second put should be a silent no-op, got %v", err)
	}
	f, _ := c.Open(cid(1))
	defer f.Close()
	b, _ := io.ReadAll(f)
	if string(b) != "original" {
		t.Fatalf("chunk was overwritten: %q", b)
	}
}

func TestMissingReportsOnlyAbsent(t *testing.T) {
	c := newChunks(t)
	c.Put(cid(1), strings.NewReader("a"))
	c.Put(cid(3), strings.NewReader("b"))
	got := c.Missing([]string{cid(1), cid(2), cid(3), cid(4)})
	if len(got) != 2 || got[0] != cid(2) || got[1] != cid(4) {
		t.Fatalf("Missing = %v", got)
	}
}

func TestMalformedCidNeverTouchesFilesystem(t *testing.T) {
	c := newChunks(t)
	bad := []string{
		"../../etc/passwd", "..", "", "a/b",
		strings.Repeat("a", 63), strings.Repeat("a", 65),
		// cid(10) is 'a' repeated: a letter-based id, so upper-casing it actually
		// produces characters outside [0-9a-f]. Upper-casing a digit-based id
		// would be a no-op and wrongly still match the pattern.
		strings.ToUpper(cid(10)),
	}
	for _, id := range bad {
		if c.Has(id) {
			t.Fatalf("Has(%q) returned true", id)
		}
		if err := c.Put(id, strings.NewReader("x")); !errors.Is(err, ErrBadID) {
			t.Fatalf("Put(%q) = %v, want ErrBadID", id, err)
		}
		if _, err := c.Open(id); !errors.Is(err, ErrBadID) {
			t.Fatalf("Open(%q) = %v, want ErrBadID", id, err)
		}
	}
}

func TestPutRejectsOversizeChunk(t *testing.T) {
	c := newChunks(t) // maxChunkBytes 64
	err := c.Put(cid(1), strings.NewReader(strings.Repeat("x", 200)))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if c.Has(cid(1)) {
		t.Fatal("a rejected chunk must leave nothing behind")
	}
	if c.Used() != 0 {
		t.Fatalf("Used = %d, want 0", c.Used())
	}
}

func TestPutRejectsWhenTotalExhausted(t *testing.T) {
	c := newChunks(t) // maxChunk 64, maxTotal 4096
	body := strings.Repeat("x", 64)
	var last error
	for i := 0; i < 200; i++ {
		// Distinct ids, since first-write-wins would make repeats free.
		id := strings.Repeat("0", 60) + string("0123456789abcdef"[i&15]) + string("0123456789abcdef"[(i>>4)&15]) + "ff"
		if last = c.Put(id, strings.NewReader(body)); last != nil {
			break
		}
	}
	if !errors.Is(last, ErrQuota) {
		t.Fatalf("err = %v, want ErrQuota once the budget is spent", last)
	}
	if c.Used() > 4096 {
		t.Fatalf("Used = %d, exceeded maxTotal", c.Used())
	}
}

func TestConcurrentPutsRespectTotal(t *testing.T) {
	dir := t.TempDir()
	// Budget for exactly two chunks. Without a lock around the check and the
	// write, concurrent putters both observe zero usage and both land.
	c, err := NewChunkStore(dir, 64, 128)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Repeat("x", 64)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := strings.Repeat("0", 62) + string("0123456789abcdef"[i&15]) + "f"
			c.Put(id, strings.NewReader(body))
		}(i)
	}
	wg.Wait()
	if c.Used() > 128 {
		t.Fatalf("Used = %d, want at most 128", c.Used())
	}
}

func TestUsedSurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	c, _ := NewChunkStore(dir, 64, 4096)
	c.Put(cid(1), strings.NewReader(strings.Repeat("x", 40)))

	reopened, err := NewChunkStore(dir, 64, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Used() != 40 {
		t.Fatalf("Used after reopen = %d, want 40", reopened.Used())
	}
}

func TestSweepDeletesUnreferencedOnly(t *testing.T) {
	c := newChunks(t)
	c.Put(cid(1), strings.NewReader("keep"))
	c.Put(cid(2), strings.NewReader("drop"))

	n, err := c.Sweep(map[string]bool{cid(1): true})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("swept %d, want 1", n)
	}
	if !c.Has(cid(1)) {
		t.Fatal("referenced chunk was swept")
	}
	if c.Has(cid(2)) {
		t.Fatal("unreferenced chunk survived")
	}
	if c.Used() != 4 {
		t.Fatalf("Used = %d, want 4 after sweeping one 4-byte chunk", c.Used())
	}
}

func TestWriteStreamCleansUpOnOversize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "target")
	err := writeStream(path, strings.NewReader("abcdefghij"), 4)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("target should not exist")
	}
	if _, err := os.Stat(path + ".tmp"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("temp file should have been removed")
	}
}

func TestAnOpenChunkDoesNotBlockItsOwnRemoval(t *testing.T) {
	c := newChunks(t)
	if err := c.Put(cid(1), strings.NewReader("first")); err != nil {
		t.Fatal(err)
	}
	f, err := c.Open(cid(1))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	// Sweeping while a reader holds the file must still remove it. On Windows a
	// handle without FILE_SHARE_DELETE blocks this, and the sweep silently stops
	// reclaiming space.
	if _, err := c.Sweep(map[string]bool{}); err != nil {
		t.Fatalf("sweep with an open reader: %v", err)
	}
	if c.Has(cid(1)) {
		t.Fatal("an open reader prevented the sweep from removing the chunk")
	}
}

// The shared open replaces os.Open, so it has to keep reporting a missing file
// as ErrNotFound. Every 404 on the download path depends on that mapping.
func TestOpenReportsAMissingChunkAsNotFound(t *testing.T) {
	c := newChunks(t)
	if _, err := c.Open(cid(3)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}
