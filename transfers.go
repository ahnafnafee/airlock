package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math/bits"
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
	Held       bool      `json:"held,omitempty"`
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
	// How many chunks each device has written, for the devices that have
	// started. Carried with the list rather than left to the progress endpoint
	// alone, because that endpoint only ever answers a question somebody knew
	// to ask: a page opened after a save, or while looking at another view, has
	// no event coming and would show nothing at all. This is the state a fresh
	// render starts from, and the stream keeps it current from there.
	Saved map[string]int `json:"saved,omitempty"`
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
	Held       bool      `json:"held,omitempty"`
	Meta       string    `json:"meta"`
	ChunkCount int       `json:"chunkCount"`
	CreatedAt  time.Time `json:"createdAt"`
	EndedAt    time.Time `json:"endedAt"`
}

type transferLock struct {
	mu   sync.Mutex
	refs int
}

type Transfers struct {
	dir       string
	chunks    *ChunkStore
	ttl       time.Duration
	maxChunks int
	maxRecord int

	// treeMu serializes publishing a transfer with the reference snapshot and
	// chunk sweep. Without it, a sweep could snapshot first, then delete a chunk
	// just after a newly published transfer reported that chunk as deduplicated.
	treeMu sync.Mutex
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

	// lockMu guards a short-lived mutex per transfer. Delete and Decline hold only
	// their transfer's mutex across visibility read, rewrite and possible removal,
	// so terminal mutations cannot overlap while unrelated transfers proceed.
	lockMu sync.Mutex
	locks  map[string]*transferLock

	// recMu serializes record publication. The byte count itself lives beside
	// the chunk count under ChunkStore's mutex, because both kinds of file spend
	// the same disk budget and their admissions must be one atomic decision.
	recMu sync.Mutex
}

// chunkListBytes is what a transfer's sealed chunk list costs on the wire: one
// 32 byte hash per chunk, wrapped in the record framing the client applies.
//
// The 32 is web/crypto.js HASH_LEN and the 29 is its record header, a mode byte
// plus a 12 byte IV plus a 16 byte tag. They are restated here because the two
// halves cannot share a constant across the language boundary, and the test
// beside this pins the relationship so a change on one side fails on the other
// rather than being discovered by a transfer that dies after it was sealed.
const (
	chunkHashBytes   = 32
	recordFrameBytes = 1 + 12 + 16
)

func chunkListBytes(chunks int) int64 {
	return int64(chunks)*chunkHashBytes + recordFrameBytes
}

// chunksFittingRecord is the largest chunk count whose sealed list the record
// cap will still accept.
func chunksFittingRecord(maxRecord int) int {
	room := (int64(maxRecord) - recordFrameBytes) / chunkHashBytes
	if room < 1 {
		return 1
	}
	return int(room)
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
	// A transfer is named by its chunk list, and that list is one sealed record.
	// Admitting more chunks than the record cap can carry accepts a transfer whose
	// list can never be written, so every chunk is cut, sealed and staged and the
	// failure arrives at the last step, after all the work. The two limits are
	// configured independently, so the smaller one wins here rather than being
	// left for a large file to discover.
	if fits := chunksFittingRecord(maxRecordBytes); maxChunksPerTransfer > fits {
		log.Printf("max-chunks-per-transfer %d exceeds what max-record %d can list; using %d",
			maxChunksPerTransfer, maxRecordBytes, fits)
		maxChunksPerTransfer = fits
	}
	t := &Transfers{
		dir: root, chunks: chunks, ttl: ttl,
		maxChunks: maxChunksPerTransfer, maxRecord: maxRecordBytes,
		announced: map[string]bool{},
		locks:     map[string]*transferLock{},
	}
	chunks.setRecordsUsed(used)
	return t, nil
}

func (t *Transfers) lockTransfer(id string) func() {
	t.lockMu.Lock()
	lock := t.locks[id]
	if lock == nil {
		lock = &transferLock{}
		t.locks[id] = lock
	}
	lock.refs++
	t.lockMu.Unlock()

	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		t.lockMu.Lock()
		lock.refs--
		if lock.refs == 0 {
			delete(t.locks, id)
		}
		t.lockMu.Unlock()
	}
}

// releaseRecordBytes returns a removed directory's bytes to the shared budget.
func (t *Transfers) releaseRecordBytes(n int64) {
	t.recMu.Lock()
	defer t.recMu.Unlock()
	t.chunks.adjustRecords(-n)
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
	return t.create(sender, to, cids, false)
}

