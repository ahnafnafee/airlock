# Airlock Phase 1 Implementation Plan, part 2: the server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-15-airlock.md`, tasks 1 through 3. Task numbering is unbroken and that file's **Global Constraints** section binds every task here.

**Spec:** `docs/superpowers/specs/2026-08-15-airlock-design.md`

---

### Task 4: HTTP core, identity gate, config and devices

**Files:**
- Create: `server.go`
- Create: `push.go` (stub satisfying the interface `server.go` needs)
- Test: `server_test.go`

**Interfaces:**
- Consumes: `ChunkStore`, `Transfers`, `Devices`, `atomicWrite`, sentinels, from Tasks 1 to 3.
- Produces:
  - `type Identity struct { Node, User string }`
  - `type IdentityFunc func(*http.Request) (Identity, bool)`
  - `type CDCParams struct { Min, Normal, Max int; MaskS, MaskL uint32 }`
  - `type ServerConfig struct { Chunks *ChunkStore; Transfers *Transfers; Devices *Devices; Push *Pusher; Ident IdentityFunc; DataDir string; CDC CDCParams; TTLHours int; Salt string; Static fs.FS }`
  - `func NewServer(cfg ServerConfig) *Server`
  - `func (s *Server) ServeHTTP(http.ResponseWriter, *http.Request)`
  - `func who(r *http.Request) Identity`
  - `func writeJSON(w http.ResponseWriter, code int, v any)`
  - `func fail(w http.ResponseWriter, err error) bool`
  - `func (p *Pusher) PublicKey() string`, `func (p *Pusher) Notify(recipients []string, sender string)` (real bodies land in Phase 2)

- [ ] **Step 1: Write the failing tests**

Create `server_test.go`:

