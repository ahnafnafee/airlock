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
