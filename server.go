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

	s.mux.HandleFunc("POST /api/transfer", g(s.createTransfer))
	s.mux.HandleFunc("GET /api/transfer/{id}", g(s.getTransfer))
	s.mux.HandleFunc("DELETE /api/transfer/{id}", g(s.deleteTransfer))
	s.mux.HandleFunc("PUT /api/transfer/{id}/{kind}", g(s.putRecord))
	s.mux.HandleFunc("GET /api/transfer/{id}/{kind}", g(s.getRecord))
	s.mux.HandleFunc("PUT /api/chunk/{cid}", g(s.putChunk))
	s.mux.HandleFunc("GET /api/chunk/{cid}", g(s.getChunk))
	s.mux.HandleFunc("GET /api/inbox", g(s.inbox))
	s.mux.HandleFunc("GET /api/history", g(s.history))

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

// createTransfer is the whole dedup, delta-sync and resume mechanism. The client
// sends every chunk id it computed; the server answers with the subset it does
// not already hold, and the client uploads only those.
func (s *Server) createTransfer(w http.ResponseWriter, r *http.Request) {
	// Only cids and to are read. The sender and the transfer id come from the
	// server, so a client can forge neither.
	var req struct {
		Cids []string `json:"cids"`
		To   []string `json:"to"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	rec, missing, err := s.cfg.Transfers.Create(who(r).Node, req.To, req.Cids)
	if fail(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": rec.ID, "missing": missing})
}

func (s *Server) getTransfer(w http.ResponseWriter, r *http.Request) {
	info, err := s.cfg.Transfers.Get(r.PathValue("id"))
	if fail(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) deleteTransfer(w http.ResponseWriter, r *http.Request) {
	if fail(w, s.cfg.Transfers.Delete(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) putRecord(w http.ResponseWriter, r *http.Request) {
	id, kind := r.PathValue("id"), r.PathValue("kind")
	body := http.MaxBytesReader(w, r.Body, 1<<20)
	if fail(w, s.cfg.Transfers.PutRecord(id, kind, body)) {
		return
	}
	s.notifyIfComplete(id, who(r).Node)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getRecord(w http.ResponseWriter, r *http.Request) {
	f, err := s.cfg.Transfers.OpenRecord(r.PathValue("id"), r.PathValue("kind"))
	if fail(w, err) {
		return
	}
	defer f.Close()
	serveFile(w, r, f)
}

func (s *Server) putChunk(w http.ResponseWriter, r *http.Request) {
	// The store's own limit is authoritative for a chunk that lands. This reader
	// bounds the body itself, which is what matters on the dedup path where the
	// store discards an already-held chunk's bytes rather than measuring them.
	body := http.MaxBytesReader(w, r.Body, s.cfg.Chunks.maxChunkBytes+1024)
	if fail(w, s.cfg.Chunks.Put(r.PathValue("cid"), body)) {
		return
	}
	// ponytail: a chunk that lands after both sealed records completes its
	// transfer without waking anyone, because this route carries a chunk id and
	// no transfer id, and one chunk can belong to any number of transfers. Thread
	// the transfer id through the upload (a query parameter is enough) and call
	// notifyIfComplete and Transfers.Touch here.
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getChunk(w http.ResponseWriter, r *http.Request) {
	f, err := s.cfg.Chunks.Open(r.PathValue("cid"))
	if fail(w, err) {
		return
	}
	defer f.Close()
	serveFile(w, r, f)
}

func serveFile(w http.ResponseWriter, r *http.Request, f *os.File) {
	info, err := f.Stat()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// notifyIfComplete fires a push once the last piece of a transfer lands. The
// two sealed records can arrive in either order, so both writes call this and
// whichever one finds the transfer complete wins.
func (s *Server) notifyIfComplete(id, sender string) {
	info, err := s.cfg.Transfers.Get(id)
	if err != nil || !info.Complete {
		return
	}
	go s.cfg.Push.Notify(info.To, sender)
}

func (s *Server) inbox(w http.ResponseWriter, r *http.Request) {
	list, err := s.cfg.Transfers.Inbox(who(r).Node)
	if fail(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	hist, err := s.cfg.Transfers.History()
	if fail(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, hist)
}