```go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func newTestServer(t *testing.T, allow bool) (*Server, *Devices) {
	t.Helper()
	dir := t.TempDir()
	chunks, err := NewChunkStore(dir, 64, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	transfers, err := NewTransfers(dir, chunks, time.Hour, 100, 4096)
	if err != nil {
		t.Fatal(err)
	}
	devices, err := NewDevices(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	static := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<h1>hi</h1>")}}
	srv := NewServer(ServerConfig{
		Chunks: chunks, Transfers: transfers, Devices: devices, Push: &Pusher{},
		Ident: func(*http.Request) (Identity, bool) {
			return Identity{Node: "pixel", User: "owner@example.com"}, allow
		},
		DataDir:  dir,
		CDC:      CDCParams{Min: 8, Normal: 16, Max: 64, MaskS: 0x3f, MaskL: 0x1f},
		TTLHours: 24,
		Salt:     "c2FsdHNhbHRzYWx0c2FsdA==",
		Static:   static,
	})
	return srv, devices
}

func do(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestGateBlocksStateWhenIdentityFails(t *testing.T) {
	s, _ := newTestServer(t, false)
	for _, p := range []string{"/", "/index.html"} {
		if got := do(t, s, "GET", p, "").Code; got != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200 for a stateless asset", p, got)
		}
	}
	for _, p := range []string{"/api/whoami", "/api/config", "/api/inbox", "/api/devices"} {
		if got := do(t, s, "GET", p, "").Code; got != http.StatusForbidden {
			t.Fatalf("GET %s = %d, want 403", p, got)
		}
	}
}

func TestRevokedDeviceIsBlockedOnItsNextRequest(t *testing.T) {
	s, devices := newTestServer(t, true)
	if got := do(t, s, "GET", "/api/whoami", "").Code; got != http.StatusOK {
		t.Fatalf("baseline = %d, want 200", got)
	}
	if err := devices.SetAllowed("pixel", false); err != nil {
		t.Fatal(err)
	}
	// No restart and no cache to expire. Stateful APIs are gated; the shell and
	// pairing status remain readable so the device can explain how to recover.
	for _, p := range []string{"/api/inbox", "/api/config", "/api/devices"} {
		if got := do(t, s, "GET", p, "").Code; got != http.StatusForbidden {
			t.Fatalf("after revoke, GET %s = %d, want 403", p, got)
		}
	}
	for _, p := range []string{"/api/whoami", "/", "/index.html"} {
		if got := do(t, s, "GET", p, "").Code; got != http.StatusOK {
			t.Fatalf("after revoke, GET %s = %d, want 200", p, got)
		}
	}
}

func TestWhoamiReportsPairingState(t *testing.T) {
	s, _ := newTestServer(t, true)
	var got map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/whoami", "").Body.Bytes(), &got)
	if got["node"] != "pixel" || got["user"] != "owner@example.com" {
		t.Fatalf("body = %v", got)
	}
	if got["allowed"] != true || got["paired"] != false {
		t.Fatalf("allowed/paired = %v/%v", got["allowed"], got["paired"])
	}

	if code := do(t, s, "POST", "/api/devices/me/paired", "").Code; code != http.StatusNoContent {
		t.Fatalf("paired = %d, want 204", code)
	}
	json.Unmarshal(do(t, s, "GET", "/api/whoami", "").Body.Bytes(), &got)
	if got["paired"] != true {
		t.Fatal("paired should stick")
	}
}

func TestConfigCarriesSaltAndChunkingParameters(t *testing.T) {
	s, _ := newTestServer(t, true)
	var got map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/config", "").Body.Bytes(), &got)
	if got["salt"] != "c2FsdHNhbHRzYWx0c2FsdA==" {
		t.Fatalf("salt = %v", got["salt"])
	}
	if got["check"] != nil {
		t.Fatalf("check = %v, want nil before setup", got["check"])
	}
	cdc, ok := got["cdc"].(map[string]any)
	if !ok {
		t.Fatalf("cdc = %v", got["cdc"])
	}
	// The server is the authority on chunking parameters. If the client picked
	// its own, two devices would cut the same file differently and dedup would
	// silently stop working.
	if cdc["min"] != float64(8) || cdc["normal"] != float64(16) || cdc["max"] != float64(64) {
		t.Fatalf("cdc = %v", cdc)
	}
	if cdc["maskS"] != float64(0x3f) || cdc["maskL"] != float64(0x1f) {
		t.Fatalf("masks = %v", cdc)
	}
}

func TestCheckIsWriteOnce(t *testing.T) {
	s, _ := newTestServer(t, true)
	if got := do(t, s, "POST", "/api/check", "sealed-bytes").Code; got != http.StatusNoContent {
		t.Fatalf("first POST = %d, want 204", got)
	}
	if got := do(t, s, "POST", "/api/check", "other-bytes").Code; got != http.StatusConflict {
		t.Fatalf("second POST = %d, want 409", got)
	}
	var got map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/config", "").Body.Bytes(), &got)
	if got["check"] != "c2VhbGVkLWJ5dGVz" {
		t.Fatalf("check = %v, want base64 of the first body", got["check"])
	}
}

func TestDevicesListAllowAndRevoke(t *testing.T) {
	s, _ := newTestServer(t, true)
	do(t, s, "GET", "/api/whoami", "") // registers "pixel"

	var list []map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/devices", "").Body.Bytes(), &list)
	if len(list) != 1 || list[0]["node"] != "pixel" {
		t.Fatalf("devices = %v", list)
	}

	if code := do(t, s, "POST", "/api/devices/pixel/revoke", "").Code; code != http.StatusNoContent {
		t.Fatalf("revoke = %d", code)
	}
	// Having revoked itself, this device can no longer reach anything.
	if code := do(t, s, "GET", "/api/devices", "").Code; code != http.StatusForbidden {
		t.Fatalf("after self-revoke = %d, want 403", code)
	}
}

func TestAllowOnUnknownDeviceIs404(t *testing.T) {
	s, _ := newTestServer(t, true)
	if code := do(t, s, "POST", "/api/devices/never-seen/allow", "").Code; code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", code)
	}
}

func TestStaticIsServedThroughTheGate(t *testing.T) {
	s, _ := newTestServer(t, true)
	w := do(t, s, "GET", "/", "")
	if w.Code != http.StatusOK || w.Body.String() != "<h1>hi</h1>" {
		t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
	}
	if body := do(t, s, "GET", "/open", "").Body.String(); body != "<h1>hi</h1>" {
		t.Fatalf("/open should serve index.html, got %q", body)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./...`
