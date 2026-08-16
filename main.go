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
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web/index.html web/tokens.css web/app.css web/api.js web/app.js web/crypto.js web/cdc.js web/upload.js web/strip.js web/thumb.js web/sw.js web/naming.js web/views
//go:embed web/peer.js web/staging.js web/stage-worker.js web/session.js web/wake.js
//go:embed web/sealpool.js web/seal-worker.js
//go:embed web/assemble.js web/assemble-worker.js web/export.js web/inbound.js web/ios.js
//go:embed web/manifest.webmanifest web/icon-192.png web/icon-512.png web/icon-maskable.png web/icon-badge.png
var webFS embed.FS

var (
	authMode        = flag.String("auth", "tailscale", `authentication mode: "tailscale" or "token"`)
	dataDir         = flag.String("data", defaultDataDir(), "data directory")
	hostname        = flag.String("hostname", "airlock", "tsnet node name")
	addr            = flag.String("addr", "127.0.0.1:8080", "listen address, token mode only")
	port            = flag.Int("port", 443, "HTTPS port on the tailnet address")
	maxChunkBytes   = flag.Int64("max-chunk", 16<<20, "maximum bytes per chunk")
	maxTotalBytes   = flag.Int64("max-total", 200<<30, "maximum bytes stored across all chunks")
	maxChunksPer    = flag.Int("max-chunks-per-transfer", 200000, "maximum chunks in one transfer")
	maxRecordBytes  = flag.Int("max-record", 4<<20, "maximum bytes per sealed record")
	ttlHours        = flag.Int("ttl-hours", 24, "hours of inactivity before a transfer is swept")
	requireApproval = flag.Bool("require-approval", false, "hold new devices until an approved device admits them")
	vapidSubject    = flag.String("vapid-subject", "mailto:airlock@invalid", "VAPID subject")
	allowUsers      = flag.String("allow-users", "", "comma-separated tailnet logins allowed; empty means the server node's own owner")
	tailscaleMode   = flag.String("tailscale-mode", "host",
		`"host" to serve through the machine's running tailscaled, or "embedded" for a self-contained tsnet node`)
	allowNodes = flag.String("allow-nodes", "",
		"comma-separated node names allowed; empty means any node of an allowed user")
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

// defaultDataDir picks a per-platform location so the binary works with no
// flags. A relative default breaks the moment something other than a shell
// starts it: a scheduled task inherits System32, a launch agent inherits /. The
// quiet failure is worse than the loud one, because a different working
// directory creates a fresh salt and an empty check.bin, which looks like data
// loss or a wrong passphrase rather than a path mistake.
func defaultDataDir() string {
	switch runtime.GOOS {
	case "windows":
		// LOCALAPPDATA rather than the Roaming profile that UserConfigDir
		// returns. A roaming profile would try to sync the whole store.
		if base, err := os.UserCacheDir(); err == nil {
			return filepath.Join(base, "Airlock")
		}
	case "darwin":
		if base, err := os.UserConfigDir(); err == nil {
			return filepath.Join(base, "Airlock")
		}
	default:
		if base := os.Getenv("XDG_DATA_HOME"); base != "" {
			return filepath.Join(base, "airlock")
		}
		if home, err := os.UserHomeDir(); err == nil {
			// Not ~/.config: this is bulk data, not configuration.
			return filepath.Join(home, ".local", "share", "airlock")
		}
	}
	return "data"
}

// listenAddrs pairs every tailnet address with the serving port. Binding only
// the first one leaves the tailnet IPv6 address dark, and a client that resolves
// to it fails with no diagnosis.
func listenAddrs(ips []string, port int) []string {
	out := make([]string, 0, len(ips))
	for _, ip := range ips {
		out = append(out, net.JoinHostPort(ip, strconv.Itoa(port)))
	}
	return out
}

// listenAll binds every address or none. A partial bind would present itself as
// a working server while one of the node's own addresses stayed dark, which is
// the failure this whole path exists to remove. port is named separately from
// the addresses only so the error can suggest the flag that fixes it.
func listenAll(addrs []string, port int) (net.Listener, error) {
	// Refused rather than tolerated: a listener over nothing has no address to
	// report, and Addr is on the net.Listener interface every caller may use.
	if len(addrs) == 0 {
		return nil, errors.New("no addresses to listen on")
	}
	lns := make([]net.Listener, 0, len(addrs))
	for _, a := range addrs {
		ln, err := net.Listen("tcp", a)
		if err != nil {
			for _, open := range lns {
				open.Close()
			}
			return nil, fmt.Errorf("cannot listen on %s: %w\n"+
				"Something else on this machine already holds port %d, often "+
				"tailscale serve. Start Airlock on a free port with --port.",
				a, err, port)
		}
		lns = append(lns, ln)
	}
	return newMultiListener(lns), nil
}

// multiListener presents several listeners as one, because http.Serve takes a
// single listener and a tailnet node has both an IPv4 and an IPv6 address.
type multiListener struct {
	lns    []net.Listener
	accept chan acceptResult
	done   chan struct{}
	once   sync.Once
}

type acceptResult struct {
	conn net.Conn
	err  error
}

func newMultiListener(lns []net.Listener) net.Listener {
	m := &multiListener{
		lns:    lns,
		accept: make(chan acceptResult),
		done:   make(chan struct{}),
	}
	for _, ln := range lns {
		go func(ln net.Listener) {
			for {
				conn, err := ln.Accept()
				select {
				case m.accept <- acceptResult{conn, err}:
				case <-m.done:
					if conn != nil {
						conn.Close()
					}
					return
				}
				if err != nil {
					// ponytail: any accept error retires this address, and
					// http.Serve then stops the whole server on the error it
					// was just handed. The ceiling is that a transient
					// per-socket error takes everything down instead of being
					// retried. Upgrade by retrying with a backoff when the
					// error reports Timeout, and surfacing only permanent ones.
					return
				}
			}
		}(ln)
	}
	return m
}

func (m *multiListener) Accept() (net.Conn, error) {
	select {
	case r := <-m.accept:
		return r.conn, r.err
	case <-m.done:
		return nil, net.ErrClosed
	}
}

func (m *multiListener) Close() error {
	var first error
	m.once.Do(func() {
		close(m.done)
		for _, ln := range m.lns {
			if err := ln.Close(); err != nil && first == nil {
				first = err
			}
		}
	})
	return first
}

// Addr reports the first bound address. net.Listener has room for exactly one,
// and the startup log prints the URL that actually works rather than this.
func (m *multiListener) Addr() net.Addr { return m.lns[0].Addr() }

// isLoopback reports whether a request arrived over the loopback interface,
// where no tailnet identity exists to derive. A hostname that is not an IP
// literal counts as not loopback: a proxied request carrying a name is the case
// this cannot decide, and refusing it here would be a guess.
func isLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return ip.IsLoopback()
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
	pusher, err := NewPusher(*dataDir, *vapidSubject)
	if err != nil {
		return err
	}
	events := NewEvents()

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
		Events: events, Ident: ident, DataDir: *dataDir, CDC: cdcDefaults,
		TTLHours: *ttlHours, Salt: salt, Static: static, Auth: *authMode,
	}))

	go sweepLoop(transfers, chunks)
	log.Printf("airlock up: auth=%s addr=%s", *authMode, ln.Addr())
	srv := &http.Server{
		Handler: root,
		// Headers must arrive promptly. The body deliberately has no deadline:
		// a chunk can be large and a phone's radio slow, and a transfer that is
		// making progress must not be cut off for taking a while. What bounds a
		// stalled body instead is that it no longer holds any lock, so it costs
		// one connection rather than every upload on the server.
		ReadHeaderTimeout: 20 * time.Second,
		// An idle connection that is never reused should not be held forever.
		// The event stream is a response in progress, not an idle connection, so
		// this does not touch it.
		IdleTimeout: 5 * time.Minute,
	}
	return srv.Serve(ln)
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
