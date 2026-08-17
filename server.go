package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Identity struct {
	Node string `json:"node"`
	User string `json:"user"`
	// Addr is the caller's tailnet address, when the tailnet is what proved
	// them. It is empty under token auth, where the node name is already the
	// address the request came from and repeating it would say nothing.
	Addr string `json:"addr,omitempty"`
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
	Events    *Events
	Ident     IdentityFunc
	DataDir   string
	CDC       CDCParams
	TTLHours  int
	Salt      string
	Static    fs.FS
	// Auth names what proves a caller: "tailscale" or "token". The client says
	// different things about who a device belongs to depending on the answer,
	// and a claim about Tailscale on a server not using it is simply false.
	Auth string
}

type Server struct {
	cfg    ServerConfig
	mux    *http.ServeMux
	pushMu sync.Mutex
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

	// Reachable before approval so a new device can render the pairing screen
	// rather than an error. It reports the approval rather than assuming it.
	s.mux.HandleFunc("GET /api/whoami", s.identified(s.whoami))
	s.mux.HandleFunc("GET /api/config", g(s.config))
	s.mux.HandleFunc("POST /api/check", g(s.postCheck))

	s.mux.HandleFunc("GET /api/devices", g(s.listDevices))
	s.mux.HandleFunc("POST /api/devices/me/paired", g(s.markPaired))
	s.mux.HandleFunc("POST /api/devices/{node}/allow", g(s.setAllowed(true)))
	s.mux.HandleFunc("POST /api/devices/{node}/revoke", g(s.setAllowed(false)))

	s.mux.HandleFunc("POST /api/transfer", g(s.createTransfer))
	s.mux.HandleFunc("GET /api/transfer/{id}", g(s.getTransfer))
	s.mux.HandleFunc("DELETE /api/transfer/{id}", g(s.deleteTransfer))
	s.mux.HandleFunc("POST /api/transfer/{id}/decline", g(s.declineTransfer))
	// A literal last segment is more specific than the {kind} record patterns
	// below, so these win and "progress" never reaches the record handlers,
	// which admit only a closed set of kinds and would reject it.
	s.mux.HandleFunc("PUT /api/transfer/{id}/progress", g(s.putProgress))
	s.mux.HandleFunc("GET /api/transfer/{id}/progress", g(s.getProgress))
	s.mux.HandleFunc("PUT /api/transfer/{id}/{kind}", g(s.putRecord))
	s.mux.HandleFunc("GET /api/transfer/{id}/{kind}", g(s.getRecord))
	s.mux.HandleFunc("PUT /api/chunk/{cid}", g(s.putChunk))
	s.mux.HandleFunc("GET /api/chunk/{cid}", g(s.getChunk))
	s.mux.HandleFunc("GET /api/inbox", g(s.inbox))
	s.mux.HandleFunc("GET /api/queue", g(s.queue))
	s.mux.HandleFunc("GET /api/history", g(s.history))
	s.mux.HandleFunc("POST /api/push/subscribe", g(s.subscribe))
	s.mux.HandleFunc("GET /api/events", g(s.events))
	s.mux.HandleFunc("GET /api/presence", g(s.presence))
	s.mux.HandleFunc("POST /api/signal", g(s.signal))

	// The file_handlers launch URL has to render the app rather than 404.
	s.mux.HandleFunc("GET /open", s.open(func(w http.ResponseWriter, r *http.Request) {
		clone := r.Clone(r.Context())
		clone.URL.Path = "/"
		files.ServeHTTP(w, clone)
	}))
	s.mux.HandleFunc("GET /", s.open(files.ServeHTTP))
}

type identKey struct{}

