package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

func TestGateBlocksEverythingWhenIdentityFails(t *testing.T) {
	s, _ := newTestServer(t, false)
	for _, p := range []string{"/", "/index.html", "/api/whoami", "/api/config", "/api/inbox", "/api/devices"} {
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
	// No restart, no cache to expire. Static assets are gated too.
	for _, p := range []string{"/api/whoami", "/api/inbox", "/", "/index.html"} {
		if got := do(t, s, "GET", p, "").Code; got != http.StatusForbidden {
			t.Fatalf("after revoke, GET %s = %d, want 403", p, got)
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

// A revoked device must be re-admittable from another device, or an operator
// who revokes the wrong node has locked it out permanently. Revoking on a node
// other than the caller is also what gives the allow route its power: a handler
// that ignored its allowed argument passes the self-revoke test above, because
// there the only observable effect is the caller losing access either way.
func TestAllowRestoresARevokedDevice(t *testing.T) {
	s, devices := newTestServer(t, true)
	devices.Seen("laptop", "owner@example.com")

	if code := do(t, s, "POST", "/api/devices/laptop/revoke", "").Code; code != http.StatusNoContent {
		t.Fatalf("revoke = %d, want 204", code)
	}
	if devices.Allowed("laptop") {
		t.Fatal("laptop should be revoked")
	}
	if code := do(t, s, "POST", "/api/devices/laptop/allow", "").Code; code != http.StatusNoContent {
		t.Fatalf("allow = %d, want 204", code)
	}
	if !devices.Allowed("laptop") {
		t.Fatal("laptop should be allowed again")
	}
}

// The gate authenticates the connection, so an allowlisted device that visits a
// hostile page would carry its own authority into any request that page fires.
// Browsers label those; the fire-and-forget POST that permanently seals
// /api/check is exactly the shape that needs turning away. Callers that send no
// label, curl and the service worker among them, keep working.
func TestGateRejectsBrowserLabelledCrossSiteRequests(t *testing.T) {
	s, _ := newTestServer(t, true)
	cases := []struct {
		site string
		want int
	}{
		{"cross-site", http.StatusForbidden},
		{"same-site", http.StatusForbidden},
		{"same-origin", http.StatusOK},
		{"none", http.StatusOK},
		{"", http.StatusOK},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/api/whoami", nil)
		if c.site != "" {
			r.Header.Set("Sec-Fetch-Site", c.site)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Fatalf("Sec-Fetch-Site %q = %d, want %d", c.site, w.Code, c.want)
		}
	}

	// The write-once verifier is the sharpest target, so check the side effect
	// itself did not land, not just the status code.
	r := httptest.NewRequest("POST", "/api/check", strings.NewReader("evil-bytes"))
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-site check = %d, want 403", w.Code)
	}
	if code := do(t, s, "POST", "/api/check", "real-bytes").Code; code != http.StatusNoContent {
		t.Fatalf("check should still be unset, got %d", code)
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
		if code := do(t, s, "PUT", "/api/chunk/"+c+"?transfer="+id, "data").Code; code != http.StatusNoContent {
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
	id, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"]}`)
	big := strings.Repeat("x", 4096)
	if code := do(t, s, "PUT", "/api/chunk/"+cid(1)+"?transfer="+id, big).Code; code != http.StatusRequestEntityTooLarge {
		t.Fatalf("code = %d, want 413", code)
	}
}

// A chunk upload that does not name its transfer cannot refresh that
// transfer's clock or notice that it just completed, so the id is required
// rather than optional: a caller that forgets it is told so at once instead of
// silently losing both.
func TestChunkUploadMustNameItsTransfer(t *testing.T) {
	s, _ := newTestServer(t, true)
	if code := do(t, s, "PUT", "/api/chunk/"+cid(1), "data").Code; code != http.StatusBadRequest {
		t.Fatalf("missing transfer id = %d, want 400", code)
	}
	if code := do(t, s, "PUT", "/api/chunk/"+cid(1)+"?transfer=nothex", "data").Code; code != http.StatusBadRequest {
		t.Fatalf("malformed transfer id = %d, want 400", code)
	}
	gone := strings.Repeat("a", 32)
	if code := do(t, s, "PUT", "/api/chunk/"+cid(1)+"?transfer="+gone, "data").Code; code != http.StatusNotFound {
		t.Fatalf("unknown transfer id = %d, want 404", code)
	}
	if f, err := s.cfg.Chunks.Open(cid(1)); err == nil {
		f.Close()
		t.Fatal("a chunk was stored against a transfer that does not exist")
	}
}

// Chunks live outside the transfer directory, so without an explicit Touch a
// transfer's clock never moves and the sweep expires it mid-upload.
func TestChunkUploadKeepsItsTransferAlive(t *testing.T) {
	s, _ := newTestServer(t, true) // ttl is one hour in tests
	id, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"]}`)

	dir := filepath.Join(s.cfg.Transfers.dir, id)
	stale := time.Now().Add(-2 * time.Hour)
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if err := os.Chtimes(filepath.Join(dir, e.Name()), stale, stale); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chtimes(dir, stale, stale); err != nil {
		t.Fatal(err)
	}

	if code := do(t, s, "PUT", "/api/chunk/"+cid(1)+"?transfer="+id, "data").Code; code != http.StatusNoContent {
		t.Fatalf("put chunk = %d", code)
	}
	swept, err := s.cfg.Transfers.Sweep(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if swept != 0 {
		t.Fatalf("swept %d transfers, want the upload to have kept this one alive", swept)
	}
	if code := do(t, s, "GET", "/api/transfer/"+id, "").Code; code != http.StatusOK {
		t.Fatalf("get after sweep = %d, want 200", code)
	}
}

// The record reader's cap has to come from the store's configurable maxRecord.
// A cap written down in the handler would become the real limit the moment the
// two disagreed, and no test that used the default could see it.
func TestRecordSizeFollowsTheConfiguredMaximum(t *testing.T) {
	s, _ := newTestServer(t, true) // maxRecord is 4096 in tests
	id, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"]}`)

	if code := do(t, s, "PUT", "/api/transfer/"+id+"/chunklist", strings.Repeat("x", 4096)).Code; code != http.StatusNoContent {
		t.Fatalf("record at the configured maximum = %d, want 204", code)
	}
	if code := do(t, s, "PUT", "/api/transfer/"+id+"/chunklist", strings.Repeat("x", 4097)).Code; code != http.StatusRequestEntityTooLarge {
		t.Fatalf("record over the configured maximum = %d, want 413", code)
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
