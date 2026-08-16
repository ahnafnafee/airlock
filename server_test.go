package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// newTestServer builds a server with limits small enough that most tests can
// cross them cheaply. Those defaults are too small to tell a handler that reads
// a limit from its store apart from one that writes a number down, so a test
// that cares about that distinction uses newTestServerWithLimits instead.
func newTestServer(t *testing.T, allow bool) (*Server, *Devices) {
	t.Helper()
	return newTestServerWithLimits(t, allow, 4096, 1<<20)
}

// newTestServerWithLimits is newTestServer with the record and total byte
// budgets under the caller's control.
func newTestServerWithLimits(t *testing.T, allow bool, maxRecord int, maxTotal int64) (*Server, *Devices) {
	t.Helper()
	dir := t.TempDir()
	chunks, err := NewChunkStore(dir, 64, maxTotal)
	if err != nil {
		t.Fatal(err)
	}
	transfers, err := NewTransfers(dir, chunks, time.Hour, 100, maxRecord)
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
		Events: NewEvents(),
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

func TestInboxIsScopedToThisDevice(t *testing.T) {
	s, _ := newTestServer(t, true) // identity is always node "pixel"
	mine, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["pixel"]}`)
	// Sent from here to somewhere else. The sender may delete it, so it belongs
	// in the list the delete button is attached to.
	sent, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["laptop"]}`)
	// Between two other devices, so it has to be made through the store: every
	// transfer created over HTTP has this device as its sender.
	theirs, _, err := s.cfg.Transfers.Create("laptop", []string{"desktop"}, []string{cid(1)})
	if err != nil {
		t.Fatal(err)
	}

	var inbox []map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/inbox", "").Body.Bytes(), &inbox)
	seen := map[string]bool{}
	for _, e := range inbox {
		seen[e["id"].(string)] = true
	}
	if !seen[mine] {
		t.Fatal("transfer addressed to this node is missing")
	}
	if !seen[sent] {
		t.Fatal("a transfer this device sent is missing")
	}
	if seen[theirs.ID] {
		t.Fatal("a transfer between two other devices leaked in")
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

// The test identity is fixed at node "pixel", and every transfer created over
// HTTP therefore has "pixel" as its sender, which is already enough to see and
// delete it. A transfer between two other devices has to be made through the
// store, and that is what these two tests need to have any power at all.
func TestHistoryEndpointIsScoped(t *testing.T) {
	s, _ := newTestServer(t, true)
	mine, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["pixel"]}`)
	do(t, s, "DELETE", "/api/transfer/"+mine, "")

	theirs, _, err := s.cfg.Transfers.Create("laptop", []string{"desktop"}, []string{cid(1)})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.cfg.Transfers.Delete(theirs.ID, "laptop"); err != nil {
		t.Fatal(err)
	}

	var hist []map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/history", "").Body.Bytes(), &hist)
	seen := map[string]bool{}
	for _, h := range hist {
		seen[h["id"].(string)] = true
	}
	if !seen[mine] {
		t.Fatal("this device's own tombstone is missing from its history")
	}
	if seen[theirs.ID] {
		t.Fatal("another device's tombstone leaked into this history")
	}
}

func TestDeleteOfAnotherDevicesTransferIs404(t *testing.T) {
	s, _ := newTestServer(t, true)
	theirs, _, err := s.cfg.Transfers.Create("laptop", []string{"desktop"}, []string{cid(1)})
	if err != nil {
		t.Fatal(err)
	}
	if code := do(t, s, "DELETE", "/api/transfer/"+theirs.ID, "").Code; code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", code)
	}
	if code := do(t, s, "GET", "/api/transfer/"+theirs.ID, "").Code; code != http.StatusOK {
		t.Fatal("the refused delete removed the transfer anyway")
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
// A cap written down in the handler becomes the real limit the moment the two
// disagree, and the small default hides that: the store's own limit trips
// first, so both the derived cap and a literal answer identically. This runs
// on a server whose maxRecord is larger than any cap a handler would plausibly
// hardcode, and puts a record in the gap between the two. A chunklist runs to
// megabytes on a large transfer, so the gap is a size real traffic reaches.
func TestRecordSizeFollowsTheConfiguredMaximum(t *testing.T) {
	const maxRecord = 2 << 20
	s, _ := newTestServerWithLimits(t, true, maxRecord, 8<<20)
	id, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"]}`)

	// Over a 1 MiB literal, under the configured maximum. A handler carrying
	// its own number answers 413 here; one reading the store's answers 204.
	if code := do(t, s, "PUT", "/api/transfer/"+id+"/chunklist", strings.Repeat("x", 1<<20+1)).Code; code != http.StatusNoContent {
		t.Fatalf("record above a hardcoded 1 MiB cap but below the configured maximum = %d, want 204", code)
	}
	if code := do(t, s, "PUT", "/api/transfer/"+id+"/chunklist", strings.Repeat("x", maxRecord)).Code; code != http.StatusNoContent {
		t.Fatalf("record at the configured maximum = %d, want 204", code)
	}
	if code := do(t, s, "PUT", "/api/transfer/"+id+"/chunklist", strings.Repeat("x", maxRecord+1)).Code; code != http.StatusRequestEntityTooLarge {
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
	// The chunk must go too, but only after its last referent did. Collecting the
	// reference set before expiring transfers would spare it forever.
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

// Token mode is the entire authentication surface when there is no tailnet, so
// the comparison has to turn away everything but the exact credential. The
// cookie is not a convenience: a browser cannot attach a header to a top-level
// navigation, so without it the app itself would be unreachable.
func TestTokenIdentityAcceptsOnlyTheExactToken(t *testing.T) {
	ident := tokenIdentity("s3cret")

	bearer := httptest.NewRequest("GET", "/api/whoami", nil)
	bearer.Header.Set("Authorization", "Bearer s3cret")
	id, ok := ident(bearer)
	if !ok {
		t.Fatal("a correct bearer header was rejected")
	}
	if id.Node == "" || id.User != "token" {
		t.Fatalf("identity = %+v, want a non-empty node and user \"token\"", id)
	}

	withCookie := httptest.NewRequest("GET", "/", nil)
	withCookie.AddCookie(&http.Cookie{Name: "airlock_token", Value: "s3cret"})
	if _, ok := ident(withCookie); !ok {
		t.Fatal("a correct cookie was rejected")
	}

	for _, bad := range []string{"", "Bearer s3cre", "Bearer s3cret ", "Bearer S3cret", "Bearer ", "s3cret"} {
		r := httptest.NewRequest("GET", "/", nil)
		if bad != "" {
			r.Header.Set("Authorization", bad)
		}
		if _, ok := ident(r); ok {
			t.Fatalf("Authorization %q was accepted", bad)
		}
	}
	wrongCookie := httptest.NewRequest("GET", "/", nil)
	wrongCookie.AddCookie(&http.Cookie{Name: "airlock_token", Value: "s3cretx"})
	if _, ok := ident(wrongCookie); ok {
		t.Fatal("a wrong cookie value was accepted")
	}
}

func TestLoginExchangesTheTokenForACookieTokenIdentityAccepts(t *testing.T) {
	h := loginHandler("s3cret")

	w := httptest.NewRecorder()
	h(w, httptest.NewRequest("GET", "/login?t=wrong", nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("wrong token = %d, want 403", w.Code)
	}
	if got := w.Result().Cookies(); len(got) != 0 {
		t.Fatalf("a rejected login set %v", got)
	}

	w = httptest.NewRecorder()
	h(w, httptest.NewRequest("GET", "/login?t=s3cret", nil))
	if w.Code != http.StatusSeeOther {
		t.Fatalf("correct token = %d, want 303", w.Code)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Value != "s3cret" {
		t.Fatalf("cookies = %v", cookies)
	}
	if !cookies[0].HttpOnly {
		t.Fatal("the token cookie must not be readable from script")
	}
	// The two halves name the same cookie in two places, so pin them together:
	// a rename on one side would otherwise land every navigation on a 403.
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(cookies[0])
	if _, ok := tokenIdentity("s3cret")(r); !ok {
		t.Fatal("the cookie /login sets is not one tokenIdentity accepts")
	}
}

func TestSaltIsGeneratedOnceAndACorruptFileIsNotReplaced(t *testing.T) {
	path := filepath.Join(t.TempDir(), "salt")

	first, err := loadOrCreateSalt(path)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(first)
	if err != nil || len(raw) != 16 {
		t.Fatalf("salt = %q, want standard base64 of 16 bytes (%v)", first, err)
	}
	// Every key on every device derives from this value. A salt that moved
	// between restarts would orphan every sealed record already on disk.
	second, err := loadOrCreateSalt(path)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("salt changed across calls: %q then %q", first, second)
	}

	if err := os.WriteFile(path, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrCreateSalt(path); err == nil {
		t.Fatal("a salt file of the wrong length was silently replaced")
	}
}

func TestDeclineEndpoint(t *testing.T) {
	s, _ := newTestServer(t, true) // identity is node "pixel"
	id, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["pixel"]}`)

	if code := do(t, s, "POST", "/api/transfer/"+id+"/decline", "").Code; code != http.StatusNoContent {
		t.Fatalf("decline = %d, want 204", code)
	}
	var inbox []map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/inbox", "").Body.Bytes(), &inbox)
	if len(inbox) != 0 {
		t.Fatalf("a declined transfer is still in the inbox: %v", inbox)
	}
}
