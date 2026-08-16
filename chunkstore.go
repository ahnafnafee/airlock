package main

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

var cidRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

var (
	ErrNotFound = errors.New("not found")
	ErrQuota    = errors.New("storage quota exceeded")
	ErrTooLarge = errors.New("body exceeds the permitted size")
	ErrBadID    = errors.New("malformed id")
)

// ChunkStore holds sealed chunks addressed by their content-derived id. The
// same bytes uploaded twice, from any device and inside any transfer, occupy
// one file. That is what makes dedup, delta sync and resume the same mechanism.
type ChunkStore struct {
	dir           string
	maxChunkBytes int64
	maxTotalBytes int64

	// mu guards used and serializes the quota check against the write that
	// commits to it. Without it, concurrent writers both observe the same
	// stale total and both land.
	mu   sync.Mutex
	used int64
}

func NewChunkStore(dir string, maxChunkBytes, maxTotalBytes int64) (*ChunkStore, error) {
	if maxChunkBytes < 1 || maxTotalBytes < 1 {
		return nil, errors.New("chunk and total limits must be positive")
	}
	root := filepath.Join(dir, "chunks")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	c := &ChunkStore{dir: root, maxChunkBytes: maxChunkBytes, maxTotalBytes: maxTotalBytes}
	total, err := walkBytes(root)
	if err != nil {
		return nil, err
	}
	// The total is measured once at startup and maintained incrementally after.
	// Measuring rather than projecting is what keeps the quota honest: there is
	// no declared size for a write to exceed.
	c.used = total
	return c, nil
}

func walkBytes(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil // raced with a sweep
		}
		total += info.Size()
		return nil
	})
	return total, err
}

// path is the only place a chunk id becomes a filesystem path. Ids are sharded
// by their first two characters so no directory holds more than a few thousand
// entries.
func (c *ChunkStore) path(id string) (string, error) {
	if !cidRe.MatchString(id) {
		return "", ErrBadID
	}
	return filepath.Join(c.dir, id[:2], id), nil
}

func (c *ChunkStore) Has(id string) bool {
	p, err := c.path(id)
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func (c *ChunkStore) Missing(ids []string) []string {
	out := []string{}
	for _, id := range ids {
		if !c.Has(id) {
			out = append(out, id)
		}
	}
	return out
}

// Put is first-write-wins. A chunk id is derived from its content, so a second
// body under an existing id is either a client bug or an attempt to poison a
// chunk that other transfers already reference. Refusing the overwrite makes
// the first upload authoritative; downloads catch the rest by tag failure.
func (c *ChunkStore) Put(id string, r io.Reader) error {
	p, err := c.path(id)
	if err != nil {
		return err
	}
	if _, err := os.Stat(p); err == nil {
		_, _ = io.Copy(io.Discard, r)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}

	// A cheap rejection before spending any disk on a body that cannot fit. It
	// has to use the per-chunk maximum, because the real size is not known
	// until the body has been read, and it is only advisory: the authoritative
	// check is under the lock below, against the size that actually arrived.
	c.mu.Lock()
	over := c.used+c.maxChunkBytes > c.maxTotalBytes
	c.mu.Unlock()
	if over {
		return ErrQuota
	}

	// The body is read with no lock held. Holding one across this would put a
	// network transfer inside a process-wide critical section: uploads that the
	// client deliberately runs in parallel would serialize, and one phone that
	// stalled mid-chunk would block every upload from every device until its
	// connection died.
	tmp, size, err := writeTemp(p, r, c.maxChunkBytes)
	if err != nil {
		return err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	// Re-checked under the lock and against the size that arrived, because
	// several writers can pass the advisory check above at the same moment.
	if c.used+size > c.maxTotalBytes {
		os.Remove(tmp)
		return ErrQuota
	}
	// Another writer may have published this id while this body was in flight.
	// First write still wins, and counting these bytes too would charge the
	// budget for a chunk that is about to be discarded.
	if _, err := os.Stat(p); err == nil {
		os.Remove(tmp)
		return nil
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		return err
	}
	c.used += size
	return nil
}

func (c *ChunkStore) Open(id string) (*os.File, error) {
	p, err := c.path(id)
	if err != nil {
		return nil, err
	}
	f, err := openShared(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

func (c *ChunkStore) Used() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.used
}

// Sweep removes every chunk absent from referenced. Callers build that set from
// the plaintext id lists of every live transfer.
//
// ponytail: mark-and-sweep over the whole chunk directory each cycle. Move to a
// per-chunk refcount file if the sweep ever outlasts its interval.
func (c *ChunkStore) Sweep(referenced map[string]bool) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	swept := 0
	err := filepath.WalkDir(c.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if referenced[d.Name()] {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if os.Remove(p) == nil {
			c.used -= info.Size()
			swept++
		}
		return nil
	})
	if c.used < 0 {
		c.used = 0
	}
	return swept, err
}

// writeStream lands the body in a temp file and renames it into place, so a
// dropped connection can never leave a truncated chunk that a later Has() call
// would mistake for a complete one. The limit is enforced here rather than only
// at the HTTP layer, because the store owns the disk and a bound it cannot
// enforce itself is advisory.
// writeTemp streams r into a uniquely named temporary file beside path and
// returns that name and the number of bytes written. The caller renames it into
// place, which is what lets the read happen outside any lock.
//
// The name is unique per call rather than derived from path, because two
// devices can upload the same chunk id at the same moment and a shared
// temporary name would let each write part of the other's file, then publish
// the mixture under an id that no longer describes its contents.
func writeTemp(path string, r io.Reader, limit int64) (string, int64, error) {
	f, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return "", 0, err
	}
	tmp := f.Name()
	// Read one byte past the limit, so hitting it is distinguishable from a
	// body that merely ends there.
	n, err := io.Copy(f, io.LimitReader(r, limit+1))
	if err == nil && n > limit {
		err = ErrTooLarge
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(tmp)
		return "", 0, err
	}
	return tmp, n, nil
}

func writeStream(path string, r io.Reader, limit int64) error {
	tmp, _, err := writeTemp(path, r, limit)
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func atomicWrite(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}