// crossSiteBlocked reports whether a browser has labelled this request as coming
// from another origin in a way that must not be honored.
//
// The identity here belongs to the connection rather than to whoever asked the
// browser to open it, so an allowlisted device browsing a hostile page would
// otherwise carry its own authority into a forged request. A cross-site POST
// needs no preflight and no readable response for its side effect to land, and
// /api/check is write-once, so one such request could seal a verifier nobody
// can decrypt.
//
// Following a link is not that attack. A top-level navigation that only reads
// is how anyone opens the app at all, whether from a chat message, a bookmark,
// a QR code, or the tailnet device list, and turning those away makes the
// address unusable rather than safe. So a document navigation with a safe
// method is allowed from any origin and everything else must be same-origin.
// Framing stays blocked because an embedded page is labelled iframe rather than
// document.
//
// Non-browser callers such as curl and the service worker send no label at all
// and are unaffected.
func crossSiteBlocked(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
		return false
	}
	topLevel := r.Header.Get("Sec-Fetch-Mode") == "navigate" &&
		r.Header.Get("Sec-Fetch-Dest") == "document"
	safe := r.Method == http.MethodGet || r.Method == http.MethodHead
	return !topLevel || !safe
}

// gate guards everything that holds data. The allow flag is read from the
// registry on every request, so a revocation needs no restart and there is no
// cached decision to expire.
func (s *Server) gate(h http.HandlerFunc) http.HandlerFunc {
	return s.identified(func(w http.ResponseWriter, r *http.Request) {
		id := who(r)
		// A read, not a second registration. identified has already recorded this
		// device on the way in, and asking again wrote the whole registry to disk
		// a second time for every gated request.
		if !s.cfg.Devices.Allowed(id.Node) {
			http.Error(w, "device not approved", http.StatusForbidden)
			return
		}
		h(w, r)
	})
}

// identified resolves the caller and records the device without requiring it to
// be approved. Registration is not authorization: recording an unapproved
// device is what lets an approved one offer it on the pairing screen, and a
// device that has just appeared has to be able to read back that it is waiting.
// Without that it would have no way to say so, and its owner would meet a bare
// error where the pairing screen belongs.
func (s *Server) identified(h http.HandlerFunc) http.HandlerFunc {
	return s.open(func(w http.ResponseWriter, r *http.Request) {
		id, ok := s.cfg.Ident(r)
		if !ok {
			http.Error(w, "not authorized", http.StatusForbidden)
			return
		}
		_, registered := s.cfg.Devices.seen(id.Node, id.User, id.Addr)
		if registered {
			s.cfg.Events.PublishDevices()
		}
		h(w, r.WithContext(context.WithValue(r.Context(), identKey{}, id)))
	})
}

// open serves the app shell and its assets: the same bytes for everyone, with
// no transfer, chunk or device state among them.
//
// These cannot be gated on identity even in principle. A module service
// worker's script request is issued with credentials omitted, so the session
// cookie is not attached and an already-authenticated page still could not
// register its own worker. Anything that holds data goes through gate instead.
func (s *Server) open(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if crossSiteBlocked(r) {
			http.Error(w, "cross-site request", http.StatusForbidden)
			return
		}
		// The assets are embedded in the binary and carry no version in their
		// names, so nothing distinguishes one build's app.js from the next.
		// Embedding also leaves every file with a zero modification time, which
		// gives a browser no validator to ask about and licenses it to guess a
		// lifetime instead. Together those mean an upgraded server would keep
		// serving the old client until somebody thought to reload by hand.
		w.Header().Set("Cache-Control", "no-cache")
		h(w, r)
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
	paired, allowed := false, false
	for _, d := range s.cfg.Devices.List() {
		if d.Node == id.Node {
			paired, allowed = d.Paired, d.Allowed
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"node": id.Node, "user": id.User, "addr": id.Addr,
		"allowed": allowed, "paired": paired,
	})
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	resp := map[string]any{
		"auth":     s.cfg.Auth,
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
	s.cfg.Events.PublishDevices()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) setAllowed(allowed bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		node := r.PathValue("node")
		if node == "" || len(node) > 128 {
			http.Error(w, "bad node", http.StatusBadRequest)
			return
		}
		// A subscribe request can pass the gate and then spend time reading its
		// body. Serialize its final admission with this state change so it cannot
		// recreate an endpoint after revocation has removed it.
		s.pushMu.Lock()
		defer s.pushMu.Unlock()
		if !allowed {
			// Persist push removal first. If it cannot be saved, leaving the node
			// allowed and returning an error is safer than recording a revocation
			// while a generic push path can still reach that device after restart.
			if fail(w, s.cfg.Push.RemoveNode(node)) {
				return
			}
		}
		if fail(w, s.cfg.Devices.SetAllowed(node, allowed)) {
			return
		}
		if !allowed {
			s.cfg.Events.Disconnect(node)
		}
		s.cfg.Events.PublishDevices()
		w.WriteHeader(http.StatusNoContent)
	}
}

