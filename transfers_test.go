package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func newTransfers(t *testing.T) (*Transfers, *ChunkStore) {
	t.Helper()
	dir := t.TempDir()
	c, err := NewChunkStore(dir, 64, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	tr, err := NewTransfers(dir, c, time.Hour, 100, 4096)
	if err != nil {
		t.Fatal(err)
	}
	return tr, c
}

func TestCreateReturnsEverythingMissing(t *testing.T) {
	tr, c := newTransfers(t)
	c.Put(cid(1), strings.NewReader("present"))

	rec, missing, err := tr.Create("pixel", nil, []string{cid(1), cid(2)})
	if err != nil {
		t.Fatal(err)
	}
	if !tidRe.MatchString(rec.ID) {
		t.Fatalf("id %q is not 32 lowercase hex", rec.ID)
	}
	if len(missing) != 1 || missing[0] != cid(2) {
		t.Fatalf("missing = %v, want only the absent chunk", missing)
	}
	if rec.Sender != "pixel" {
		t.Fatalf("sender = %q", rec.Sender)
	}
}

func TestEmptyTransferCompletesWithItsRecords(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, missing, err := tr.Create("pixel", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 0 {
		t.Fatalf("missing = %v, want none", missing)
	}
	if info, err := tr.Get(rec.ID); err != nil || info.Complete {
		t.Fatalf("before records: complete = %v, err = %v", info != nil && info.Complete, err)
	}
	if err := tr.PutRecord(rec.ID, "meta", strings.NewReader("sealed-meta")); err != nil {
		t.Fatal(err)
	}
	if err := tr.PutRecord(rec.ID, "chunklist", strings.NewReader("sealed-list")); err != nil {
		t.Fatal(err)
	}
	info, err := tr.Get(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Complete || info.ChunkCount != 0 {
		t.Fatalf("complete = %v, chunk count = %d", info.Complete, info.ChunkCount)
	}
}

func TestCompleteRequiresChunksMetaAndList(t *testing.T) {
	tr, c := newTransfers(t)
	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})

	info, _ := tr.Get(rec.ID)
	if info.Complete {
		t.Fatal("complete with nothing uploaded")
	}
	c.Put(cid(1), strings.NewReader("data"))
	if info, _ = tr.Get(rec.ID); info.Complete {
		t.Fatal("complete without records")
	}
	tr.PutRecord(rec.ID, "meta", strings.NewReader("sealed-meta"))
	if info, _ = tr.Get(rec.ID); info.Complete {
		t.Fatal("complete without a chunk list")
	}
	tr.PutRecord(rec.ID, "chunklist", strings.NewReader("sealed-list"))
	if info, _ = tr.Get(rec.ID); !info.Complete {
		t.Fatal("should be complete with chunks, meta and list")
	}
	if info.Meta == "" {
		t.Fatal("Meta should carry the base64 record")
	}
}

func TestPutRecordRejectsUnknownKind(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	if err := tr.PutRecord(rec.ID, "../../etc/passwd", strings.NewReader("x")); !errors.Is(err, ErrBadID) {
		t.Fatalf("err = %v, want ErrBadID", err)
	}
	if err := tr.PutRecord(rec.ID, "cids.json", strings.NewReader("x")); !errors.Is(err, ErrBadID) {
		t.Fatalf("a record kind must never name an internal file, got %v", err)
	}
}

func TestPutRecordRejectsOversize(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	big := strings.NewReader(strings.Repeat("x", 5000)) // cap is 4096
	if err := tr.PutRecord(rec.ID, "meta", big); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}

func TestCreateRejectsTooManyChunks(t *testing.T) {
	tr, _ := newTransfers(t)
	ids := make([]string, 101) // cap is 100
	for i := range ids {
		ids[i] = cid(byte(i))
	}
	if _, _, err := tr.Create("pixel", nil, ids); !errors.Is(err, ErrQuota) {
		t.Fatalf("err = %v, want ErrQuota", err)
	}
}

func TestCreateRejectsMalformedCid(t *testing.T) {
	tr, _ := newTransfers(t)
	if _, _, err := tr.Create("pixel", nil, []string{"../../etc/passwd"}); !errors.Is(err, ErrBadID) {
		t.Fatalf("err = %v, want ErrBadID", err)
	}
}

func TestInboxFiltersByRecipient(t *testing.T) {
	tr, _ := newTransfers(t)
	everyone, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	mine, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	theirs, _, _ := tr.Create("pixel", []string{"laptop"}, []string{cid(1)})

	got, err := tr.Inbox("desktop")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, i := range got {
		seen[i.ID] = true
	}
	if !seen[everyone.ID] {
		t.Fatal("an unaddressed transfer should reach every device")
	}
	if !seen[mine.ID] {
		t.Fatal("a transfer addressed to this node is missing")
	}
	if seen[theirs.ID] {
		t.Fatal("a transfer addressed elsewhere leaked into this inbox")
	}
}

func TestInboxIsNewestFirst(t *testing.T) {
	tr, _ := newTransfers(t)
	older, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	time.Sleep(5 * time.Millisecond)
	newer, _, _ := tr.Create("pixel", nil, []string{cid(1)})

	got, _ := tr.Inbox("desktop")
	if len(got) != 2 || got[0].ID != newer.ID || got[1].ID != older.ID {
		t.Fatalf("order wrong: %v", got)
	}
}

func TestDeleteLeavesATombstone(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	tr.PutRecord(rec.ID, "meta", strings.NewReader("sealed-meta"))

	if err := tr.Delete(rec.ID, "pixel"); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Get(rec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	hist, err := tr.History("pixel")
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) != 1 {
		t.Fatalf("history has %d entries, want 1", len(hist))
	}
	if hist[0].ID != rec.ID || hist[0].Sender != "pixel" {
		t.Fatalf("tombstone = %+v", hist[0])
	}
	// The filename lives inside the sealed metadata, so history stays private.
	if hist[0].Meta == "" {
		t.Fatal("tombstone should retain the sealed metadata")
	}
	if hist[0].EndedAt.IsZero() {
		t.Fatal("tombstone should record when it ended")
	}
	if hist[0].ChunkCount != 1 {
		t.Fatalf("tombstone chunk count = %d, want 1", hist[0].ChunkCount)
	}
}

func TestReferencedCollectsEveryLiveTransfer(t *testing.T) {
	tr, _ := newTransfers(t)
	tr.Create("pixel", nil, []string{cid(1), cid(2)})
	tr.Create("pixel", nil, []string{cid(2), cid(3)})

	ref, err := tr.Referenced()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{cid(1), cid(2), cid(3)} {
		if !ref[want] {
			t.Fatalf("%s missing from the referenced set", want[:8])
		}
	}
	if len(ref) != 3 {
		t.Fatalf("referenced has %d entries, want 3", len(ref))
	}
}

func TestSweepExpiresOnLastWrite(t *testing.T) {
	dir := t.TempDir()
	c, _ := NewChunkStore(dir, 64, 1<<20)
	tr, _ := NewTransfers(dir, c, time.Millisecond, 100, 4096)

	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	time.Sleep(10 * time.Millisecond)

	n, err := tr.Sweep(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("swept %d, want 1", n)
	}
	if _, err := tr.Get(rec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("expired transfer survived")
	}
	if hist, _ := tr.History("pixel"); len(hist) != 1 {
		t.Fatal("expiry should leave a tombstone too")
	}
}

// The TTL is inactivity, not age. Two transfers of the same age, one of them
// written to after it went stale, must not share a fate. Without the second
// transfer this test would pass just as well against expiry keyed on creation.
func TestSweepSparesATransferARecordWriteRefreshed(t *testing.T) {
	dir := t.TempDir()
	c, _ := NewChunkStore(dir, 64, 1<<20)
	tr, _ := NewTransfers(dir, c, 200*time.Millisecond, 100, 4096)

	refreshed, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	stale, _, _ := tr.Create("pixel", nil, []string{cid(2)})
	time.Sleep(250 * time.Millisecond)

	if err := tr.PutRecord(refreshed.ID, "meta", strings.NewReader("sealed-meta")); err != nil {
		t.Fatal(err)
	}
	n, err := tr.Sweep(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("swept %d, want only the untouched transfer", n)
	}
	if _, err := tr.Get(refreshed.ID); err != nil {
		t.Fatalf("a transfer written to inside the TTL was swept: %v", err)
	}
	if _, err := tr.Get(stale.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("the untouched transfer should have expired")
	}
}

// Chunks land outside the transfer directory, so PutChunk refreshes the clock
// to keep a transfer whose upload outlasts the TTL from being swept mid-flight.
func TestChunkUploadKeepsAnUploadingTransferAlive(t *testing.T) {
	dir := t.TempDir()
	c, _ := NewChunkStore(dir, 64, 1<<20)
	tr, _ := NewTransfers(dir, c, 200*time.Millisecond, 100, 4096)

	uploading, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	idle, _, _ := tr.Create("pixel", nil, []string{cid(2)})
	time.Sleep(250 * time.Millisecond)

	if err := tr.PutChunk(uploading.ID, cid(1), strings.NewReader("sealed chunk")); err != nil {
		t.Fatal(err)
	}
	n, err := tr.Sweep(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("swept %d, want only the idle transfer", n)
	}
	if _, err := tr.Get(uploading.ID); err != nil {
		t.Fatalf("a touched transfer was swept mid-upload: %v", err)
	}
	if _, err := tr.Get(idle.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("the idle transfer should have expired")
	}
	if err := tr.PutChunk(strings.Repeat("f", 32), cid(3), strings.NewReader("orphan")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound for an unknown transfer", err)
	}
}

func TestSweepRechecksExpiryAfterWaitingForATransfer(t *testing.T) {
	dir := t.TempDir()
	c, _ := NewChunkStore(dir, 64, 1<<20)
	tr, _ := NewTransfers(dir, c, time.Hour, 100, 4096)
	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})

	transferDir, _ := tr.transferDir(rec.ID)
	stale := time.Now().Add(-2 * time.Hour)
	for _, path := range []string{
		filepath.Join(transferDir, "cids.json"),
		filepath.Join(transferDir, "meta.json"),
		transferDir,
	} {
		if err := os.Chtimes(path, stale, stale); err != nil {
			t.Fatal(err)
		}
	}

	// Stand in for a terminal mutation already in progress. Sweep must observe
	// the stale candidate, queue behind its transfer lock, and then decide again
	// once it owns that lock rather than acting on the old observation.
	release := tr.lockTransfer(rec.ID)
	released := false
	defer func() {
		if !released {
			release()
		}
	}()
	type result struct {
		n   int
		err error
	}
	swept := make(chan result, 1)
	go func() {
		n, err := tr.Sweep(time.Now())
		swept <- result{n: n, err: err}
	}()

	deadline := time.NewTimer(2 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer deadline.Stop()
	defer tick.Stop()
	for {
		tr.lockMu.Lock()
		refs := tr.locks[rec.ID].refs
		tr.lockMu.Unlock()
		if refs == 2 {
			break
		}
		select {
		case got := <-swept:
			t.Fatalf("Sweep completed before the transfer lock was released: %+v", got)
		case <-deadline.C:
			t.Fatal("Sweep did not wait for the transfer lock")
		case <-tick.C:
		}
	}

	if err := tr.touch(rec.ID); err != nil {
		t.Fatal(err)
	}
	release()
	released = true
	got := <-swept
	if got.err != nil {
		t.Fatal(got.err)
	}
	if got.n != 0 {
		t.Fatalf("swept %d, want the refreshed transfer spared", got.n)
	}
	if _, err := tr.Get(rec.ID); err != nil {
		t.Fatalf("a transfer refreshed while Sweep waited was removed: %v", err)
	}
}

