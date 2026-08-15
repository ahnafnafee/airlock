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
	"time"
)

var idRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

var (
	ErrNotFound = errors.New("not found")
	ErrBadIndex = errors.New("chunk index out of range")
	ErrQuota    = errors.New("storage quota exceeded")
)

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
}

func NewStore(dir string, chunkSize, maxBlob, maxTotal int64, ttl time.Duration) (*Store, error) {
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
	// Reserve against the declared upper bound rather than metering as bytes
	// land, so an over-quota transfer is refused before it costs anything.
	declared := int64(chunkCount) * s.chunkSize
	if declared > s.maxBlob {
		return nil, ErrQuota
	}
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
		return nil, err
	}
	return m, atomicWrite(filepath.Join(dir, "meta.json"), b)
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
	return writeStream(filepath.Join(dir, "manifest"), r)
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
	return writeStream(filepath.Join(dir, strconv.Itoa(n)), r)
}

// writeStream lands the body in a temp file and renames it into place, so a
// dropped connection can never leave a truncated chunk that resume would
// mistake for a finished one.
func writeStream(path string, r io.Reader) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
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
