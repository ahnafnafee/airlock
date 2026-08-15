package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

var tidRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// recordKinds is a closed set. A record kind reaches the filesystem as a
// filename, so allowing an arbitrary string would let a caller name cids.json
// or meta.json and overwrite the server's own bookkeeping.
var recordKinds = map[string]bool{"meta": true, "chunklist": true, "thumb": true}

const (
	historyMaxEntries = 1000
	historyMaxAge     = 90 * 24 * time.Hour
)

// Transfer is what the server knows. Everything a person would recognize lives
// in the sealed records and is opaque here.
type Transfer struct {
	ID         string    `json:"id"`
	Sender     string    `json:"sender"`
	To         []string  `json:"to"`
	CreatedAt  time.Time `json:"createdAt"`
	ChunkCount int       `json:"chunkCount"`
}

// TransferInfo is a Transfer plus the state derived from what is on disk.
type TransferInfo struct {
	Transfer
	Cids     []string `json:"cids"`
	Missing  []string `json:"missing"`
	Complete bool     `json:"complete"`
	Meta     string   `json:"meta"`
	Thumb    string   `json:"thumb"`
}

type Tombstone struct {
	ID        string    `json:"id"`
	Sender    string    `json:"sender"`
	To        []string  `json:"to"`
	Meta      string    `json:"meta"`
	Bytes     int64     `json:"bytes"`
	CreatedAt time.Time `json:"createdAt"`
	EndedAt   time.Time `json:"endedAt"`
}

type Transfers struct {
	dir       string
	chunks    *ChunkStore
	ttl       time.Duration
	maxChunks int
	maxRecord int

	histMu sync.Mutex
}

func NewTransfers(dir string, chunks *ChunkStore, ttl time.Duration, maxChunksPerTransfer, maxRecordBytes int) (*Transfers, error) {
	root := filepath.Join(dir, "transfers")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	return &Transfers{
		dir: root, chunks: chunks, ttl: ttl,
		maxChunks: maxChunksPerTransfer, maxRecord: maxRecordBytes,
	}, nil
}

// transferDir is the only place a transfer id becomes a path.
func (t *Transfers) transferDir(id string) (string, error) {
	if !tidRe.MatchString(id) {
		return "", ErrNotFound
	}
	return filepath.Join(t.dir, id), nil
}

func (t *Transfers) Create(sender string, to, cids []string) (*Transfer, []string, error) {
	if len(cids) < 1 || len(cids) > t.maxChunks {
		return nil, nil, ErrQuota
	}
	for _, id := range cids {
		if !cidRe.MatchString(id) {
			return nil, nil, ErrBadID
		}
	}
	for _, node := range to {
		if len(node) > 128 {
			return nil, nil, ErrBadID
		}
	}

	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, nil, err
	}
	rec := &Transfer{
		ID:         hex.EncodeToString(raw[:]),
		Sender:     sender,
		To:         append([]string{}, to...),
		CreatedAt:  time.Now().UTC(),
		ChunkCount: len(cids),
	}
	dir, err := t.transferDir(rec.ID)
	if err != nil {
		return nil, nil, err
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		return nil, nil, err
	}

	// Write the id list before anything else. It is the server's reference
	// record, and a sweep that ran between Mkdir and this write would otherwise
	// consider the transfer's chunks unreferenced.
	if err := t.writeJSON(dir, "cids.json", cids); err != nil {
		os.RemoveAll(dir)
		return nil, nil, err
	}
	if err := t.writeJSON(dir, "meta.json", rec); err != nil {
		os.RemoveAll(dir)
		return nil, nil, err
	}
	return rec, t.chunks.Missing(cids), nil
}

func (t *Transfers) writeJSON(dir, name string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(dir, name), b)
}

func (t *Transfers) PutRecord(id, kind string, r io.Reader) error {
	if !recordKinds[kind] {
		return ErrBadID
	}
	dir, err := t.transferDir(id)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dir, "meta.json")); err != nil {
		return ErrNotFound
	}
	return writeStream(filepath.Join(dir, kind), r, int64(t.maxRecord))
}

