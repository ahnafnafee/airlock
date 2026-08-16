package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var tidRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// tmpPrefix names a transfer directory that is still being built. It cannot
// match tidRe, so transferDir rejects it and every walk over the tree skips it.
const tmpPrefix = ".new-"

// recordKinds is a closed set. A record kind reaches the filesystem as a
// filename, so allowing an arbitrary string would let a caller name cids.json
// or meta.json and overwrite the server's own bookkeeping.
var recordKinds = map[string]bool{"meta": true, "chunklist": true, "thumb": true}

// ponytail: history is one JSON file holding up to historyMaxEntries
// tombstones, each carrying its transfer's sealed metadata inline. The sealed
// record is a filename and a key, so entries are small in practice, but the
// ceiling is historyMaxEntries times the record cap. Move the sealed metadata
// out to a file per tombstone if that ceiling ever stops being theoretical.
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
	Declined   []string  `json:"declined"`
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

// Tombstone records that a transfer existed and ended. It counts chunks rather
// than bytes: the server never learns a sealed chunk's plaintext length, and
// the chunk files themselves are shared with any other transfer that references
// the same content, so no byte total could be attributed to one transfer.
type Tombstone struct {
	ID         string    `json:"id"`
	Sender     string    `json:"sender"`
	To         []string  `json:"to"`
	Declined   []string  `json:"declined"`
	Meta       string    `json:"meta"`
	ChunkCount int       `json:"chunkCount"`
	CreatedAt  time.Time `json:"createdAt"`
	EndedAt    time.Time `json:"endedAt"`
}

type Transfers struct {
	dir       string
	chunks    *ChunkStore
	ttl       time.Duration
	maxChunks int
	maxRecord int

	histMu sync.Mutex

	// announced remembers which transfers have already told their addressees
	// they exist. Records and chunks arrive in any order and every write asks to
	// announce, so without this a transfer would notify once per write. It is
	// in memory on purpose: after a restart, re-announcing a transfer that is
	// still waiting is a repeated nudge about something genuinely still waiting,
	// which is the better failure than a persisted flag that could suppress the
	// only notification a recipient ever gets.
	annMu     sync.Mutex
	announced map[string]bool

	// recMu guards recUsed and serializes each record write against the quota
	// check that admits it, the same way ChunkStore guards its own total.
	recMu   sync.Mutex
	recUsed int64
}

func NewTransfers(dir string, chunks *ChunkStore, ttl time.Duration, maxChunksPerTransfer, maxRecordBytes int) (*Transfers, error) {
	root := filepath.Join(dir, "transfers")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	// Records land on the same disk as chunks, so they are measured at startup
	// and metered afterwards exactly as the chunk store measures itself.
	used, err := walkBytes(root)
	if err != nil {
		return nil, err
	}
	return &Transfers{
		dir: root, chunks: chunks, ttl: ttl,
		maxChunks: maxChunksPerTransfer, maxRecord: maxRecordBytes,
		recUsed:   used,
		announced: map[string]bool{},
	}, nil
}

// admitLocked reports whether n more bytes of records fit in the data
// directory's budget. Records and chunks share one disk, so they are counted
// against one total rather than each pretending the other's bytes are free.
// Callers hold recMu across the write that follows, so two writers cannot both
// pass on the same stale total.
func (t *Transfers) admitLocked(n int64) error {
	if t.chunks.Used()+t.recUsed+n > t.chunks.maxTotalBytes {
		return ErrQuota
	}
	return nil
}

// releaseRecordBytes returns a removed directory's bytes to the shared budget.
func (t *Transfers) releaseRecordBytes(n int64) {
	t.recMu.Lock()
	defer t.recMu.Unlock()
	t.recUsed -= n
	if t.recUsed < 0 {
		t.recUsed = 0
	}
}

