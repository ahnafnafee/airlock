package main

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed web/index.html
var webFS embed.FS

var (
	authMode        = flag.String("auth", "tailscale", `authentication mode: "tailscale" or "token"`)
	dataDir         = flag.String("data", "./data", "data directory")
	hostname        = flag.String("hostname", "airlock", "tsnet node name")
	addr            = flag.String("addr", "127.0.0.1:8080", "listen address, token mode only")
	maxChunkBytes   = flag.Int64("max-chunk", 16<<20, "maximum bytes per chunk")
	maxTotalBytes   = flag.Int64("max-total", 200<<30, "maximum bytes stored across all chunks")
	maxChunksPer    = flag.Int("max-chunks-per-transfer", 200000, "maximum chunks in one transfer")
	maxRecordBytes  = flag.Int("max-record", 4<<20, "maximum bytes per sealed record")
	ttlHours        = flag.Int("ttl-hours", 24, "hours of inactivity before a transfer is swept")
	requireApproval = flag.Bool("require-approval", false, "hold new devices until an approved device admits them")
	vapidSubject    = flag.String("vapid-subject", "mailto:airlock@invalid", "VAPID subject")
	allowUsers      = flag.String("allow-users", "", "comma-separated tailnet logins allowed; empty means the server node's own owner")
)

// cdcDefaults are the chunking parameters the server hands every client. They
// live here rather than in the browser because two devices that cut the same
// file differently would produce disjoint ids, and dedup would stop working
// with no error to notice.
// The maximum is deliberately modest: the uploader runs four chunks in flight,
// so peak buffered memory is four times this, and a phone should not be asked
// to hold more than about 32 MB.
var cdcDefaults = CDCParams{
	Min:    512 << 10,
	Normal: 1 << 20,
	Max:    8 << 20,
	MaskS:  (1 << 22) - 1,
	MaskL:  (1 << 20) - 1,
}

func main() {
	flag.Parse()
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	// Go resolves MIME types from the Windows registry, which some machines map
	// to text/plain. A module script served as text/plain is refused outright,
	// so pin the types the app depends on.
	mime.AddExtensionType(".js", "text/javascript")
	mime.AddExtensionType(".webmanifest", "application/manifest+json")

	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		return err
	}
	salt, err := loadOrCreateSalt(filepath.Join(*dataDir, "salt"))
	if err != nil {
		return err
	}
	chunks, err := NewChunkStore(*dataDir, *maxChunkBytes, *maxTotalBytes)
	if err != nil {
		return err
	}
	transfers, err := NewTransfers(*dataDir, chunks, time.Duration(*ttlHours)*time.Hour, *maxChunksPer, *maxRecordBytes)
	if err != nil {
		return err
	}
	devices, err := NewDevices(*dataDir, !*requireApproval)
	if err != nil {
		return err
	}
	static, err := fs.Sub(webFS, "web")
	if err != nil {
		return err
	}
	pusher := &Pusher{}

	var ln net.Listener
	var ident IdentityFunc
	root := http.NewServeMux()

	switch *authMode {
	case "tailscale":
		ln, ident, err = tailscaleListener()
	case "token":
		token := os.Getenv("AIRLOCK_TOKEN")
		if token == "" {
			// Fail closed. There is no path from a missing credential to an
			// open listener.
			return errors.New("--auth=token requires AIRLOCK_TOKEN; refusing to start unauthenticated")
		}
		ln, err = net.Listen("tcp", *addr)
		ident = tokenIdentity(token)
		root.HandleFunc("GET /login", loginHandler(token))
	default:
		return fmt.Errorf("unknown --auth %q, want tailscale or token", *authMode)
	}
	if err != nil {
		return err
	}

	root.Handle("/", NewServer(ServerConfig{
		Chunks: chunks, Transfers: transfers, Devices: devices, Push: pusher,
		Ident: ident, DataDir: *dataDir, CDC: cdcDefaults,
		TTLHours: *ttlHours, Salt: salt, Static: static,
	}))

	go sweepLoop(transfers, chunks)
	log.Printf("airlock up: auth=%s addr=%s", *authMode, ln.Addr())
	return http.Serve(ln, root)
}

// loadOrCreateSalt returns the public PBKDF2 salt, generating it once. It is not
// a secret; its job is to stop precomputation shared across installations. It is
// permanent, though: every key on every device derives from it, so a salt that
// moved between restarts would leave every sealed record on disk unopenable.
// A file that is present but the wrong length is therefore an error to report
// rather than something to quietly replace.
func loadOrCreateSalt(path string) (string, error) {
	b, err := os.ReadFile(path)
	switch {
	case err == nil && len(b) == 16:
		return base64.StdEncoding.EncodeToString(b), nil
	case err == nil:
		return "", fmt.Errorf("salt file %s holds %d bytes, want 16; refusing to replace it", path, len(b))
	case !errors.Is(err, os.ErrNotExist):
		return "", err
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	if err := atomicWrite(path, raw[:]); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw[:]), nil
}

// tokenIdentity is the non-Tailscale fallback. It accepts a bearer header or the
// cookie set by /login, because a browser cannot attach a header to a top-level
// navigation.
func tokenIdentity(token string) IdentityFunc {
	want := []byte(token)
	return func(r *http.Request) (Identity, bool) {
		got := ""
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			got = strings.TrimPrefix(h, "Bearer ")
		} else if c, err := r.Cookie("airlock_token"); err == nil {
			got = c.Value
		}
		if subtle.ConstantTimeCompare([]byte(got), want) != 1 {
			return Identity{}, false
		}
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		return Identity{Node: host, User: "token"}, true
	}
}

func loginHandler(token string) http.HandlerFunc {
	want := []byte(token)
	return func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("t")), want) != 1 {
			http.Error(w, "bad token", http.StatusForbidden)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name: "airlock_token", Value: token, Path: "/",
			HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 365 * 24 * 3600,
		})
		http.Redirect(w, r, "/", http.StatusSeeOther)
	}
}

// sweepOnce expires transfers first, then deletes chunks nothing references any
// more. The order matters: collecting references before expiring transfers
// would spare chunks whose only referent was about to disappear, and reversing
// it entirely would delete chunks a live transfer still needs.
func sweepOnce(transfers *Transfers, chunks *ChunkStore) (int, int, error) {
	gone, err := transfers.Sweep(time.Now())
	if err != nil {
		return gone, 0, err
	}
	referenced, err := transfers.Referenced()
	if err != nil {
		return gone, 0, err
	}
	orphans, err := chunks.Sweep(referenced)
	return gone, orphans, err
}

func sweepLoop(transfers *Transfers, chunks *ChunkStore) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for range t.C {
		gone, orphans, err := sweepOnce(transfers, chunks)
		if err != nil {
			log.Printf("sweep: %v", err)
			continue
		}
		if gone > 0 || orphans > 0 {
			log.Printf("swept %d expired transfers and %d orphaned chunks", gone, orphans)
		}
	}
}

// tailscaleListener is replaced with the real implementation in Task 7.
func tailscaleListener() (net.Listener, IdentityFunc, error) {
	return nil, nil, errors.New("tailscale mode lands in Task 7; use --auth=token for now")
}