func (t *Transfers) OpenRecord(id, kind string) (*os.File, error) {
	if !recordKinds[kind] {
		return nil, ErrBadID
	}
	dir, err := t.transferDir(id)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(filepath.Join(dir, kind))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

func (t *Transfers) Get(id string) (*TransferInfo, error) {
	dir, err := t.transferDir(id)
	if err != nil {
		return nil, err
	}
	var rec Transfer
	if err := t.readJSON(dir, "meta.json", &rec); err != nil {
		return nil, err
	}
	var cids []string
	if err := t.readJSON(dir, "cids.json", &cids); err != nil {
		return nil, err
	}

	info := &TransferInfo{Transfer: rec, Cids: cids}
	info.Missing = t.chunks.Missing(cids)
	info.Meta = t.readRecordB64(dir, "meta")
	info.Thumb = t.readRecordB64(dir, "thumb")
	_, listErr := os.Stat(filepath.Join(dir, "chunklist"))
	info.Complete = len(info.Missing) == 0 && info.Meta != "" && listErr == nil
	return info, nil
}

func (t *Transfers) readJSON(dir, name string, v any) error {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func (t *Transfers) readRecordB64(dir, kind string) string {
	b, err := os.ReadFile(filepath.Join(dir, kind))
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(b)
}

// Inbox returns transfers addressed to everyone or to this node, newest first.
func (t *Transfers) Inbox(node string) ([]*TransferInfo, error) {
	all, err := t.list()
	if err != nil {
		return nil, err
	}
	out := []*TransferInfo{}
	for _, info := range all {
		if addressedTo(info.To, node) {
			out = append(out, info)
		}
	}
	return out, nil
}

func addressedTo(to []string, node string) bool {
	if len(to) == 0 {
		return true
	}
	for _, n := range to {
		if n == node {
			return true
		}
	}
	return false
}

// ponytail: list walks every transfer directory and reads its records on each
// call. Fine at the scale of a personal node's inbox; move to an in-memory
// index kept current by the file watcher if the transfer count ever grows
// large enough to make the walk itself the bottleneck.
func (t *Transfers) list() ([]*TransferInfo, error) {
	ents, err := os.ReadDir(t.dir)
	if err != nil {
		return nil, err
	}
	out := []*TransferInfo{}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		info, err := t.Get(e.Name())
		if err != nil {
			continue // half-created or mid-sweep
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (t *Transfers) Delete(id string) error {
	info, err := t.Get(id)
	if err != nil {
		return err
	}
	if err := t.appendTombstone(info); err != nil {
		return err
	}
	dir, err := t.transferDir(id)
	if err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

// appendTombstone keeps the sealed metadata, so history is a list of filenames
// only the owner's devices can read.
//
// ponytail: rewrites the whole history file on every delete. Fine at the
// bounded historyMaxEntries scale; move to an append-only log with periodic
// compaction if deletes ever get frequent enough for the rewrite to matter.
func (t *Transfers) appendTombstone(info *TransferInfo) error {
	t.histMu.Lock()
	defer t.histMu.Unlock()

	hist, err := t.historyLocked()
	if err != nil {
		return err
	}
	hist = append(hist, Tombstone{
		ID: info.ID, Sender: info.Sender, To: info.To, Meta: info.Meta,
		Bytes: int64(info.ChunkCount), CreatedAt: info.CreatedAt, EndedAt: time.Now().UTC(),
	})

	cutoff := time.Now().Add(-historyMaxAge)
	kept := hist[:0]
	for _, tomb := range hist {
		if tomb.EndedAt.After(cutoff) {
			kept = append(kept, tomb)
		}
	}
	if len(kept) > historyMaxEntries {
		kept = kept[len(kept)-historyMaxEntries:]
	}
	b, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(t.dir, "..", "history.json"), b)
}

func (t *Transfers) History() ([]Tombstone, error) {
	t.histMu.Lock()
	defer t.histMu.Unlock()
	hist, err := t.historyLocked()
	if err != nil {
		return nil, err
	}
	sort.Slice(hist, func(i, j int) bool { return hist[i].EndedAt.After(hist[j].EndedAt) })
	return hist, nil
}

func (t *Transfers) historyLocked() ([]Tombstone, error) {
	b, err := os.ReadFile(filepath.Join(t.dir, "..", "history.json"))
	if errors.Is(err, os.ErrNotExist) {
		return []Tombstone{}, nil
	}
	if err != nil {
		return nil, err
	}
	var hist []Tombstone
	if err := json.Unmarshal(b, &hist); err != nil {
		return nil, err
	}
	return hist, nil
}

// Referenced is the mark half of mark-and-sweep. It reads the plaintext id
// lists, which is the reason those lists are not sealed: the server has to know
// what it may delete.
func (t *Transfers) Referenced() (map[string]bool, error) {
	ents, err := os.ReadDir(t.dir)
	if err != nil {
		return nil, err
	}
	ref := map[string]bool{}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		dir, err := t.transferDir(e.Name())
		if err != nil {
			continue
		}
		var cids []string
		if err := t.readJSON(dir, "cids.json", &cids); err != nil {
			continue
		}
		for _, id := range cids {
			ref[id] = true
		}
	}
	return ref, nil
}

// Sweep expires transfers by their last write rather than their creation, so a
// long upload is never swept mid-flight and a finished one expires the stated
// TTL after its final piece landed.
func (t *Transfers) Sweep(now time.Time) (int, error) {
	ents, err := os.ReadDir(t.dir)
	if err != nil {
		return 0, err
	}
	swept := 0
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		dir, err := t.transferDir(e.Name())
		if err != nil {
			continue
		}
		last, err := newestMTime(dir)
		if err != nil || now.Sub(last) <= t.ttl {
			continue
		}
		if t.Delete(e.Name()) == nil {
			swept++
		}
	}
	return swept, nil
}

func newestMTime(dir string) (time.Time, error) {
	info, err := os.Stat(dir)
	if err != nil {
		return time.Time{}, err
	}
	newest := info.ModTime()
	ents, err := os.ReadDir(dir)
	if err != nil {
		return time.Time{}, err
	}
	for _, e := range ents {
		ei, err := e.Info()
		if err != nil {
			continue
		}
		if ei.ModTime().After(newest) {
			newest = ei.ModTime()
		}
	}
	return newest, nil
}