func TestSweepSerializesWithTerminalMutations(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Transfers, *Transfer) error
	}{
		{
			name: "delete",
			mutate: func(tr *Transfers, rec *Transfer) error {
				return tr.Delete(rec.ID, "pixel")
			},
		},
		{
			name: "final decline",
			mutate: func(tr *Transfers, rec *Transfer) error {
				return tr.Decline(rec.ID, "desktop")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			c, _ := NewChunkStore(dir, 64, 1<<20)
			tr, _ := NewTransfers(dir, c, time.Hour, 100, 4096)
			rec, _, _ := tr.Create("pixel", []string{"desktop"}, nil)

			transferDir, _ := tr.transferDir(rec.ID)
			stale := time.Now().Add(-2 * time.Hour)
			for _, path := range []string{
				filepath.Join(transferDir, "cids.json"),
				filepath.Join(transferDir, "meta.json"),
				transferDir,
			} {
				if err := os.Chtimes(path, stale, stale); err != nil {
					t.Fatal(err)
				}
			}

			release := tr.lockTransfer(rec.ID)
			released := false
			defer func() {
				if !released {
					release()
				}
			}()

			type sweepResult struct {
				n   int
				err error
			}
			swept := make(chan sweepResult, 1)
			go func() {
				n, err := tr.Sweep(time.Now())
				swept <- sweepResult{n: n, err: err}
			}()

			waitForRefs := func(want int) {
				deadline := time.NewTimer(2 * time.Second)
				tick := time.NewTicker(time.Millisecond)
				defer deadline.Stop()
				defer tick.Stop()
				for {
					tr.lockMu.Lock()
					refs := tr.locks[rec.ID].refs
					tr.lockMu.Unlock()
					if refs == want {
						return
					}
					select {
					case <-deadline.C:
						t.Fatalf("transfer lock has %d references, want %d", refs, want)
					case <-tick.C:
					}
				}
			}
			waitForRefs(2)

			mutated := make(chan error, 1)
			go func() { mutated <- tt.mutate(tr, rec) }()
			waitForRefs(3)
			release()
			released = true

			sweep := <-swept
			mutationErr := <-mutated
			if sweep.err != nil {
				t.Fatal(sweep.err)
			}
			switch {
			case sweep.n == 1 && errors.Is(mutationErr, ErrNotFound):
			case sweep.n == 0 && mutationErr == nil:
			default:
				t.Fatalf("swept = %d, mutation err = %v; want exactly one terminal mutation", sweep.n, mutationErr)
			}

			hist, err := tr.History("pixel")
			if err != nil {
				t.Fatal(err)
			}
			seen := 0
			for _, tomb := range hist {
				if tomb.ID == rec.ID {
					seen++
				}
			}
			if seen != 1 {
				t.Fatalf("terminal history entries = %d, want one", seen)
			}
		})
	}
}