func (t *Transfers) CreateHeld(sender string, to, cids []string) (*Transfer, []string, error) {
	return t.create(sender, to, cids, true)
}

func (t *Transfers) create(sender string, to, cids []string, held bool) (*Transfer, []string, error) {
	if len(cids) > t.maxChunks {
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
		Held:       held,
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
	if err := t.chunks.reserveRecord(n); err != nil {
		return nil, nil, err
	}
	committed := false
	defer func() {
		if !committed {
			t.chunks.adjustRecords(-n)
		}
	}()

	// A transfer directory is built under a name that fails tidRe and published
	// by a single rename, so a directory named by a valid transfer id already
	// contains its id list. The publication lock also spans every reference
	// snapshot plus chunk sweep, closing the otherwise-small window in which a
	// newly published transfer could lose a deduplicated chunk.
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
	t.treeMu.Lock()
	err = os.Rename(tmp, dir)
	t.treeMu.Unlock()
	if err != nil {
		os.RemoveAll(tmp)
		return nil, nil, err
	}
	committed = true
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
	// The body may stream for a while, but only this transfer is held. A
	// terminal mutation must wait through publication so removeTree measures
	// and releases exactly the bytes that actually committed.
	unlock := t.lockTransfer(id)
	defer unlock()
	if _, err := os.Stat(filepath.Join(dir, "meta.json")); err != nil {
		return ErrNotFound
	}
	p := filepath.Join(dir, kind)

	// The record's length is not declared, so the cap is what has to be
	// reserved up front. This check is advisory and the one below the write is
	// authoritative, exactly as the chunk store does it.
	admitErr := t.chunks.canAddRecord(int64(t.maxRecord))
	if admitErr != nil {
		return admitErr
	}

	// Written with no process-wide lock held. The per-transfer lock above makes
	// terminal mutation wait without letting one stalled body block record
	// uploads for every other transfer.
	tmp, size, err := writeTemp(p, r, int64(t.maxRecord))
	if err != nil {
		return err
	}

	t.recMu.Lock()
	defer t.recMu.Unlock()
	if err := t.chunks.reserveRecord(size); err != nil {
		os.Remove(tmp)
		return err
	}
	before := fileSize(p)
	if err := os.Rename(tmp, p); err != nil {
		t.chunks.adjustRecords(-size)
		os.Remove(tmp)
		return err
	}
	t.chunks.adjustRecords(-before)
	return nil
}

// PutChunk keeps a chunk upload inside the same per-transfer transaction as a
// terminal mutation. Delete, final Decline, and expiry therefore either wait
// for this publication and reclaim it, or win first and prevent it from
// landing against a transfer that no longer exists.
func (t *Transfers) PutChunk(id, cid string, r io.Reader) error {
	unlock := t.lockTransfer(id)
	defer unlock()

	if err := t.touch(id); err != nil {
		return err
	}
	return t.chunks.Put(cid, r)
}

// touch refreshes a transfer's inactivity clock. It stays behind PutChunk so a
// caller cannot split liveness from the upload transaction again.
func (t *Transfers) touch(id string) error {
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
		// visibleTo admits the sender on purpose: a transfer this device sent
		// is one it may still delete, and this list is what the delete button
		// is attached to. Telling an arrival apart from a send is the view's
		// job, not this one's, and it has to be done there or a device offers
		// to save a file it is the source of.
		if !visibleTo(info.Sender, info.To, node) || contains(info.Declined, node) {
			continue
		}
		info.Saved = t.savedCounts(info, node)
		out = append(out, info)
	}
	return out, nil
}

// How far each other device has got with a transfer. Only the others: this
// device knows its own state without being told, and a row reporting a save
// back to the device performing it is noise.
//
// A device with nothing written is left out rather than reported as zero, so
// the map names devices that have actually started. Scoping is the caller's
// visibility of the transfer, already established above, which is the same rule
// the progress endpoint applies.
func (t *Transfers) savedCounts(info *TransferInfo, viewer string) map[string]int {
	dir, err := t.transferDir(info.ID)
	if err != nil {
		return nil
	}
	var saved map[string]int
	for _, who := range info.To {
		if who == viewer {
			continue
		}
		p := filepath.Join(dir, progressName(who))
		stat, err := os.Stat(p)
		if err != nil {
			continue
		}
		bitmap, err := t.progressOf(info.ID, who)
		if err != nil || len(bitmap) == 0 {
			continue
		}
		n := 0
		for _, b := range bitmap {
			n += bits.OnesCount8(b)
		}
		if n == 0 {
			continue
		}
		// A part-finished figure that has stopped moving is not evidence of a
		// save in progress; it is the last thing a device managed to say before
		// it stopped saying anything. A page closed or killed mid-save never
		// runs the code that would take its figure back, so the figure has to
		// be able to expire on its own or a row reports a file as nearly there
		// forever. A finished one never expires: that device has the file, and
		// that stays true however long ago it happened.
		if n < len(info.Cids) && time.Since(stat.ModTime()) > progressStale {
			continue
		}
		if saved == nil {
			saved = map[string]int{}
		}
		saved[who] = n
	}
	return saved
}

