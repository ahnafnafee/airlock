package main

import (
	"errors"
	"os"
	"path/filepath"
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

	if err := tr.Delete(rec.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Get(rec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	hist, err := tr.History()
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
	if hist, _ := tr.History(); len(hist) != 1 {
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

// Chunks land outside the transfer directory, so the upload path refreshes the
// clock through Touch. This is the contract the chunk upload handler relies on
// to keep a transfer whose upload outlasts the TTL from being swept mid-flight.
func TestTouchKeepsAnUploadingTransferAlive(t *testing.T) {
	dir := t.TempDir()
	c, _ := NewChunkStore(dir, 64, 1<<20)
	tr, _ := NewTransfers(dir, c, 200*time.Millisecond, 100, 4096)

	uploading, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	idle, _, _ := tr.Create("pixel", nil, []string{cid(2)})
	time.Sleep(250 * time.Millisecond)

	if err := tr.Touch(uploading.ID); err != nil {
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
	if err := tr.Touch(strings.Repeat("f", 32)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound for an unknown transfer", err)
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
	if hist, _ := tr.History(); len(hist) != 0 {
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
	if err := tr.Delete(filled); err != nil {
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