// A directory being built is named so that it cannot pass tidRe. Nothing reads
// it as a transfer, and a crash that leaves one behind is cleaned up by the
// same sweep that expires transfers.
func TestHalfBuiltTransferIsInvisibleAndSweptAway(t *testing.T) {
	dir := t.TempDir()
	c, _ := NewChunkStore(dir, 64, 1<<20)
	tr, _ := NewTransfers(dir, c, time.Millisecond, 100, 4096)

	partial := filepath.Join(dir, "transfers", tmpPrefix+strings.Repeat("a", 32))
	if err := os.Mkdir(partial, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(partial, "cids.json"), []byte(`["`+cid(9)+`"]`), 0o600); err != nil {
		t.Fatal(err)
	}

	ref, err := tr.Referenced()
	if err != nil {
		t.Fatal(err)
	}
	if len(ref) != 0 {
		t.Fatalf("a half-built transfer reached the referenced set: %v", ref)
	}
	if got, _ := tr.Inbox("desktop"); len(got) != 0 {
		t.Fatalf("a half-built transfer reached an inbox: %v", got)
	}

	time.Sleep(10 * time.Millisecond)
	n, err := tr.Sweep(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("swept %d, want 0: a half-built transfer is not a transfer", n)
	}
	if _, err := os.Stat(partial); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the half-built directory should have been removed")
	}
	if hist, _ := tr.History("pixel"); len(hist) != 0 {
		t.Fatal("a half-built transfer should leave no tombstone")
	}
}