// How long an unfinished figure stands without being updated before it is
// treated as abandoned. Generously longer than the client's own one-a-second
// reporting, because a single chunk on a slow link can take a while and a save
// that is merely crawling must not be mistaken for one that has died.
const progressStale = 2 * time.Minute

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
	t.chunks.adjustRecords(fileSize(p) - before)
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

// Queue is what this node still owes directly. A transfer the server already
// holds in full needs no peer session. A direct transfer becomes actionable
// only after its metadata lands, then remains here until every fixed recipient
// records all of its chunks. This keeps a failed create/upload rollback from
// poisoning every later queue drain with a transfer no recipient can describe.
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
		if info.Held {
			continue
		}
		if info.Meta == "" {
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
	// The held path is already deliverable without the sender. Keeping it in the
	// direct queue would make the sender look for a local stage that this path
	// deliberately never created.
	if info.Complete {
		return true
	}
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
	unlock := t.lockTransfer(id)
	defer unlock()

	info, err := t.Get(id)
	if err != nil {
		return err
	}
	if !visibleTo(info.Sender, info.To, node) {
		return ErrNotFound
	}
	if err := t.remove(info); err != nil {
		return err
	}
	t.reclaimChunksAfterTerminal()
	return nil
}

// Decline records that a device does not want this transfer.
//
// It hides the transfer from that device. If the transfer named its recipients
// and every one of them has declined, it is deleted outright, because nobody is
// left who could collect it. An unaddressed transfer is not deleted by a single
// refusal, since every device was equally its destination; it stops appearing
// for the decliner and expires on the usual clock.
func (t *Transfers) Decline(id, node string) error {
	unlock := t.lockTransfer(id)
	defer unlock()

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
		if err := t.remove(info); err != nil {
			return err
		}
		t.reclaimChunksAfterTerminal()
		return nil
	}
	return nil
}

// reclaimChunksAfterTerminal is prompt but best-effort. remove has already
// committed the tombstone and removed the transfer, so a reclamation failure
// must not make a caller retry that terminal mutation or suppress its lifecycle
// nudge. The periodic mark-and-sweep retries any orphan left behind.
func (t *Transfers) reclaimChunksAfterTerminal() {
	_, _ = t.sweepChunks()
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
	t.chunks.adjustRecords(fileSize(p) - before)
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
		Held:       info.Held,
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
	t.treeMu.Lock()
	defer t.treeMu.Unlock()
	return t.referenced()
}

func (t *Transfers) referenced() (map[string]bool, error) {
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

// sweepChunks keeps the reference snapshot and deletion in one publication
// critical section. A Create either publishes before the snapshot and is
// included, or publishes after the sweep and cannot upload a chunk too early.
func (t *Transfers) sweepChunks() (int, error) {
	t.treeMu.Lock()
	defer t.treeMu.Unlock()
	referenced, err := t.referenced()
	if err != nil {
		return 0, err
	}
	return t.chunks.Sweep(referenced)
}

// Sweep expires a transfer once nothing has written to its directory for the
// TTL. Writing a sealed record refreshes that clock by itself. A chunk upload
// does not, because chunks live in the shared store outside this tree, so
// PutChunk refreshes it inside the upload transaction. Without that refresh a
// transfer expires one TTL after creation, mid-upload or not.
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

		// Delete and Decline use this same per-transfer lock from their visibility
		// read through removal. Expiry joins them, then checks the clock again:
		// the candidate may have been refreshed or removed while Sweep waited.
		func() {
			unlock := t.lockTransfer(e.Name())
			defer unlock()
			last, err := newestMTime(dir)
			if err != nil || now.Sub(last) <= t.ttl {
				return
			}
			info, err := t.Get(e.Name())
			if err != nil {
				return
			}
			if t.remove(info) == nil {
				swept++
			}
		}()
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
// exactly one caller. Every record write asks because metadata and the sealed
// chunk list can arrive in either order, and metadata is the write that first
// makes the transfer describable.
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
