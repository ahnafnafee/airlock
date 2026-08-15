package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"
)

var idRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

var (
	ErrNotFound = errors.New("not found")
	ErrBadIndex = errors.New("chunk index out of range")
	ErrQuota    = errors.New("storage quota exceeded")
	ErrTooLarge = errors.New("body exceeds the permitted size")
)

// maxManifestBytes bounds the sealed manifest. A filename is at most 255 bytes,
// so this is ample, and it is what keeps an inbox listing, which embeds every
// manifest, from growing without limit.
const maxManifestBytes = 8 << 10

// Meta is everything the server knows about a blob. The filename, MIME type and
// contents live inside the client-encrypted manifest, which the server stores as
// opaque bytes and never parses.
type Meta struct {
	ID         string    `json:"id"`
	ChunkCount int       `json:"chunkCount"`
	Sender     string    `json:"sender"`
	CreatedAt  time.Time `json:"createdAt"`
}

// Info is Meta plus the state derived from what is actually on disk.
type Info struct {
	Meta
	Have     []int  `json:"have"`
	Complete bool   `json:"complete"`
	EncMeta  string `json:"meta"` // base64 manifest, empty until uploaded
}

type Store struct {
	dir       string
	chunkSize int64
	maxBlob   int64
	maxTotal  int64
	ttl       time.Duration

	// createMu serializes the quota check against the directory creation that
	// commits to it. Without it, two concurrent creates read the same stale
	// usage and both pass.
	// ponytail: one lock, held only across Create. Chunk writes stay
	// unserialized, which is where the throughput is.
	createMu sync.Mutex
}

func NewStore(dir string, chunkSize, maxBlob, maxTotal int64, ttl time.Duration) (*Store, error) {
	if chunkSize < 1 {
		return nil, errors.New("chunk size must be positive")
	}
	if err := os.MkdirAll(filepath.Join(dir, "blobs"), 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir, chunkSize: chunkSize, maxBlob: maxBlob, maxTotal: maxTotal, ttl: ttl}, nil
}

// blobDir is the only place a blob id becomes a path. The regex is the entire
// defense against traversal, so nothing may join an id onto a path elsewhere.
func (s *Store) blobDir(id string) (string, error) {
	if !idRe.MatchString(id) {
		return "", ErrNotFound
	}
	return filepath.Join(s.dir, "blobs", id), nil
}

func (s *Store) Create(sender string, chunkCount int) (*Meta, error) {
	if chunkCount < 1 {
		return nil, ErrBadIndex
	}
	// Bound chunkCount by division before multiplying. Checking the product
	// instead overflows int64 for a large enough chunkCount and wraps to a
	// value that passes both quota tests.
	if int64(chunkCount) > s.maxBlob/s.chunkSize {
		return nil, ErrQuota
	}
	declared := int64(chunkCount) * s.chunkSize

	s.createMu.Lock()
	defer s.createMu.Unlock()

	used, err := s.usedBytes()
	if err != nil {
		return nil, err
	}
	if used+declared > s.maxTotal {
		return nil, ErrQuota
	}

	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, err
	}
	m := &Meta{
		ID:         hex.EncodeToString(raw[:]),
		ChunkCount: chunkCount,
		Sender:     sender,
		CreatedAt:  time.Now().UTC(),
	}
	dir, err := s.blobDir(m.ID)
	if err != nil {
		return nil, err
	}
	// Mkdir rather than MkdirAll: an id collision fails loudly instead of
	// overwriting somebody else's transfer.
	if err := os.Mkdir(dir, 0o700); err != nil {
		return nil, err
	}
	b, err := json.Marshal(m)
	if err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	// Roll back on failure, so a half-created blob cannot linger as a
	// permanently ErrNotFound directory that still counts against the quota.
	if err := atomicWrite(filepath.Join(dir, "meta.json"), b); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	return m, nil
}

// ponytail: full walk per create. Fine at a few hundred live blobs. Cache the
// running total in memory if the inbox ever holds thousands.
func (s *Store) usedBytes() (int64, error) {
	var total int64
	err := filepath.WalkDir(filepath.Join(s.dir, "blobs"), func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil // raced with a sweep; skip it
		}
		total += fi.Size()
		return nil
	})
	return total, err
}

func (s *Store) readMeta(dir string) (*Meta, error) {
	b, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var m Meta
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) PutMeta(id string, r io.Reader) error {
	dir, err := s.blobDir(id)
	if err != nil {
		return err
	}
	if _, err := s.readMeta(dir); err != nil {
		return err
	}
	return writeStream(filepath.Join(dir, "manifest"), r, maxManifestBytes)
}

func (s *Store) PutChunk(id string, n int, r io.Reader) error {
	dir, err := s.blobDir(id)
	if err != nil {
		return err
	}
	m, err := s.readMeta(dir)
	if err != nil {
		return err
	}
	if n < 0 || n >= m.ChunkCount {
		return ErrBadIndex
	}
	// 12 byte IV plus 16 byte tag is the ciphertext overhead; 64 is slack.
	return writeStream(filepath.Join(dir, strconv.Itoa(n)), r, s.chunkSize+64)
}

// writeStream lands the body in a temp file and renames it into place, so a
// dropped connection can never leave a truncated chunk that resume would
// mistake for a finished one. The limit is enforced here rather than only at
// the HTTP layer, because Create reserves quota from a projection of
// chunkCount times chunkSize, and that projection holds only if no single
// write can exceed its share.
func writeStream(path string, r io.Reader, limit int64) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	// Read one byte past the limit, so hitting it is distinguishable from a
	// body that merely ends there.
	n, err := io.Copy(f, io.LimitReader(r, limit+1))
	if err == nil && n > limit {
		err = ErrTooLarge
	}
	if err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func atomicWrite(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) Get(id string) (*Info, error) {
	dir, err := s.blobDir(id)
	if err != nil {
		return nil, err
	}
	m, err := s.readMeta(dir)
	if err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	info := &Info{Meta: *m, Have: []int{}}
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		// Only names that are plain integers in range are chunks. meta.json,
		// manifest and any .tmp leftovers are skipped by construction.
		if n, err := strconv.Atoi(e.Name()); err == nil && n >= 0 && n < m.ChunkCount {
			info.Have = append(info.Have, n)
		}
	}
	sort.Ints(info.Have)
	if b, err := os.ReadFile(filepath.Join(dir, "manifest")); err == nil {
		info.EncMeta = base64.StdEncoding.EncodeToString(b)
	}
	info.Complete = info.EncMeta != "" && len(info.Have) == m.ChunkCount
	return info, nil
}

func (s *Store) OpenChunk(id string, n int) (*os.File, error) {
	dir, err := s.blobDir(id)
	if err != nil {
		return nil, err
	}
	m, err := s.readMeta(dir)
	if err != nil {
		return nil, err
	}
	if n < 0 || n >= m.ChunkCount {
		return nil, ErrBadIndex
	}
	f, err := os.Open(filepath.Join(dir, strconv.Itoa(n)))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}