// removeTree deletes a directory under the transfers root and gives its bytes
// back to the budget.
func (t *Transfers) removeTree(dir string) error {
	n, err := walkBytes(dir)
	if err != nil {
		n = 0
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	t.releaseRecordBytes(n)
	// The directory is named for the transfer, so its base name is the id whose
	// announcement claim is now meaningless.
	t.forgetAnnounced(filepath.Base(dir))
	return nil
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
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
	cidsJSON, err := json.Marshal(cids)
	if err != nil {
		return nil, nil, err
	}
	metaJSON, err := json.Marshal(rec)
	if err != nil {
		return nil, nil, err
	}

	t.recMu.Lock()
	defer t.recMu.Unlock()
	n := int64(len(cidsJSON) + len(metaJSON))
	if err := t.admitLocked(n); err != nil {
		return nil, nil, err
	}

	// A transfer directory is built under a name that fails tidRe and published
	// by a single rename, so the invariant holds without a window: a directory
	// named by a valid transfer id already contains its id list. Referenced()
	// can therefore never see a live transfer as unreferenced and hand the
	// chunk sweep a set missing chunks this transfer needs.
	//
	// ponytail: a sweep that snapshotted its reference set before the rename
	// can still delete a deduplicated chunk just after Missing() observed it.
	// The window is microseconds against an hourly sweep. Close it with a lock
	// the create path and the sweep both take if it ever bites.
	tmp := filepath.Join(t.dir, tmpPrefix+rec.ID)
	if err := os.Mkdir(tmp, 0o700); err != nil {
		return nil, nil, err
	}
	if err := atomicWrite(filepath.Join(tmp, "cids.json"), cidsJSON); err != nil {
		os.RemoveAll(tmp)
		return nil, nil, err
	}
	if err := atomicWrite(filepath.Join(tmp, "meta.json"), metaJSON); err != nil {
		os.RemoveAll(tmp)
		return nil, nil, err
	}
	if err := os.Rename(tmp, dir); err != nil {
		os.RemoveAll(tmp)
		return nil, nil, err
	}
	t.recUsed += n
	return rec, t.chunks.Missing(cids), nil
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
	p := filepath.Join(dir, kind)

	t.recMu.Lock()
	defer t.recMu.Unlock()
	// The record's length is not declared, so the cap is what has to be
	// reserved. Measuring what actually landed afterwards keeps the total
	// honest, the same trade the chunk store makes.
	if err := t.admitLocked(int64(t.maxRecord)); err != nil {
		return err
	}
	before := fileSize(p)
	if err := writeStream(p, r, int64(t.maxRecord)); err != nil {
		return err
	}
	t.recUsed += fileSize(p) - before
	return nil
}

// Touch refreshes a transfer's inactivity clock. Chunks are stored outside the
// transfer directory, so an upload leaves that directory's mtime untouched; the
// chunk upload path calls this so a transfer still receiving data is not swept
// mid-flight. See the note on Sweep.
func (t *Transfers) Touch(id string) error {
	dir, err := t.transferDir(id)
	if err != nil {
		return err
	}
	now := time.Now()
	if err := os.Chtimes(dir, now, now); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

func (t *Transfers) OpenRecord(id, kind string) (*os.File, error) {
	if !recordKinds[kind] {
		return nil, ErrBadID
	}
	dir, err := t.transferDir(id)
	if err != nil {
		return nil, err
	}
	f, err := openShared(filepath.Join(dir, kind))
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

// Inbox returns the transfers this node may see, newest first: the ones it sent
// plus the ones addressed to it or to everyone. A sender sees its own outbound
// transfers because it may delete them, and a list that hid what its own delete
// button reaches would be the surprising half of that pair.
func (t *Transfers) Inbox(node string) ([]*TransferInfo, error) {
	all, err := t.list()
	if err != nil {
		return nil, err
	}
	out := []*TransferInfo{}
	for _, info := range all {
		if visibleTo(info.Sender, info.To, node) && !contains(info.Declined, node) {
			out = append(out, info)
		}
	}
	return out, nil
}

// visibleTo reports whether a node may see and act on a transfer. One predicate
// serves the inbox, the history and deletion, because the device that can see a
// transfer is exactly the device that may remove it.
func visibleTo(sender string, to []string, node string) bool {
	return sender == node || addressedTo(to, node)
}

func addressedTo(to []string, node string) bool {
	if len(to) == 0 {
		return true
	}
	return contains(to, node)
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
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

// progressName keeps a recipient's bitmap in its own file, so two recipients
// writing at the same time never contend and a partial write cannot corrupt
// somebody else's record. The node name is hashed rather than used directly,
// because it comes from WhoIs and has no format guarantee that makes it safe as
// a filename.
func progressName(node string) string {
	sum := sha256.Sum256([]byte(node))
	return "progress-" + hex.EncodeToString(sum[:8])
}

func bitmapLen(chunks int) int { return (chunks + 7) / 8 }

// SetProgress records which chunks a recipient has staged, one bit per chunk
// indexed by position in the transfer's own id list. A bitmap costs about 600
// bytes for a 20 GB file, where a list of the ids themselves would run to
// hundreds of kilobytes and be re-sent on every update.
//
// The server never infers this. The receiver writes it once the chunks are on
// its own disk, because a server that guessed from what it had handed out would
// be wrong exactly when it mattered, after a crash.
func (t *Transfers) SetProgress(id, node string, bitmap []byte) error {
	info, err := t.Get(id)
	if err != nil {
		return err
	}
	if !visibleTo(info.Sender, info.To, node) {
		return ErrNotFound
	}
	if len(bitmap) != bitmapLen(len(info.Cids)) {
		// A bitmap of the wrong length has bits that do not line up with the
		// chunk list, which would silently mark the wrong chunks delivered.
		return ErrBadID
	}
	dir, err := t.transferDir(id)
	if err != nil {
		return err
	}
	p := filepath.Join(dir, progressName(node))

	t.recMu.Lock()
	defer t.recMu.Unlock()
	// Measured but not admitted against the quota, for the reason writeMetaJSON
	// gives: the file is one bounded bitmap per recipient, and refusing it on a
	// full disk would strand the transfer that is trying to finish. The
	// measurement still has to happen, because removing the transfer later gives
	// these bytes back and a total that never took them in would drift low.
	before := fileSize(p)
	if err := atomicWrite(p, bitmap); err != nil {
		return err
	}
	t.recUsed += fileSize(p) - before
	return nil
}

// Progress reports what a recipient has staged. A recipient that has written
// nothing yet is not an error: it has nothing, which is what an empty bitmap
// says.
//
// caller and node are different people. caller is the authenticated device
// asking, and it must be able to see the transfer at all. node is whose progress
// is being read, which a sender legitimately asks about for each of its
// recipients.
//
// The scoping is not optional just because a transfer id is 128 random bits.
// Treating an unguessable id as the only control is a capability URL, and it
// stops being a control the first time an id reaches a log, a screenshot, or a
// bug report.
func (t *Transfers) Progress(id, caller, node string) ([]byte, error) {
	info, err := t.Get(id)
	if err != nil {
		return nil, err
	}
	if !visibleTo(info.Sender, info.To, caller) {
		return nil, ErrNotFound
	}
	return t.progressOf(id, node)
}

// progressOf is the unscoped read. Expiry and completeness checks are the
// server's own work rather than something done for a device, so they go through
// here, exactly as the sweep goes through remove rather than Delete.
func (t *Transfers) progressOf(id, node string) ([]byte, error) {
	dir, err := t.transferDir(id)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(dir, progressName(node)))
	if errors.Is(err, os.ErrNotExist) {
		return []byte{}, nil
	}
	return b, err
}

// Queue is what this node still owes: transfers it sent where some recipient is
// missing at least one chunk. Opening the app and draining this is how a
// transfer completes without the sender having to sit and wait.
func (t *Transfers) Queue(sender string) ([]*TransferInfo, error) {
	all, err := t.list()
	if err != nil {
		return nil, err
	}
	out := []*TransferInfo{}
	for _, info := range all {
		if info.Sender != sender {
			continue
		}
		if t.fullyDelivered(info) {
			continue
		}
		out = append(out, info)
	}
	return out, nil
}

func (t *Transfers) fullyDelivered(info *TransferInfo) bool {
	// An unaddressed transfer has no fixed recipient set, so there is no point
	// at which it is provably delivered to everyone. It leaves the queue on its
	// TTL like anything else.
	if len(info.To) == 0 {
		return false
	}
	want := bitmapLen(len(info.Cids))
	for _, node := range info.To {
		if contains(info.Declined, node) {
			continue
		}
		bitmap, err := t.progressOf(info.ID, node)
		if err != nil || len(bitmap) != want {
			return false
		}
		for i := range info.Cids {
			if bitmap[i/8]&(1<<(i%8)) == 0 {
				return false
			}
		}
	}
	return true
}

// Delete removes a transfer on behalf of a device. A caller that cannot see the
// transfer gets ErrNotFound rather than a distinct error, so the endpoint never
// confirms the existence of a transfer the caller has no business knowing about.
func (t *Transfers) Delete(id, node string) error {
	info, err := t.Get(id)
	if err != nil {
		return err
	}
	if !visibleTo(info.Sender, info.To, node) {
		return ErrNotFound
	}
	return t.remove(info)
}

// Decline records that a device does not want this transfer.
//
// It hides the transfer from that device. If the transfer named its recipients
// and every one of them has declined, it is deleted outright, because nobody is
// left who could collect it. An unaddressed transfer is not deleted by a single
// refusal, since every device was equally its destination; it stops appearing
// for the decliner and expires on the usual clock.
//
// ponytail: the read and the rewrite are not one atomic step, so two devices
// declining at the same instant can lose one of the two entries, and a transfer
// every addressee refused then waits out its TTL instead of going immediately.
// Two people refusing the same transfer within one filesystem write of each
// other is not a case a personal node meets. Take a per-transfer lock across
// the read and the write if it ever does.
func (t *Transfers) Decline(id, node string) error {
	info, err := t.Get(id)
	if err != nil {
		return err
	}
	if !visibleTo(info.Sender, info.To, node) {
		return ErrNotFound
	}
	if contains(info.Declined, node) {
		return nil
	}

	rec := info.Transfer
	rec.Declined = append(append([]string{}, info.Declined...), node)

	dir, err := t.transferDir(id)
	if err != nil {
		return err
	}
	if err := t.writeMetaJSON(dir, &rec); err != nil {
		return err
	}

	if len(rec.To) > 0 && allDeclined(rec.To, rec.Declined) {
		info.Transfer = rec
		return t.remove(info)
	}
	return nil
}

func allDeclined(to, declined []string) bool {
	for _, node := range to {
		if !contains(declined, node) {
			return false
		}
	}
	return true
}

// writeMetaJSON republishes a transfer's meta.json, the server's own record of
// the transfer, and not the sealed "meta" record a client uploads. It keeps the
// record budget honest by measuring what actually landed, the way PutRecord
// does. The rewrite is deliberately not admitted against the quota: it grows
// the file by one node name, and refusing it would leave a full disk with no
// way to decline its way back out.
func (t *Transfers) writeMetaJSON(dir string, rec *Transfer) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	p := filepath.Join(dir, "meta.json")

	t.recMu.Lock()
	defer t.recMu.Unlock()
	before := fileSize(p)
	if err := atomicWrite(p, b); err != nil {
		return err
	}
	t.recUsed += fileSize(p) - before
	return nil
}

// remove is the unscoped deletion. Expiry is the server's own action rather than
// one performed for a device, so the sweep goes through here and the visibility
// rule does not block it. Were expiry to run through Delete instead, a transfer
// addressed to a device that never comes back would live forever.
func (t *Transfers) remove(info *TransferInfo) error {
	if err := t.appendTombstone(info); err != nil {
		return err
	}
	dir, err := t.transferDir(info.ID)
	if err != nil {
		return err
	}
	return t.removeTree(dir)
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
		ID: info.ID, Sender: info.Sender, To: info.To, Declined: info.Declined,
		Meta:       info.Meta,
		ChunkCount: info.ChunkCount, CreatedAt: info.CreatedAt, EndedAt: time.Now().UTC(),
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

// History returns the tombstones this node may see, newest first. A tombstone
// carries the same sender and recipient list the transfer did, so it gets the
// same visibility rule: the filenames stay sealed either way, but which devices
// talk to each other is exactly the metadata these records exist to withhold.
func (t *Transfers) History(node string) ([]Tombstone, error) {
	t.histMu.Lock()
	defer t.histMu.Unlock()
	all, err := t.historyLocked()
	if err != nil {
		return nil, err
	}
	hist := make([]Tombstone, 0, len(all))
	for _, tomb := range all {
		if visibleTo(tomb.Sender, tomb.To, node) {
			hist = append(hist, tomb)
		}
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
			// Create publishes a transfer directory by rename, so one named by
			// a valid id always holds its id list. A read that fails here is a
			// directory a concurrent delete is removing, not a live transfer.
			continue
		}
		for _, id := range cids {
			ref[id] = true
		}
	}
	return ref, nil
}

// Sweep expires a transfer once nothing has written to its directory for the
// TTL. Writing a sealed record refreshes that clock by itself. A chunk upload
// does not, because chunks live in the shared store outside this tree, so the
// upload path has to call Touch; without that call a transfer's clock never
// moves and it expires one TTL after it was created, mid-upload or not.
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
		if strings.HasPrefix(e.Name(), tmpPrefix) {
			// A crash between the Mkdir and the publishing rename in Create
			// leaves one of these behind. It was never a transfer, so it earns
			// no tombstone and is not counted as swept.
			if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > t.ttl {
				t.removeTree(filepath.Join(t.dir, e.Name()))
			}
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
		info, err := t.Get(e.Name())
		if err != nil {
			continue
		}
		if t.remove(info) == nil {
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

// markAnnounced claims the right to announce a transfer, returning true to
// exactly one caller. Every write path asks, because the records and chunks of
// one transfer arrive in any order and any of them may be the write that makes
// the transfer describable.
func (t *Transfers) markAnnounced(id string) bool {
	t.annMu.Lock()
	defer t.annMu.Unlock()
	if t.announced[id] {
		return false
	}
	t.announced[id] = true
	return true
}

// forgetAnnounced drops the claim when a transfer goes away, so the set cannot
// grow without bound across a long-running server and a re-created id can
// announce again.
func (t *Transfers) forgetAnnounced(id string) {
	t.annMu.Lock()
	defer t.annMu.Unlock()
	delete(t.announced, id)
}