// Records and chunks land on the same disk, so they are metered against the
// same total. Without this the record tree grows without any bound at all.
func TestRecordsAreMeteredAgainstTheSharedBudget(t *testing.T) {
	dir := t.TempDir()
	c, err := NewChunkStore(dir, 64, 32<<10)
	if err != nil {
		t.Fatal(err)
	}
	tr, err := NewTransfers(dir, c, time.Hour, 100, 4096)
	if err != nil {
		t.Fatal(err)
	}

	record := strings.Repeat("x", 4000)
	filled, hit := "", false
	for i := 0; i < 64 && !hit; i++ {
		rec, _, err := tr.Create("pixel", nil, []string{cid(1)})
		if errors.Is(err, ErrQuota) {
			hit = true
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		switch err := tr.PutRecord(rec.ID, "meta", strings.NewReader(record)); {
		case errors.Is(err, ErrQuota):
			hit = true
		case err != nil:
			t.Fatal(err)
		default:
			filled = rec.ID
		}
	}
	if !hit {
		t.Fatal("the record tree grew past the whole disk budget unchecked")
	}

	// Deleting a transfer returns its record bytes to the budget.
	if err := tr.Delete(filled, "pixel"); err != nil {
		t.Fatal(err)
	}
	rec, _, err := tr.Create("pixel", nil, []string{cid(1)})
	if err != nil {
		t.Fatalf("create after a delete freed room: %v", err)
	}
	if err := tr.PutRecord(rec.ID, "meta", strings.NewReader(record)); err != nil {
		t.Fatalf("put after a delete freed room: %v", err)
	}
}

func TestDeleteWaitsForAnInFlightRecordUpload(t *testing.T) {
	tr, chunks := newTransfers(t)
	rec, _, err := tr.Create("pixel", nil, []string{cid(1)})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	putDone := make(chan error, 1)
	go func() {
		putDone <- tr.PutRecord(rec.ID, "meta", &pausedReader{
			body: []byte("sealed metadata"), started: started, gate: release,
		})
	}()
	<-started

	deleteStarted := make(chan struct{})
	deleteDone := make(chan error, 1)
	go func() {
		close(deleteStarted)
		deleteDone <- tr.Delete(rec.ID, "pixel")
	}()
	<-deleteStarted
	select {
	case err := <-deleteDone:
		close(release)
		<-putDone
		t.Fatalf("delete finished with %v while its record upload was still in flight", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	if err := <-putDone; err != nil {
		t.Fatalf("record upload = %v", err)
	}
	if err := <-deleteDone; err != nil {
		t.Fatalf("delete = %v", err)
	}
	if _, err := tr.Get(rec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete = %v, want ErrNotFound", err)
	}
	chunks.mu.Lock()
	recordUsed := chunks.recordUsed
	chunks.mu.Unlock()
	if recordUsed != 0 {
		t.Fatalf("record bytes after delete = %d, want 0", recordUsed)
	}
}

// Chunk admission has to see records already occupying the same data disk.
// Otherwise a records-first upload can spend most of the budget and a later
// chunk still sees an empty store and takes the real total past maxTotal.
func TestChunkAdmissionCountsExistingRecordsAgainstTheSharedBudget(t *testing.T) {
	dir := t.TempDir()
	c, err := NewChunkStore(dir, 512, 1024)
	if err != nil {
		t.Fatal(err)
	}
	tr, err := NewTransfers(dir, c, time.Hour, 100, 512)
	if err != nil {
		t.Fatal(err)
	}

	rec, _, err := tr.Create("pixel", nil, []string{cid(1)})
	if err != nil {
		t.Fatal(err)
	}
	if err := tr.PutRecord(rec.ID, "meta", strings.NewReader(strings.Repeat("r", 512))); err != nil {
		t.Fatal(err)
	}

	err = c.Put(cid(2), strings.NewReader(strings.Repeat("c", 400)))
	if !errors.Is(err, ErrQuota) {
		t.Fatalf("chunk after records: err = %v, want ErrQuota", err)
	}
	if c.Has(cid(2)) {
		t.Fatal("a chunk rejected by the shared budget must leave nothing behind")
	}
}

// History carries the same metadata an inbox does, so it has to be filtered the
// same way. Each of the three transfers exercises one arm of the predicate: one
// addressed to this node, one sent by it to somewhere else, and one that is
// neither. The middle one is what gives the test power over the sender arm; an
// unaddressed transfer would pass under a filter that only checked recipients.
func TestHistoryIsScopedToTheCaller(t *testing.T) {
	tr, _ := newTransfers(t)
	mine, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	sent, _, _ := tr.Create("desktop", []string{"laptop"}, []string{cid(1)})
	theirs, _, _ := tr.Create("pixel", []string{"laptop"}, []string{cid(1)})

	// Every delete here is made by a node entitled to it, so this test measures
	// the history filter and nothing else.
	for _, d := range []struct{ id, node string }{
		{mine.ID, "pixel"}, {sent.ID, "desktop"}, {theirs.ID, "pixel"},
	} {
		if err := tr.Delete(d.id, d.node); err != nil {
			t.Fatal(err)
		}
	}

	hist, err := tr.History("desktop")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, h := range hist {
		seen[h.ID] = true
	}
	if !seen[mine.ID] {
		t.Fatal("a tombstone addressed to this node is missing")
	}
	if !seen[sent.ID] {
		t.Fatal("a tombstone this node sent is missing")
	}
	if seen[theirs.ID] {
		t.Fatal("a tombstone for another device's transfer leaked into this history")
	}
}

func TestHeldDeliveryPathSurvivesIntoHistory(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, err := tr.CreateHeld("pixel", nil, []string{cid(1)})
	if err != nil {
		t.Fatal(err)
	}
	if err := tr.Delete(rec.ID, "pixel"); err != nil {
		t.Fatal(err)
	}

	hist, err := tr.History("pixel")
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) != 1 || !hist[0].Held {
		t.Fatalf("history = %+v, want one held tombstone", hist)
	}
}

func TestDeletePromptlyReclaimsTheSoleTransfersChunks(t *testing.T) {
	dir := t.TempDir()
	chunks, err := NewChunkStore(dir, 1024, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tr, err := NewTransfers(dir, chunks, time.Hour, 100, 64)
	if err != nil {
		t.Fatal(err)
	}
	rec, _, err := tr.CreateHeld("pixel", nil, []string{cid(1)})
	if err != nil {
		t.Fatal(err)
	}
	if err := tr.PutRecord(rec.ID, "meta", strings.NewReader("m")); err != nil {
		t.Fatal(err)
	}
	if err := tr.PutRecord(rec.ID, "chunklist", strings.NewReader("l")); err != nil {
		t.Fatal(err)
	}
	fullChunk := strings.Repeat("x", 1024)
	if err := chunks.Put(cid(1), strings.NewReader(fullChunk)); err != nil {
		t.Fatal(err)
	}

	if err := tr.Delete(rec.ID, "pixel"); err != nil {
		t.Fatal(err)
	}
	if chunks.Has(cid(1)) {
		t.Fatal("the deleted transfer's sole chunk still occupies the quota")
	}

	next, _, err := tr.CreateHeld("pixel", nil, []string{cid(2)})
	if err != nil {
		t.Fatalf("create after delete = %v, want reclaimed capacity", err)
	}
	if err := chunks.Put(cid(2), strings.NewReader(fullChunk)); err != nil {
		t.Fatalf("upload after delete = %v, want reclaimed capacity (next transfer %s)", err, next.ID)
	}
}

func TestFinalDeclinePromptlyReclaimsTheSoleTransfersChunks(t *testing.T) {
	dir := t.TempDir()
	chunks, err := NewChunkStore(dir, 1024, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tr, err := NewTransfers(dir, chunks, time.Hour, 100, 64)
	if err != nil {
		t.Fatal(err)
	}
	rec, _, err := tr.CreateHeld("pixel", []string{"desktop"}, []string{cid(1)})
	if err != nil {
		t.Fatal(err)
	}
	fullChunk := strings.Repeat("x", 1024)
	if err := chunks.Put(cid(1), strings.NewReader(fullChunk)); err != nil {
		t.Fatal(err)
	}

	if err := tr.Decline(rec.ID, "desktop"); err != nil {
		t.Fatal(err)
	}
	if chunks.Has(cid(1)) {
		t.Fatal("the fully declined transfer's sole chunk still occupies the quota")
	}

	next, _, err := tr.CreateHeld("pixel", nil, []string{cid(2)})
	if err != nil {
		t.Fatalf("create after final decline = %v, want reclaimed capacity", err)
	}
	if err := chunks.Put(cid(2), strings.NewReader(fullChunk)); err != nil {
		t.Fatalf("upload after final decline = %v, want reclaimed capacity (next transfer %s)", err, next.ID)
	}
}

func TestFinalDeclineWaitsForInFlightWrites(t *testing.T) {
	tests := []struct {
		name   string
		upload func(*Transfers, string, *pausedReader) error
		check  func(*testing.T, *ChunkStore)
	}{
		{
			name: "chunk",
			upload: func(tr *Transfers, id string, body *pausedReader) error {
				return tr.PutChunk(id, cid(2), body)
			},
			check: func(t *testing.T, chunks *ChunkStore) {
				if chunks.Has(cid(2)) {
					t.Fatal("the final decline left the in-flight chunk orphaned")
				}
			},
		},
		{
			name: "record",
			upload: func(tr *Transfers, id string, body *pausedReader) error {
				return tr.PutRecord(id, "meta", body)
			},
			check: func(t *testing.T, chunks *ChunkStore) {
				chunks.mu.Lock()
				recordUsed := chunks.recordUsed
				chunks.mu.Unlock()
				if recordUsed != 0 {
					t.Fatalf("record bytes after final decline = %d, want 0", recordUsed)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tr, chunks := newTransfers(t)
			rec, _, err := tr.CreateHeld("pixel", []string{"desktop"}, []string{cid(2)})
			if err != nil {
				t.Fatal(err)
			}
			started := make(chan struct{})
			release := make(chan struct{})
			uploadDone := make(chan error, 1)
			go func() {
				uploadDone <- tt.upload(tr, rec.ID, &pausedReader{
					body: []byte("sealed body"), started: started, gate: release,
				})
			}()
			<-started

			declineStarted := make(chan struct{})
			declineDone := make(chan error, 1)
			go func() {
				close(declineStarted)
				declineDone <- tr.Decline(rec.ID, "desktop")
			}()
			<-declineStarted
			select {
			case err := <-declineDone:
				close(release)
				<-uploadDone
				t.Fatalf("final decline finished with %v while its %s upload was in flight", err, tt.name)
			case <-time.After(50 * time.Millisecond):
			}

			close(release)
			if err := <-uploadDone; err != nil {
				t.Fatalf("%s upload = %v", tt.name, err)
			}
			if err := <-declineDone; err != nil {
				t.Fatalf("final decline = %v", err)
			}
			if _, err := tr.Get(rec.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("get after final decline = %v, want ErrNotFound", err)
			}
			tt.check(t, chunks)
		})
	}
}

func TestDeleteRequiresSenderOrRecipient(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})

	// A node that is neither sender nor addressee gets ErrNotFound rather than a
	// distinct error, so the endpoint never confirms that a transfer it has no
	// business knowing about exists.
	if err := tr.Delete(rec.ID, "laptop"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if _, err := tr.Get(rec.ID); err != nil {
		t.Fatal("the refused delete must not have removed anything")
	}
	if hist, _ := tr.History("pixel"); len(hist) != 0 {
		t.Fatal("the refused delete left a tombstone behind")
	}
	if err := tr.Delete(rec.ID, "desktop"); err != nil {
		t.Fatalf("the addressee should be able to delete: %v", err)
	}
}

func TestSenderCanDeleteTheirOwnTransfer(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	if err := tr.Delete(rec.ID, "pixel"); err != nil {
		t.Fatalf("the sender should be able to delete: %v", err)
	}
}

func TestConcurrentDeleteAndDeclineProduceOneTerminalMutation(t *testing.T) {
	tr, _ := newTransfers(t)
	for attempt := 0; attempt < 32; attempt++ {
		rec, _, err := tr.Create("pixel", []string{"desktop"}, nil)
		if err != nil {
			t.Fatal(err)
		}

		start := make(chan struct{})
		results := make(chan error, 2)
		go func() {
			<-start
			results <- tr.Delete(rec.ID, "pixel")
		}()
		go func() {
			<-start
			results <- tr.Decline(rec.ID, "desktop")
		}()
		close(start)

		removed, missing := 0, 0
		for range 2 {
			switch err := <-results; {
			case err == nil:
				removed++
			case errors.Is(err, ErrNotFound):
				missing++
			default:
				t.Fatalf("terminal mutation = %v", err)
			}
		}
		if removed != 1 || missing != 1 {
			t.Fatalf("successful mutations = %d, not found = %d; want one of each", removed, missing)
		}

		hist, err := tr.History("pixel")
		if err != nil {
			t.Fatal(err)
		}
		seen := 0
		for _, tomb := range hist {
			if tomb.ID == rec.ID {
				seen++
			}
		}
		if seen != 1 {
			t.Fatalf("terminal history entries = %d, want one", seen)
		}
	}
}

func TestUnaddressedTransfersAreDeletableByAnyone(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	if err := tr.Delete(rec.ID, "laptop"); err != nil {
		t.Fatalf("an unaddressed transfer is everyone's: %v", err)
	}
}

func TestSweepIgnoresAddressingWhenExpiring(t *testing.T) {
	dir := t.TempDir()
	c, _ := NewChunkStore(dir, 64, 1<<20)
	tr, _ := NewTransfers(dir, c, time.Millisecond, 100, 4096)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	time.Sleep(10 * time.Millisecond)

	// Expiry is the server's own action, not one performed on behalf of a
	// device, so the visibility rule must not block it.
	n, err := tr.Sweep(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("swept %d, want 1", n)
	}
	if _, err := tr.Get(rec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("an addressed transfer survived expiry")
	}
}

func TestDeclineHidesFromTheDecliningDeviceOnly(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})

	if err := tr.Decline(rec.ID, "desktop"); err != nil {
		t.Fatal(err)
	}
	desktop, _ := tr.Inbox("desktop")
	if len(desktop) != 0 {
		t.Fatal("a declined transfer should leave the decliner's inbox")
	}
	// Unaddressed means every device was its destination, so one refusal does
	// not speak for the others.
	laptop, _ := tr.Inbox("laptop")
	if len(laptop) != 1 {
		t.Fatalf("laptop sees %d, want the transfer still there", len(laptop))
	}
	if _, err := tr.Get(rec.ID); err != nil {
		t.Fatal("the transfer itself should survive")
	}
}

func TestDeclineByEveryAddresseeDeletesTheTransfer(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop", "laptop"}, []string{cid(1)})

	if err := tr.Decline(rec.ID, "desktop"); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Get(rec.ID); err != nil {
		t.Fatal("one of two addressees declining must not delete it")
	}
	if err := tr.Decline(rec.ID, "laptop"); err != nil {
		t.Fatal(err)
	}
	// Nobody is left who could collect it.
	if _, err := tr.Get(rec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("the last addressee declining should delete the transfer")
	}
	hist, _ := tr.History("pixel")
	if len(hist) != 1 || len(hist[0].Declined) != 2 {
		t.Fatalf("the tombstone should record who declined: %+v", hist)
	}
}

func TestConcurrentDeclinesPreserveEveryDecision(t *testing.T) {
	tr, _ := newTransfers(t)
	recipients := []string{
		"device-a", "device-b", "device-c", "device-d",
		"device-e", "device-f", "device-g", "device-h",
		"device-i", "device-j", "device-k", "device-l",
	}
	rec, _, err := tr.Create("pixel", recipients, nil)
	if err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	results := make(chan error, len(recipients))
	for _, node := range recipients {
		go func(node string) {
			<-start
			results <- tr.Decline(rec.ID, node)
		}(node)
	}
	close(start)
	for range recipients {
		if err := <-results; err != nil {
			t.Fatalf("concurrent decline = %v", err)
		}
	}

	if _, err := tr.Get(rec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("fully declined transfer still exists: %v", err)
	}
	hist, err := tr.History("pixel")
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) != 1 || len(hist[0].Declined) != len(recipients) {
		t.Fatalf("tombstone decisions = %+v, want all %d", hist, len(recipients))
	}
}

func TestDeclineIsIdempotent(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	if err := tr.Decline(rec.ID, "desktop"); err != nil {
		t.Fatal(err)
	}
	// The transfer is gone, so a repeat is a 404 rather than an error worth
	// surfacing to a user who tapped twice.
	if err := tr.Decline(rec.ID, "desktop"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestDeclineTwiceOnAnUnaddressedTransferIsHarmless(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	for i := 0; i < 3; i++ {
		if err := tr.Decline(rec.ID, "desktop"); err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	info, err := tr.Get(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Declined) != 1 {
		t.Fatalf("Declined = %v, want one entry", info.Declined)
	}
}

func TestDeclineRequiresVisibility(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	if err := tr.Decline(rec.ID, "laptop"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound for a device it was never sent to", err)
	}
}

// transferIDs names what a queue holds. Printing the slice itself would print
// pointers, which say nothing about which transfer turned up.
func transferIDs(list []*TransferInfo) []string {
	ids := []string{}
	for _, info := range list {
		ids = append(ids, info.ID)
	}
	return ids
}

func TestProgressIsPerRecipient(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop", "laptop"}, []string{cid(1), cid(2)})

	if err := tr.SetProgress(rec.ID, "desktop", []byte{0b01}); err != nil {
		t.Fatal(err)
	}
	desktop, err := tr.Progress(rec.ID, "pixel", "desktop")
	if err != nil {
		t.Fatal(err)
	}
	if len(desktop) != 1 || desktop[0] != 0b01 {
		t.Fatalf("desktop progress = %v", desktop)
	}
	// One device holding a chunk says nothing about another.
	laptop, err := tr.Progress(rec.ID, "pixel", "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if len(laptop) != 0 {
		t.Fatalf("laptop progress = %v, want empty", laptop)
	}
}

func TestProgressRejectsAWrongSizedBitmap(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1), cid(2)})
	// Two chunks need one byte. Anything else is a client bug, and accepting it
	// would leave a bitmap whose bits do not line up with the chunk list.
	if err := tr.SetProgress(rec.ID, "desktop", []byte{0, 0, 0}); !errors.Is(err, ErrBadID) {
		t.Fatalf("err = %v, want ErrBadID", err)
	}
}

// Progress is a read over the same resource as SetProgress, so it needs the same
// scoping. This is the third time this class has appeared here: history, then
// delete, then this. See TestEveryIdTakingMethodIsScoped for the tripwire.
func TestProgressReadRequiresVisibility(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	if err := tr.SetProgress(rec.ID, "desktop", []byte{1}); err != nil {
		t.Fatal(err)
	}

	// An unrelated device knowing the id is not authorization. A 128-bit random
	// id is not a control once it reaches a log or a screenshot.
	if _, err := tr.Progress(rec.ID, "laptop", "desktop"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound for a device the transfer never involved", err)
	}
	// The sender legitimately reads each recipient's progress.
	if _, err := tr.Progress(rec.ID, "pixel", "desktop"); err != nil {
		t.Fatalf("the sender should be able to read progress: %v", err)
	}
	// So does the recipient, about itself.
	if _, err := tr.Progress(rec.ID, "desktop", "desktop"); err != nil {
		t.Fatalf("the recipient should be able to read its own progress: %v", err)
	}
}

// A tripwire rather than a test of behavior. Every exported method here that
// acts on a single transfer must refuse a caller the transfer does not involve,
// and that has now been forgotten three times. Adding a method changes the
// count, which fails this test and forces a decision about scoping rather than
// letting the omission ship quietly.
func TestEveryIdTakingMethodIsScoped(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	const stranger = "laptop"

	refusals := map[string]error{
		"Delete":      tr.Delete(rec.ID, stranger),
		"Decline":     tr.Decline(rec.ID, stranger),
		"SetProgress": tr.SetProgress(rec.ID, stranger, []byte{1}),
	}
	for name, err := range refusals {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s(%q) = %v, want ErrNotFound", name, stranger, err)
		}
	}
	if _, err := tr.Progress(rec.ID, stranger, "desktop"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Progress = %v, want ErrNotFound", err)
	}
	if _, err := tr.Get(rec.ID); err != nil {
		t.Fatal("a refused call must not have modified anything")
	}

	// Get, OpenRecord, PutRecord, and PutChunk are deliberately unscoped: the
	// HTTP layer gates them, uploads prove the transfer exists, and the relay path
	// needs them. If that changes, scope them and move them into the table above.
	const exportedMethods = 15
	if got := reflect.TypeOf(tr).NumMethod(); got != exportedMethods {
		t.Fatalf("Transfers has %d exported methods, expected %d. "+
			"If you added one that acts on a single transfer, scope it with "+
			"visibleTo and add it to this test before updating the count.",
			got, exportedMethods)
	}
}