Expected: FAIL, undefined `NewServer`, `ServerConfig`, `Identity`, `CDCParams`, `Pusher`.

- [ ] **Step 3: Write the Pusher stub**

Create `push.go`:

```go
package main

// Pusher owns Web Push credentials and subscriptions. Phase 2 fills these in.
// The zero value is a working no-op, so the HTTP layer can be built and tested
// without push.
type Pusher struct{}

func (p *Pusher) PublicKey() string { return "" }

// Notify wakes the given recipient nodes. An empty recipients slice means every
// device except the sender.
func (p *Pusher) Notify(recipients []string, sender string) {}
```

- [ ] **Step 4: Write `server.go`**

```go
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
		// Registration is not authorization. Recording an unapproved device is
		// what lets the pairing screen offer it, and Allowed is consulted on
		// every request so a revocation needs no restart.
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
	f, err := os.OpenFile(filepath.Join(s.cfg.DataDir, "check.bin"),
		os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		http.Error(w, "check already set", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	if _, err := f.Write(b); err != nil {
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go vet ./... && go test ./... -v`
Expected: PASS, thirty-five tests.

- [ ] **Step 6: Commit**

```bash
git add server.go push.go server_test.go
git commit -m "feat(server): identity gate with live revocation, config and device routes"
```

---

### Task 5: HTTP transfers, chunks, inbox and history

**Files:**
- Modify: `server.go` (extend `routes`, append handlers)
- Test: `server_test.go` (append)

**Interfaces:**
- Consumes: everything from Task 4, plus the full `Transfers` and `ChunkStore` APIs.
- Produces: the nine transfer and chunk routes.

- [ ] **Step 1: Write the failing tests**

Append to `server_test.go`:

```go
func createTransfer(t *testing.T, s *Server, body string) (string, []string) {
	t.Helper()
	w := do(t, s, "POST", "/api/transfer", body)
	if w.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}
	var got struct {
		ID      string   `json:"id"`
		Missing []string `json:"missing"`
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	return got.ID, got.Missing
}

func TestTransferRoundTripWithDedup(t *testing.T) {
	s, _ := newTestServer(t, true)
	a, b := cid(1), cid(2)

	id, missing := createTransfer(t, s, `{"cids":["`+a+`","`+b+`"]}`)
	if len(missing) != 2 {
		t.Fatalf("first transfer should need both chunks, got %v", missing)
	}
	for _, c := range missing {
		if code := do(t, s, "PUT", "/api/chunk/"+c, "data").Code; code != http.StatusNoContent {
			t.Fatalf("put chunk = %d", code)
		}
	}
	do(t, s, "PUT", "/api/transfer/"+id+"/meta", "sealed-meta")
	do(t, s, "PUT", "/api/transfer/"+id+"/chunklist", "sealed-list")

	var info map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/transfer/"+id, "").Body.Bytes(), &info)
	if info["complete"] != true {
		t.Fatalf("complete = %v", info["complete"])
	}
	if info["sender"] != "pixel" {
		t.Fatalf("sender = %v, want the server-asserted node", info["sender"])
	}

	// The whole point: a second transfer over the same content uploads nothing.
	_, missing2 := createTransfer(t, s, `{"cids":["`+a+`","`+b+`"]}`)
	if len(missing2) != 0 {
		t.Fatalf("second transfer should need no chunks, got %v", missing2)
	}

	if body := do(t, s, "GET", "/api/chunk/"+a, "").Body.String(); body != "data" {
		t.Fatalf("chunk read back as %q", body)
	}
	if body := do(t, s, "GET", "/api/transfer/"+id+"/chunklist", "").Body.String(); body != "sealed-list" {
		t.Fatalf("chunklist = %q", body)
	}
}

func TestSenderAndIdAreNeverTakenFromTheClient(t *testing.T) {
	s, _ := newTestServer(t, true)
	id, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"sender":"someone-else","id":"deadbeef"}`)
	if id == "deadbeef" {
		t.Fatal("the client set its own transfer id")
	}
	var info map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/transfer/"+id, "").Body.Bytes(), &info)
	if info["sender"] != "pixel" {
		t.Fatalf("sender = %v, want pixel", info["sender"])
	}
}