// createTransfer is the whole dedup, delta-sync and resume mechanism. The client
// sends every chunk id it computed; the server answers with the subset it does
// not already hold, and the client uploads only those.
func (s *Server) createTransfer(w http.ResponseWriter, r *http.Request) {
	// Only cids, to and the delivery path are read. The sender and transfer id come from the
	// server, so a client can forge neither.
	var req struct {
		Cids []string `json:"cids"`
		To   []string `json:"to"`
		Held bool     `json:"held"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	sender := who(r).Node
	if !req.Held {
		if len(req.To) == 0 {
			http.Error(w, "direct transfer requires a recipient", http.StatusBadRequest)
			return
		}
		for _, recipient := range req.To {
			if recipient == sender {
				http.Error(w, "direct transfer cannot target its sender", http.StatusBadRequest)
				return
			}
		}
	}
	var rec *Transfer
	var missing []string
	var err error
	if req.Held {
		rec, missing, err = s.cfg.Transfers.CreateHeld(sender, req.To, req.Cids)
	} else {
		rec, missing, err = s.cfg.Transfers.Create(sender, req.To, req.Cids)
	}
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
	info, err := s.cfg.Transfers.Get(r.PathValue("id"))
	if fail(w, err) {
		return
	}
	if fail(w, s.cfg.Transfers.Delete(r.PathValue("id"), who(r).Node)) {
		return
	}
	s.cfg.Events.Nudge(transferParties(info))
	w.WriteHeader(http.StatusNoContent)
}

// transferParties names every fixed device whose view changes with a transfer.
// A nil result preserves broadcast semantics for an unaddressed held transfer.
func transferParties(info *TransferInfo) []string {
	if len(info.To) == 0 {
		return nil
	}
	parties := make([]string, 0, len(info.To)+1)
	parties = append(parties, info.Sender)
	return append(parties, info.To...)
}

// declineTransfer refuses a transfer on behalf of the calling device. A refusal
// has to be recorded on the server: a button that only closed a notification
// would leave the transfer occupying the quota and waiting in the next inbox.
func (s *Server) declineTransfer(w http.ResponseWriter, r *http.Request) {
	info, err := s.cfg.Transfers.Get(r.PathValue("id"))
	if fail(w, err) {
		return
	}
	if fail(w, s.cfg.Transfers.Decline(r.PathValue("id"), who(r).Node)) {
		return
	}
	s.cfg.Events.Nudge(transferParties(info))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) putRecord(w http.ResponseWriter, r *http.Request) {
	id, kind := r.PathValue("id"), r.PathValue("kind")
	// The store's maxRecord is the authority and it is configurable, so the
	// reader's cap is derived from it rather than restated. A cap written down
	// here would silently become the real limit the moment the two disagreed,
	// and a chunklist grows with the transfer: 32 raw bytes per chunk means a
	// large transfer's list runs to megabytes. The headroom leaves the
	// oversize verdict to writeStream, which returns ErrTooLarge.
	body := http.MaxBytesReader(w, r.Body, int64(s.cfg.Transfers.maxRecord)+1024)
	if fail(w, s.cfg.Transfers.PutRecord(id, kind, body)) {
		return
	}
	s.announce(id, who(r).Node)
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

// putProgress records the caller's own progress. The node comes from the gate's
// verified identity rather than the body, so no device can claim delivery on
// another's behalf.
func (s *Server) putProgress(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if fail(w, err) {
		return
	}
	if fail(w, s.cfg.Transfers.SetProgress(r.PathValue("id"), who(r).Node, body)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getProgress(w http.ResponseWriter, r *http.Request) {
	// Two different nodes. The caller is the authenticated device asking, and it
	// has to be able to see the transfer at all. The node parameter is whose
	// progress is being read, which a sender legitimately asks about for each of
	// its recipients.
	node := r.URL.Query().Get("node")
	if node == "" {
		node = who(r).Node
	}
	bitmap, err := s.cfg.Transfers.Progress(r.PathValue("id"), who(r).Node, node)
	if fail(w, err) {
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(bitmap)
}

func (s *Server) queue(w http.ResponseWriter, r *http.Request) {
	list, err := s.cfg.Transfers.Queue(who(r).Node)
	if fail(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// putChunk stores one sealed chunk on behalf of a named transfer. The transfer
// id is a required query parameter rather than a second path segment because a
// chunk is content addressed and shared: the same bytes can belong to any
// number of transfers, so the id names the upload this request is part of, not
// an owner of the data. The transfer id refreshes the inactivity clock because
// chunks live in the shared store outside the transfer directory and an upload
// leaves that directory's mtime untouched. Without it, a long upload could be
// swept out from under itself.
func (s *Server) putChunk(w http.ResponseWriter, r *http.Request) {
	tid := r.URL.Query().Get("transfer")
	if !tidRe.MatchString(tid) {
		http.Error(w, "malformed transfer id", http.StatusBadRequest)
		return
	}
	// The store's own limit is authoritative for a chunk that lands. This reader
	// bounds the body itself, which is what matters on the dedup path where the
	// store discards an already-held chunk's bytes rather than measuring them.
	body := http.MaxBytesReader(w, r.Body, s.cfg.Chunks.maxChunkBytes+1024)
	if fail(w, s.cfg.Transfers.PutChunk(tid, r.PathValue("cid"), body)) {
		return
	}
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

// announce tells the addressees a transfer is waiting, once the transfer can be
// described. That is when its metadata record lands, not when the server holds
// its bytes.
//
// Completeness is the wrong trigger and was the old one. It means the server
// holds every chunk, which only ever happens on the hold-on-server path. A
// direct transfer keeps its bytes on the sending device by design, so it is
// never complete here and the recipient was never told about it at all. That
// silenced the whole notification subsystem for the product's default: the
// stream said nothing and no push woke a phone whose app was closed, and the
// file sat unseen until its owner happened to open Airlock by hand.
//
// A recipient that is already running is reached by the stream anyway, so the
// announcement that matters most is the push, which is exactly the one a
// closed app depends on.
func (s *Server) announce(id, sender string) {
	info, err := s.cfg.Transfers.Get(id)
	// The metadata record is what names the file, so before it exists there is
	// nothing a notification could say.
	if err != nil || info.Meta == "" {
		return
	}
	if !s.cfg.Transfers.markAnnounced(id) {
		return
	}
	// The open stream is the fast path and reaches a running app immediately.
	// Push covers the case the stream cannot: an app that is not running at all.
	s.cfg.Events.Publish(info.To, sender)
	go s.cfg.Push.Notify(info.To, sender)
}

// events streams to one device for as long as it stays connected. It carries
// two kinds of message. A nudge says only that the inbox changed, so the client
// re-reads it and every filename stays behind the encryption boundary. A signal
// carries a payload from another device that this server relays without reading.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	// Subscribe before making the response visible. Anything published while
	// headers or the first event are being flushed is then queued behind the
	// catch-up instead of falling into a gap between setup and subscription.
	// The initial inbox event also closes the earlier gap between the page's
	// first state reads and its first stream connection.
	//
	// ponytail: nothing caps how many streams one device may hold open, so an
	// approved device with a thousand tabs costs a thousand idle goroutines. A
	// personal tailnet holds a handful of devices, so the ceiling is remote.
	// Lift it by counting subscriptions per node and refusing past a small limit.
	ch, stop := s.cfg.Events.Subscribe(who(r).Node)
	defer stop()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Without this, a proxy that buffers would hold every nudge until the
	// connection closed, which is exactly never.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "event: inbox\ndata: 1\n\n")
	flusher.Flush()

	// A periodic comment keeps intermediaries from reaping an idle stream and
	// tells the client the connection is still alive.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case msg, open := <-ch:
			if !open {
				return
			}
			if payload, ok := strings.CutPrefix(msg, "signal:"); ok {
				// A session description is full of newlines and an SSE data
				// field ends at the first one, so signalling payloads travel
				// base64 encoded and the client decodes them.
				fmt.Fprintf(w, "event: signal\ndata: %s\n\n", payload)
			} else if msg == "devices" {
				fmt.Fprint(w, "event: devices\ndata: 1\n\n")
			} else {
				fmt.Fprint(w, "event: inbox\ndata: 1\n\n")
			}
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) presence(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.cfg.Events.Online())
}

// signal is a postbox. It hands one opaque string to a named device and never
// looks inside: session descriptions and ICE candidates are the peers' business,
// and a server that parsed them would be a server that had to keep parsing them.
func (s *Server) signal(w http.ResponseWriter, r *http.Request) {
	var req struct {
		To      string `json:"to"`
		Payload string `json:"payload"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&req); err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			http.Error(w, "signal too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.To == "" || len(req.To) > 128 {
		http.Error(w, "bad target", http.StatusBadRequest)
		return
	}
	// The stream writes the payload into a single SSE data field, which ends at
	// the first newline, so the encoding the client is expected to use is a
	// framing requirement rather than a convention. Enforced here because a
	// caller that skipped it could otherwise write whole events of its own
	// choosing into another device's stream.
	if strings.ContainsAny(req.Payload, "\r\n") {
		http.Error(w, "payload must be newline free", http.StatusBadRequest)
		return
	}
	// Only a device this server already knows may be signalled, so the relay
	// cannot be used to reach anything the caller could not reach anyway.
	if !s.cfg.Devices.Allowed(req.To) {
		http.Error(w, "unknown device", http.StatusNotFound)
		return
	}
	if !s.cfg.Events.Send(req.To, req.Payload) {
		// Not an error. The sender uses this to decide to stay queued.
		http.Error(w, "device is not connected", http.StatusServiceUnavailable)
		return
	}
	// The direct path either works or leaves a transfer sitting at zero chunks
	// with nothing anywhere to say how far it got. This counts the handshake
	// without reading it: a run with offers and no answers failed in one place, a
	// run with both and no chunks failed in another, and the two are otherwise
	// indistinguishable from the outside.
	log.Printf("signal %s -> %s (%d bytes)", who(r).Node, req.To, len(req.Payload))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) inbox(w http.ResponseWriter, r *http.Request) {
	list, err := s.cfg.Transfers.Inbox(who(r).Node)
	if fail(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// subscribe records the caller's push endpoint. The node comes from the gate's
// verified identity rather than the body, so no device can register itself as
// another and collect that device's wake-ups.
func (s *Server) subscribe(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	node := who(r).Node
	// The gate checked this request before its body was read. Revocation may
	// have landed in between, so admission and persistence are serialized with
	// setAllowed and eligibility is checked once more at the mutation boundary.
	s.pushMu.Lock()
	defer s.pushMu.Unlock()
	if !s.cfg.Devices.Allowed(node) {
		http.Error(w, "not authorized", http.StatusForbidden)
		return
	}
	if err := s.cfg.Push.Subscribe(node, raw); err != nil {
		http.Error(w, "bad subscription", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	hist, err := s.cfg.Transfers.History(who(r).Node)
	if fail(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, hist)
}