func TestProgressRequiresVisibility(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	if err := tr.SetProgress(rec.ID, "laptop", []byte{1}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestQueueListsWhatThisNodeStillOwes(t *testing.T) {
	tr, _ := newTransfers(t)
	mine, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	theirs, _, _ := tr.Create("laptop", []string{"desktop"}, []string{cid(1)})
	for _, rec := range []*Transfer{mine, theirs} {
		if err := tr.PutRecord(rec.ID, "meta", strings.NewReader("sealed-meta")); err != nil {
			t.Fatal(err)
		}
	}

	queue, err := tr.Queue("pixel")
	if err != nil {
		t.Fatal(err)
	}
	if len(queue) != 1 || queue[0].ID != mine.ID {
		t.Fatalf("queue = %v, want only what pixel sent (not %s)", transferIDs(queue), theirs.ID)
	}
}

func TestUnaddressedHeldTransferNeverEntersTheDirectQueue(t *testing.T) {
	tr, _ := newTransfers(t)
	if _, _, err := tr.CreateHeld("pixel", nil, []string{cid(1)}); err != nil {
		t.Fatal(err)
	}

	queue, err := tr.Queue("pixel")
	if err != nil {
		t.Fatal(err)
	}
	if len(queue) != 0 {
		t.Fatalf("queue = %v, want no direct work for a held broadcast", transferIDs(queue))
	}
}

func TestDirectTransferWithoutMetadataNeverEntersTheQueue(t *testing.T) {
	tr, _ := newTransfers(t)
	if _, _, err := tr.Create("pixel", []string{"desktop"}, []string{cid(1)}); err != nil {
		t.Fatal(err)
	}

	queue, err := tr.Queue("pixel")
	if err != nil {
		t.Fatal(err)
	}
	if len(queue) != 0 {
		t.Fatalf("queue = %v, want no peer work for a transfer whose record upload failed", transferIDs(queue))
	}
}

func TestAFullyDeliveredTransferLeavesTheQueue(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1), cid(2)})
	if err := tr.PutRecord(rec.ID, "meta", strings.NewReader("sealed-meta")); err != nil {
		t.Fatal(err)
	}

	// One of two bits set: the recipient is still missing a chunk.
	if err := tr.SetProgress(rec.ID, "desktop", []byte{0b01}); err != nil {
		t.Fatal(err)
	}
	if queue, _ := tr.Queue("pixel"); len(queue) != 1 {
		t.Fatalf("queue = %v, want the partly delivered transfer", transferIDs(queue))
	}
	// Both bits set: the only recipient has everything.
	if err := tr.SetProgress(rec.ID, "desktop", []byte{0b11}); err != nil {
		t.Fatal(err)
	}
	queue, _ := tr.Queue("pixel")
	if len(queue) != 0 {
		t.Fatalf("queue = %v, want empty once every recipient has every chunk", transferIDs(queue))
	}
}