func TestInboxIsFilteredByRecipient(t *testing.T) {
	s, _ := newTestServer(t, true)
	mine, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["pixel"]}`)
	theirs, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["laptop"]}`)

	var inbox []map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/inbox", "").Body.Bytes(), &inbox)
	seen := map[string]bool{}
	for _, e := range inbox {
		seen[e["id"].(string)] = true
	}
	if !seen[mine] {
		t.Fatal("transfer addressed to this node is missing")
	}
	if seen[theirs] {
		t.Fatal("transfer addressed elsewhere leaked in")
	}
}

func TestDeleteMovesTransferToHistory(t *testing.T) {
	s, _ := newTestServer(t, true)
	id, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"]}`)
	do(t, s, "PUT", "/api/transfer/"+id+"/meta", "sealed-meta")

	if code := do(t, s, "DELETE", "/api/transfer/"+id, "").Code; code != http.StatusNoContent {
		t.Fatalf("delete = %d", code)
	}
	if code := do(t, s, "GET", "/api/transfer/"+id, "").Code; code != http.StatusNotFound {
		t.Fatalf("get after delete = %d, want 404", code)
	}
	var hist []map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/history", "").Body.Bytes(), &hist)
	if len(hist) != 1 || hist[0]["id"] != id {
		t.Fatalf("history = %v", hist)
	}
	if hist[0]["meta"] != "c2VhbGVkLW1ldGE=" {
		t.Fatalf("history should retain the sealed metadata, got %v", hist[0]["meta"])
	}
}

func TestMalformedIdsAreRejected(t *testing.T) {
	s, _ := newTestServer(t, true)
	if code := do(t, s, "GET", "/api/chunk/nothex", "").Code; code != http.StatusBadRequest {
		t.Fatalf("bad cid = %d, want 400", code)
	}
	if code := do(t, s, "GET", "/api/transfer/nothex", "").Code; code != http.StatusNotFound {
		t.Fatalf("bad transfer id = %d, want 404", code)
	}
	if code := do(t, s, "POST", "/api/transfer", `{"cids":["../../etc/passwd"]}`).Code; code != http.StatusBadRequest {
		t.Fatalf("traversal-shaped cid = %d, want 400", code)
	}
	id, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"]}`)
	if code := do(t, s, "PUT", "/api/transfer/"+id+"/cids.json", "x").Code; code != http.StatusBadRequest {
		t.Fatalf("record kind naming an internal file = %d, want 400", code)
	}
}

func TestOversizeChunkIsRejected(t *testing.T) {
	s, _ := newTestServer(t, true) // maxChunkBytes is 64 in tests
	big := strings.Repeat("x", 4096)
	if code := do(t, s, "PUT", "/api/chunk/"+cid(1), big).Code; code != http.StatusRequestEntityTooLarge {
		t.Fatalf("code = %d, want 413", code)
	}
}

