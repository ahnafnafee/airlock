package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
)

type Identity struct {
	Node string `json:"node"`
	User string `json:"user"`
}

// IdentityFunc resolves the verified caller behind a request. Returning false
// means unknown or unverifiable. This is a seam: production supplies a Tailscale
// WhoIs implementation, tests supply a fake, and the whole HTTP surface is
// testable without a tailnet.
type IdentityFunc func(*http.Request) (Identity, bool)

// CDCParams are the content-defined chunking parameters. The server owns them
// and hands them to every client, because two devices that cut the same file
// differently would produce disjoint chunk ids and dedup would quietly stop
// working with no error anywhere.
type CDCParams struct {
	Min    int    `json:"min"`
	Normal int    `json:"normal"`
	Max    int    `json:"max"`
	MaskS  uint32 `json:"maskS"`
	MaskL  uint32 `json:"maskL"`
}

type ServerConfig struct {
	Chunks    *ChunkStore
	Transfers *Transfers
	Devices   *Devices
	Push      *Pusher
	Ident     IdentityFunc
	DataDir   string
	CDC       CDCParams
	TTLHours  int
	Salt      string
	Static    fs.FS
}

type Server struct {
	cfg ServerConfig
	mux *http.ServeMux
}

func NewServer(cfg ServerConfig) *Server {
	s := &Server{cfg: cfg, mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *Server) routes() {
	files := http.FileServerFS(s.cfg.Static)
	g := s.gate

	s.mux.HandleFunc("GET /api/whoami", g(s.whoami))
	s.mux.HandleFunc("GET /api/config", g(s.config))
	s.mux.HandleFunc("POST /api/check", g(s.postCheck))

	s.mux.HandleFunc("GET /api/devices", g(s.listDevices))
	s.mux.HandleFunc("POST /api/devices/me/paired", g(s.markPaired))
	s.mux.HandleFunc("POST /api/devices/{node}/allow", g(s.setAllowed(true)))
	s.mux.HandleFunc("POST /api/devices/{node}/revoke", g(s.setAllowed(false)))

	// The file_handlers launch URL has to render the app rather than 404.
	s.mux.HandleFunc("GET /open", g(func(w http.ResponseWriter, r *http.Request) {
		clone := r.Clone(r.Context())
		clone.URL.Path = "/"
		files.ServeHTTP(w, clone)
	}))
	s.mux.HandleFunc("GET /", g(files.ServeHTTP))
}

type identKey struct{}

// gate runs before every handler, static assets included. There is deliberately
// no ungated route on this mux.
func (s *Server) gate(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := s.cfg.Ident(r)
		if !ok {
			http.Error(w, "not authorized", http.StatusForbidden)
			return
		}
		// The identity belongs to the connection, not to whoever asked the
		// browser to open it, so an allowlisted device browsing a hostile page
		// would otherwise carry its own authority into a forged request. A
		// cross-site POST needs no preflight and no readable response for its
		// side effect to land, and /api/check is write-once, so one such request
		// could seal a verifier nobody can decrypt. Browsers label the origin of
		// every request they make; non-browser callers such as curl and the
		// service worker send no label at all and are unaffected.
		if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
			http.Error(w, "cross-site request", http.StatusForbidden)
			return
		}
		// Registration is not authorization. Recording an unapproved device is
		// what lets the pairing screen offer it, and the allow flag is read from
		// the registry on every request so a revocation needs no restart and
		// there is no cached decision to expire.
		dev := s.cfg.Devices.Seen(id.Node, id.User)
		if !dev.Allowed {
			http.Error(w, "device not approved", http.StatusForbidden)
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), identKey{}, id)))
	}
}

func who(r *http.Request) Identity {
	v, _ := r.Context().Value(identKey{}).(Identity)
	return v
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// fail maps a store error onto a status code and reports whether it handled the
// request. Keeping the mapping in one place is what stops a new endpoint from
// leaking a 500 where a 404 belongs.
func fail(w http.ResponseWriter, err error) bool {
	var maxBytes *http.MaxBytesError
	switch {
	case err == nil:
		return false
	case errors.As(err, &maxBytes), errors.Is(err, ErrTooLarge):
		http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
	case errors.Is(err, ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, ErrBadID):
		http.Error(w, "malformed id", http.StatusBadRequest)
	case errors.Is(err, ErrQuota):
		http.Error(w, "storage quota exceeded", http.StatusInsufficientStorage)
	default:
		http.Error(w, "server error", http.StatusInternalServerError)
	}
	return true
}

func (s *Server) whoami(w http.ResponseWriter, r *http.Request) {
	id := who(r)
	paired := false
	for _, d := range s.cfg.Devices.List() {
		if d.Node == id.Node {
			paired = d.Paired
		}
	}
	// allowed is unconditionally true: the gate is the only way into this
	// handler, and it turns a disallowed device away before it gets here.
	writeJSON(w, http.StatusOK, map[string]any{
		"node": id.Node, "user": id.User, "allowed": true, "paired": paired,
	})
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	resp := map[string]any{
		"salt":     s.cfg.Salt,
		"cdc":      s.cfg.CDC,
		"ttlHours": s.cfg.TTLHours,
		"vapidKey": s.cfg.Push.PublicKey(),
		"check":    nil,
	}
	if b, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "check.bin")); err == nil {
		resp["check"] = base64.StdEncoding.EncodeToString(b)
	}
	writeJSON(w, http.StatusOK, resp)
}

// postCheck stores the passphrase verifier exactly once. O_EXCL makes that
// atomic rather than a read-then-write race between two devices setting up at
// the same moment.
func (s *Server) postCheck(w http.ResponseWriter, r *http.Request) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil || len(b) == 0 {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	name := filepath.Join(s.cfg.DataDir, "check.bin")
	f, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		http.Error(w, "check already set", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	// Every failure after the create has to remove the file, and the close has
	// to be checked rather than deferred and dropped. The file is the one-shot
	// resource this route exists to claim: an empty or truncated check.bin left
	// behind would answer every later attempt with 409 while offering the
	// clients a verifier no passphrase can open, with no way back through the
	// API.
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(name)
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	if err := f.Close(); err != nil {
		os.Remove(name)
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.cfg.Devices.List())
}

func (s *Server) markPaired(w http.ResponseWriter, r *http.Request) {
	if fail(w, s.cfg.Devices.SetPaired(who(r).Node)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) setAllowed(allowed bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		node := r.PathValue("node")
		if node == "" || len(node) > 128 {
			http.Error(w, "bad node", http.StatusBadRequest)
			return
		}
		if fail(w, s.cfg.Devices.SetAllowed(node, allowed)) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