// A transfer is named by its chunk list, and that list is one sealed record. If
// more chunks are admitted than the record cap can carry, the transfer is
// accepted, every chunk is cut, sealed and staged, and the failure lands on the
// last write, after all the work and with nothing to show for it. The two
// limits are configured independently, so the constructor has to reconcile
// them.
func TestChunkLimitCannotExceedWhatTheRecordCapCanList(t *testing.T) {
	dir := t.TempDir()
	chunks, err := NewChunkStore(dir, 64, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	// Room for exactly 10 hashes plus the frame, against a limit asking for far
	// more.
	maxRecord := 10*chunkHashBytes + recordFrameBytes
	tr, err := NewTransfers(dir, chunks, time.Hour, 200000, maxRecord)
	if err != nil {
		t.Fatal(err)
	}
	if tr.maxChunks != 10 {
		t.Fatalf("maxChunks = %d, want 10: the record cap is the binding limit", tr.maxChunks)
	}

	// And the reconciled limit is one a real list actually fits inside.
	if got := chunkListBytes(tr.maxChunks); got > int64(maxRecord) {
		t.Fatalf("a full chunk list is %d bytes against a %d cap", got, maxRecord)
	}

	// A transfer at the limit is admitted; one past it is refused up front,
	// before anything has been sealed.
	cids := make([]string, tr.maxChunks)
	for i := range cids {
		cids[i] = cid(byte(i%9 + 1))
	}
	if _, _, err := tr.Create("pixel", nil, cids); err != nil {
		t.Fatalf("a transfer at the limit was refused: %v", err)
	}
	if _, _, err := tr.Create("pixel", nil, append(cids, cid(1))); !errors.Is(err, ErrQuota) {
		t.Fatalf("one chunk past the limit = %v, want ErrQuota", err)
	}
}

// The lower limit is left alone: a record cap with room to spare must not raise
// a deliberately small chunk limit.
func TestChunkLimitIsNotRaisedByARoomyRecordCap(t *testing.T) {
	dir := t.TempDir()
	chunks, err := NewChunkStore(dir, 64, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	tr, err := NewTransfers(dir, chunks, time.Hour, 5, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if tr.maxChunks != 5 {
		t.Fatalf("maxChunks = %d, want the configured 5", tr.maxChunks)
	}
}