func TestTooManyChunksIsRejected(t *testing.T) {
	s, _ := newTestServer(t, true) // cap is 100 in tests
	ids := make([]string, 101)
	for i := range ids {
		ids[i] = cid(byte(i))
	}
	body, _ := json.Marshal(map[string]any{"cids": ids})
	if code := do(t, s, "POST", "/api/transfer", string(body)).Code; code != http.StatusInsufficientStorage {
		t.Fatalf("code = %d, want 507", code)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./...`
Expected: FAIL, the new routes fall through to the static file server.

- [ ] **Step 3: Register the routes**

In `server.go`, inside `routes()`, add above the `GET /open` registration:

```go
	s.mux.HandleFunc("POST /api/transfer", g(s.createTransfer))
	s.mux.HandleFunc("GET /api/transfer/{id}", g(s.getTransfer))
	s.mux.HandleFunc("DELETE /api/transfer/{id}", g(s.deleteTransfer))
	s.mux.HandleFunc("PUT /api/transfer/{id}/{kind}", g(s.putRecord))
	s.mux.HandleFunc("GET /api/transfer/{id}/{kind}", g(s.getRecord))
	s.mux.HandleFunc("PUT /api/chunk/{cid}", g(s.putChunk))
	s.mux.HandleFunc("GET /api/chunk/{cid}", g(s.getChunk))
	s.mux.HandleFunc("GET /api/inbox", g(s.inbox))
	s.mux.HandleFunc("GET /api/history", g(s.history))
```

- [ ] **Step 4: Append the handlers**

Append to `server.go`:

```go
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
	id := r.PathValue("cid")
	// The store's own limit is authoritative; this cap only turns an oversize
	// body into a 413 before the disk is touched.
	body := http.MaxBytesReader(w, r.Body, s.cfg.Chunks.maxChunkBytes+1024)
	if fail(w, s.cfg.Chunks.Put(id, body)) {
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

// notifyIfComplete fires a push once the last piece of a transfer lands. The
// chunks and the two sealed records can arrive in any order, so every write
// path calls this and whichever completes the transfer wins.
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
```

Also call `s.notifyIfComplete` from `putChunk` after a successful write, immediately before `w.WriteHeader`, passing `id` and `who(r).Node`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go vet ./... && go test ./... -v`
Expected: PASS, forty-two tests.

- [ ] **Step 6: Commit**

```bash
git add server.go server_test.go
git commit -m "feat(server): transfer creation with dedup negotiation, chunk transfer, inbox and history"
```

---

### Task 6: Wiring, flags, token mode and the sweep loop

**Files:**
- Create: `main.go`
- Create: `web/index.html` (placeholder proving the pipeline works)

**Interfaces:**
- Consumes: every constructor from Tasks 1 to 5.
- Produces:
  - `func loadOrCreateSalt(path string) (string, error)` returning standard base64
  - `func tokenIdentity(token string) IdentityFunc`
  - `func loginHandler(token string) http.HandlerFunc`
  - `func sweepOnce(transfers *Transfers, chunks *ChunkStore) (int, int, error)`
  - an `airlock` binary that runs with `--auth=token`

- [ ] **Step 1: Write the placeholder page**

Create `web/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Airlock</title>
<h1>Airlock</h1>
<p>Server is up. The app lands in Task 10.</p>
```

- [ ] **Step 2: Write the failing test**

Append to `server_test.go`:

```go
func TestSweepOnceDropsExpiredTransfersThenOrphanChunks(t *testing.T) {
	dir := t.TempDir()
	chunks, _ := NewChunkStore(dir, 64, 1<<20)
	transfers, _ := NewTransfers(dir, chunks, time.Millisecond, 100, 4096)

	rec, _, _ := transfers.Create("pixel", nil, []string{cid(1)})
	chunks.Put(cid(1), strings.NewReader("data"))
	time.Sleep(10 * time.Millisecond)

	gone, orphans, err := sweepOnce(transfers, chunks)
	if err != nil {
		t.Fatal(err)
	}
	if gone != 1 {
		t.Fatalf("swept %d transfers, want 1", gone)
	}
	// The chunk must go too, but only after its last referent did. Sweeping in
	// the other order would delete chunks a live transfer still needs.
	if orphans != 1 {
		t.Fatalf("swept %d chunks, want 1", orphans)
	}
	if chunks.Has(cid(1)) {
		t.Fatal("orphaned chunk survived")
	}
	if _, err := transfers.Get(rec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("expired transfer survived")
	}
}

func TestSweepOnceKeepsChunksAStillLiveTransferNeeds(t *testing.T) {
	dir := t.TempDir()
	chunks, _ := NewChunkStore(dir, 64, 1<<20)
	transfers, _ := NewTransfers(dir, chunks, time.Hour, 100, 4096)

	transfers.Create("pixel", nil, []string{cid(1)})
	chunks.Put(cid(1), strings.NewReader("data"))

	gone, orphans, err := sweepOnce(transfers, chunks)
	if err != nil {
		t.Fatal(err)
	}
	if gone != 0 || orphans != 0 {
		t.Fatalf("swept %d transfers and %d chunks, want 0 and 0", gone, orphans)
	}
}
```

Add `"errors"` to the test file's imports.

- [ ] **Step 3: Write `main.go`**

```go
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
// a secret; its job is to stop precomputation shared across installations.
func loadOrCreateSalt(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil && len(b) == 16 {
		return base64.StdEncoding.EncodeToString(b), nil
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	if err := atomicWrite(path, b[:]); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b[:]), nil
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
```

- [ ] **Step 4: Verify it builds and the tests pass**

Run: `go build ./... && go vet ./... && go test ./... -v`
Expected: build succeeds, forty-four tests PASS.

- [ ] **Step 5: Smoke test the running server**

In one shell:

```bash
AIRLOCK_TOKEN=devtoken go run . --auth=token --data ./devdata
```

In another:

```bash
curl -s -H 'Authorization: Bearer devtoken' localhost:8080/api/whoami
curl -s -H 'Authorization: Bearer devtoken' localhost:8080/api/config
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/api/whoami
```

Expected: the first prints an identity with `"allowed":true`, the second prints the salt and the `cdc` block, the third prints `403`.

- [ ] **Step 6: Commit**

```bash
git add main.go web/index.html server_test.go
git commit -m "feat(cmd): flags, token auth, static embedding and the two-phase sweep loop"
```

---

### Task 7: Tailscale identity and TLS, in two modes

**Files:**
- Create: `tailscale.go`
- Modify: `main.go` (delete the `tailscaleListener` stub, add two flags)

**Interfaces:**
- Consumes: `IdentityFunc` from Task 4.
- Produces:
  - `func tailscaleListener() (net.Listener, IdentityFunc, error)` dispatching on `--tailscale-mode`
  - `func hostListener() (net.Listener, IdentityFunc, error)`
  - `func embeddedListener() (net.Listener, IdentityFunc, error)`
  - `func identityFromWhoIs(lc whoIser, users map[string]bool) IdentityFunc`

**Why two modes.** Embedded `tsnet` gives a self-contained binary with its own
node identity and no host dependency. Host mode serves through the machine's
already-running `tailscaled`, which is where Tailscale's TSO, GRO, GSO and
`mmsg()` throughput work actually lives; `tsnet` is in-process userspace netstack
with no kernel TUN and gets none of it. An open upstream issue
(`tailscale/tailscale#9707`) reports `tsnet` running roughly 8 to 9 times slower
than the daemon. For a file transfer tool, throughput is the product, so host
mode is the default and embedded stays as the zero-dependency fallback. Step 6
measures both on the real machine rather than trusting the issue.

Both modes produce the same two things, so everything above them is unchanged:
a TLS listener on the tailnet, and an `IdentityFunc` backed by `WhoIs`.

**Note on the API surface:** the Tailscale local client has moved package between
releases. In embedded mode, take it from `ts.LocalClient()` with `:=` and never
name its type. In host mode you must construct one, so check which path this
pinned version exposes before writing the import:

```bash
go doc tailscale.com/client/local.Client 2>/dev/null && echo "use tailscale.com/client/local, &local.Client{}"
go doc tailscale.com/client/tailscale.LocalClient 2>/dev/null && echo "use tailscale.com/client/tailscale, &tailscale.LocalClient{}"
```

Use whichever resolves. If both do, prefer `tailscale.com/client/local`.

- [ ] **Step 1: Add the dependency**

```bash
go get tailscale.com@latest
```

- [ ] **Step 2: Add the two flags**

In `main.go`, add to the `var (...)` flag block:

```go
	tailscaleMode = flag.String("tailscale-mode", "host",
		`"host" to serve through the machine's running tailscaled, or "embedded" for a self-contained tsnet node`)
	allowNodes = flag.String("allow-nodes", "",
		"comma-separated node names allowed; empty means any node of an allowed user")
```

Then delete the `tailscaleListener` stub from the bottom of `main.go`. Do not add
any tailscale import to `main.go`; they all live in the new file.

- [ ] **Step 3: Write `tailscale.go`**

```go
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

// whoIser is the slice of the Tailscale local client this file needs. Both the
// embedded client and the host daemon's client satisfy it, which is what lets
// one identity implementation serve both modes.
type whoIser interface {
	WhoIs(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error)
	Status(ctx context.Context) (*ipnstate.Status, error)
}

func tailscaleListener() (net.Listener, IdentityFunc, error) {
	switch *tailscaleMode {
	case "host":
		return hostListener()
	case "embedded":
		return embeddedListener()
	default:
		return nil, nil, fmt.Errorf("unknown --tailscale-mode %q, want host or embedded", *tailscaleMode)
	}
}

// hostListener serves through the machine's running tailscaled. That daemon owns
// the kernel TUN path and Tailscale's TSO, GRO, GSO and mmsg throughput work.
// The embedded netstack in tsnet has none of it, which is why this is the
// default for a tool whose product is throughput.
func hostListener() (net.Listener, IdentityFunc, error) {
	lc := newLocalClient()
	ctx := context.Background()

	st, err := lc.Status(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf(
			"tailscaled status failed, is the daemon running and may this process reach its socket: %w", err)
	}
	if len(st.TailscaleIPs) == 0 {
		return nil, nil, errors.New("tailscaled reports no tailnet address")
	}

	users, err := resolveAllowedUsers(ctx, lc)
	if err != nil {
		return nil, nil, err
	}
	log.Printf("host mode, allowing tailnet users %v", sortedKeys(users))

	// Bind the tailnet address specifically rather than every interface, so the
	// listener is never reachable from the LAN even by accident.
	addr := net.JoinHostPort(st.TailscaleIPs[0].String(), "443")
	raw, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, nil, fmt.Errorf("listen %s: %w", addr, err)
	}
	// GetCertificate fetches and renews the tailnet certificate through the
	// daemon, so there is no rotation to schedule here.
	ln := tls.NewListener(raw, &tls.Config{GetCertificate: lc.GetCertificate})
	return ln, identityFromWhoIs(lc, users), nil
}

// embeddedListener joins the tailnet as its own node, needing nothing installed
// on the host. Slower than host mode, and kept for exactly that portability.
func embeddedListener() (net.Listener, IdentityFunc, error) {
	ts := &tsnet.Server{
		Hostname: *hostname,
		Dir:      filepath.Join(*dataDir, "tsnet"),
		AuthKey:  os.Getenv("TS_AUTHKEY"),
	}
	ctx := context.Background()
	if _, err := ts.Up(ctx); err != nil {
		return nil, nil, fmt.Errorf("tsnet up: %w", err)
	}
	lc, err := ts.LocalClient()
	if err != nil {
		return nil, nil, err
	}

	users, err := resolveAllowedUsers(ctx, lc)
	if err != nil {
		return nil, nil, err
	}
	log.Printf("embedded mode, allowing tailnet users %v", sortedKeys(users))

	// ListenTLS serves the tailnet certificate for <hostname>.<tailnet>.ts.net.
	// It requires HTTPS Certificates to be enabled in the admin console; without
	// that the browser has no secure context and the client design collapses.
	ln, err := ts.ListenTLS("tcp", ":443")
	if err != nil {
		return nil, nil, fmt.Errorf("listen tls: %w", err)
	}
	return ln, identityFromWhoIs(lc, users), nil
}

func identityFromWhoIs(lc whoIser, users map[string]bool) IdentityFunc {
	nodes := splitSet(*allowNodes)
	return func(r *http.Request) (Identity, bool) {
		whois, err := lc.WhoIs(r.Context(), r.RemoteAddr)
		if err != nil || whois.Node == nil || whois.UserProfile == nil {
			return Identity{}, false
		}
		// Tagged devices have no human owner, so they can never match a login
		// allowlist and are refused here rather than falling through.
		if whois.Node.IsTagged() {
			return Identity{}, false
		}
		user := whois.UserProfile.LoginName
		if !users[user] {
			return Identity{}, false
		}
		node := strings.TrimSuffix(whois.Node.ComputedName, ".")
		if len(nodes) > 0 && !nodes[node] {
			return Identity{}, false
		}
		return Identity{Node: node, User: user}, true
	}
}

// resolveAllowedUsers defaults the tailnet-level allowlist to whoever owns the
// server's own node, which is the safe answer on a shared tailnet and needs no
// configuration on a personal one. Per-device approval is a separate layer, held
// in the device registry.
func resolveAllowedUsers(ctx context.Context, lc whoIser) (map[string]bool, error) {
	if set := splitSet(*allowUsers); len(set) > 0 {
		return set, nil
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return nil, fmt.Errorf("status: %w", err)
	}
	if st.Self == nil {
		return nil, errors.New("tailscale status has no self node")
	}
	owner, ok := st.User[st.Self.UserID]
	if !ok || owner.LoginName == "" {
		return nil, errors.New("cannot resolve the node owner; pass --allow-users")
	}
	return map[string]bool{owner.LoginName: true}, nil
}

func splitSet(csv string) map[string]bool {
	set := map[string]bool{}
	for _, s := range strings.Split(csv, ",") {
		if s = strings.TrimSpace(s); s != "" {
			set[s] = true
		}
	}
	return set
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
```

- [ ] **Step 4: Write `newLocalClient`**

This is the one place the local-client package path appears, isolated so a
version bump is a one-line change. Run the `go doc` probe from the task note
above, then append whichever form resolves to `tailscale.go` and add its import:

```go
// newLocalClient talks to the tailscaled running on this machine over its local
// API socket. Isolated into its own function because this package path has moved
// between Tailscale releases.
func newLocalClient() *local.Client { return &local.Client{} }
```

or, on an older pin:

```go
func newLocalClient() *tailscale.LocalClient { return &tailscale.LocalClient{} }
```

If neither path resolves, stop and report NEEDS_CONTEXT rather than guessing.

- [ ] **Step 5: Verify it builds**

Run: `go build ./... && go vet ./... && go test ./...`
Expected: build succeeds, all tests PASS. The tests never reach this code, because identity is injected.

- [ ] **Step 6: Verify host mode on the tailnet**

With `tailscaled` running and this process able to reach its socket:

```bash
sudo ./airlock --data /var/lib/airlock
```

Check, in order:

1. The log says `host mode` and names the allowed user.
2. From a second device, `https://<this-node>.<tailnet>.ts.net/api/whoami` returns that device's node name with no certificate warning.
3. With Tailscale disconnected on the client, the hostname does not resolve.
4. `ss -ltn` shows the listener bound to the `100.x` address only, not `0.0.0.0`.
5. From an allowed device, `POST /api/devices/<other node>/revoke`, then confirm that device gets 403 on its very next request with no restart.

- [ ] **Step 7: Verify embedded mode**

```bash
TS_AUTHKEY=tskey-auth-... ./airlock --tailscale-mode=embedded --data /var/lib/airlock-embedded
```

Check that `airlock` appears as its own node in `tailscale status` on another
device, and that `https://airlock.<tailnet>.ts.net/api/whoami` answers.

- [ ] **Step 8: Benchmark both modes and record the result**

This is the measurement the default depends on. Do not skip it, and do not
adjust the default without it.

On the server, in each mode in turn, with the client on another tailnet device:

```bash
# one 8 MiB body, uploaded 128 times under distinct chunk ids, so this measures
# real per-request overhead as well as raw throughput
head -c 8388608 /dev/urandom > /tmp/chunk8m
time for i in $(seq 1 128); do
  id=$(printf '%064x' $i)
  curl -s -o /dev/null -X PUT --data-binary @/tmp/chunk8m \
    "https://<node>.<tailnet>.ts.net/api/chunk/$id"
done
```

1 GiB moves per run. Record MB/s for host mode and for embedded mode.

Report both numbers in your task report. If host mode is not meaningfully
faster, say so plainly: the upstream issue that motivated this design is from
2023 and may have been fixed, and a measurement that contradicts it is more
valuable than one that confirms it.

- [ ] **Step 9: Commit**

```bash
git add tailscale.go main.go go.mod go.sum
git commit -m "feat(auth): tailnet identity and TLS in host and embedded modes"
```

---

Tasks 8 through 12, the browser client, are in
`docs/superpowers/plans/2026-08-15-airlock-part3.md`.
