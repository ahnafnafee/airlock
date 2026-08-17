package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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
	static := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<h1>hi</h1>")},
		"sw.js":      &fstest.MapFile{Data: []byte("// worker")},
	}
	srv := NewServer(ServerConfig{
		Chunks: chunks, Transfers: transfers, Devices: devices, Push: &Pusher{},
		Events: NewEvents(),
		Ident: func(*http.Request) (Identity, bool) {
			return Identity{Node: "pixel", User: "owner@example.com"}, allow
		},
		DataDir: dir,
		CDC:     CDCParams{Min: 8, Normal: 16, Max: 64, MaskS: 0x3f, MaskL: 0x1f},
		TTL:     24 * time.Hour,
		Salt:    "c2FsdHNhbHRzYWx0c2FsdA==",
		Static:  static,
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
	// No restart and no cache to expire: the flag is read per request.
	for _, p := range []string{"/api/inbox", "/api/config", "/api/devices"} {
		if got := do(t, s, "GET", p, "").Code; got != http.StatusForbidden {
			t.Fatalf("after revoke, GET %s = %d, want 403", p, got)
		}
	}
	// Revocation has to stay visible to the device it happened to. A revoked
	// device that could not read its own status would show a broken app instead
	// of the screen that says what to do about it.
	var me map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/whoami", "").Body.Bytes(), &me)
	if me["allowed"] != false {
		t.Fatalf("whoami after revoke reported allowed = %v", me["allowed"])
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

func TestMarkPairedPublishesADevicesEvent(t *testing.T) {
	s, devices := newTestServer(t, true)
	devices.Seen("pixel", "owner@example.com", "")
	stream, stop := s.cfg.Events.Subscribe("pixel")
	defer stop()

	if code := do(t, s, "POST", "/api/devices/me/paired", "").Code; code != http.StatusNoContent {
		t.Fatalf("paired = %d, want 204", code)
	}
	if got, ok := recv(t, stream); !ok || got != "devices" {
		t.Fatalf("stream got %q, ok=%v; want devices", got, ok)
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
	devices.Seen("laptop", "owner@example.com", "")

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

func TestApprovalPublishesADevicesEvent(t *testing.T) {
	s, devices := newTestServer(t, true)
	devices.Seen("laptop", "owner@example.com", "")
	if err := devices.SetAllowed("laptop", false); err != nil {
		t.Fatal(err)
	}
	devices.Seen("pixel", "owner@example.com", "")
	stream, stop := s.cfg.Events.Subscribe("pixel")
	defer stop()

	if code := do(t, s, "POST", "/api/devices/laptop/allow", "").Code; code != http.StatusNoContent {
		t.Fatalf("allow = %d, want 204", code)
	}
	if got, ok := recv(t, stream); !ok || got != "devices" {
		t.Fatalf("stream got %q, ok=%v; want devices", got, ok)
	}
}

func TestRevocationClosesTheTargetStreamAndPublishesADevicesEvent(t *testing.T) {
	s, devices := newTestServer(t, true)
	devices.Seen("desktop", "owner@example.com", "")
	devices.Seen("pixel", "owner@example.com", "")
	pixel, stopPixel := s.cfg.Events.Subscribe("pixel")
	desktop, stopDesktop := s.cfg.Events.Subscribe("desktop")
	defer stopPixel()
	defer stopDesktop()

	if code := do(t, s, "POST", "/api/devices/desktop/revoke", "").Code; code != http.StatusNoContent {
		t.Fatalf("revoke = %d, want 204", code)
	}
	if got, ok := recv(t, pixel); !ok || got != "devices" {
		t.Fatalf("approved stream got %q, ok=%v; want devices", got, ok)
	}
	if got, ok := recv(t, desktop); ok {
		t.Fatalf("revoked stream stayed open and received %q", got)
	}

	var online []string
	w := do(t, s, "GET", "/api/presence", "")
	if w.Code != http.StatusOK {
		t.Fatalf("presence = %d: %s", w.Code, w.Body)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &online); err != nil {
		t.Fatal(err)
	}
	for _, node := range online {
		if node == "desktop" {
			t.Fatalf("presence still advertises revoked desktop: %v", online)
		}
	}
}

func TestRevocationRemovesTheTargetsPushSubscriptions(t *testing.T) {
	s, devices := newTestServer(t, true)
	pusher, err := NewPusher(t.TempDir(), "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	s.cfg.Push = pusher
	devices.Seen("desktop", "owner@example.com", "")
	for _, endpoint := range []string{"old", "current"} {
		raw := []byte(`{"endpoint":"https://push.example/desktop-` + endpoint + `","keys":{"p256dh":"k","auth":"a"}}`)
		if err := pusher.Subscribe("desktop", raw); err != nil {
			t.Fatal(err)
		}
	}
	if err := pusher.Subscribe("laptop", []byte(`{"endpoint":"https://push.example/laptop","keys":{"p256dh":"k","auth":"a"}}`)); err != nil {
		t.Fatal(err)
	}

	if code := do(t, s, "POST", "/api/devices/desktop/revoke", "").Code; code != http.StatusNoContent {
		t.Fatalf("revoke = %d, want 204", code)
	}
	got := pusher.targets(nil, "pixel")
	if len(got) != 1 || got[0].Node != "laptop" {
		t.Fatalf("generic push targets after revoke = %v, want only laptop", nodesOf(got))
	}
}

type delayedSubscriptionBody struct {
	started chan struct{}
	release chan struct{}
	body    []byte
	read    bool
}

func (b *delayedSubscriptionBody) Read(p []byte) (int, error) {
	if b.read {
		return 0, io.EOF
	}
	b.read = true
	close(b.started)
	<-b.release
	return copy(p, b.body), io.EOF
}

func TestRevocationWinsAgainstAnAlreadyAuthorizedPushSubscribe(t *testing.T) {
	s, devices := newTestServer(t, true)
	pusher, err := NewPusher(t.TempDir(), "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	s.cfg.Push = pusher
	s.cfg.Ident = func(r *http.Request) (Identity, bool) {
		return Identity{Node: r.Header.Get("X-Test-Node"), User: "owner@example.com"}, true
	}
	devices.Seen("pixel", "owner@example.com", "")
	devices.Seen("desktop", "owner@example.com", "")

	body := &delayedSubscriptionBody{
		started: make(chan struct{}),
		release: make(chan struct{}),
		body:    []byte(`{"endpoint":"https://push.example/desktop","keys":{"p256dh":"k","auth":"a"}}`),
	}
	subscribeRequest := httptest.NewRequest("POST", "/api/push/subscribe", body)
	subscribeRequest.Header.Set("X-Test-Node", "desktop")
	subscribeResult := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, subscribeRequest)
		subscribeResult <- w
	}()
	select {
	case <-body.started: // The gate admitted desktop and the handler is reading its body.
	case <-time.After(time.Second):
		t.Fatal("subscribe handler never started reading its body")
	}

	revokeRequest := httptest.NewRequest("POST", "/api/devices/desktop/revoke", nil)
	revokeRequest.Header.Set("X-Test-Node", "pixel")
	revokeResult := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, revokeRequest)
		revokeResult <- w
	}()
	var revoke *httptest.ResponseRecorder
	select {
	case revoke = <-revokeResult:
	case <-time.After(time.Second):
		close(body.release)
		t.Fatal("revoke waited for an untrusted subscription body")
	}
	close(body.release)
	var subscribe *httptest.ResponseRecorder
	select {
	case subscribe = <-subscribeResult:
	case <-time.After(time.Second):
		t.Fatal("subscribe handler did not finish after its body was released")
	}

	if revoke.Code != http.StatusNoContent {
		t.Fatalf("revoke = %d, want 204", revoke.Code)
	}
	if subscribe.Code != http.StatusForbidden {
		t.Fatalf("subscription admitted after revoke = %d, want 403", subscribe.Code)
	}
	if got := nodesOf(pusher.targets(nil, "pixel")); len(got) != 0 {
		t.Fatalf("generic push targets after the race = %v, want none", got)
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

// A second device meets the pairing screen, not an error. The shell has to
// load before approval or there is nothing to render the screen with, and
// whoami has to answer or the shell cannot tell waiting from broken. Everything
// that holds data still refuses.
func TestUnapprovedDeviceGetsTheShellAndItsStatus(t *testing.T) {
	s, devices := newTestServer(t, true)
	do(t, s, "GET", "/api/whoami", "") // records the device
	if err := devices.SetAllowed("pixel", false); err != nil {
		t.Fatal(err)
	}

	if code := do(t, s, "GET", "/", "").Code; code != http.StatusOK {
		t.Fatalf("app shell = %d, want 200: an unapproved device cannot render the pairing screen without it", code)
	}

	w := do(t, s, "GET", "/api/whoami", "")
	if w.Code != http.StatusOK {
		t.Fatalf("whoami = %d, want 200", w.Code)
	}
	var me struct {
		Node    string `json:"node"`
		Allowed bool   `json:"allowed"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if me.Allowed {
		t.Fatal("whoami reported an unapproved device as allowed")
	}
	if me.Node == "" {
		t.Fatal("whoami gave no node name, so the pairing screen cannot name the device to approve")
	}

	// Asking who you are is also how you get listed for approval.
	found := false
	for _, d := range s.cfg.Devices.List() {
		if d.Node == me.Node {
			found = true
		}
	}
	if !found {
		t.Fatal("the device is not in the registry, so no approved device can offer it")
	}

	for _, path := range []string{"/api/config", "/api/inbox", "/api/devices", "/api/history"} {
		if code := do(t, s, "GET", path, "").Code; code != http.StatusForbidden {
			t.Fatalf("%s = %d, want 403 for an unapproved device", path, code)
		}
	}
}

func TestFirstSightingOfAPendingDevicePublishesADevicesEvent(t *testing.T) {
	s, devices := newTestServer(t, true)
	// An existing approved device is the authority that can act on the event.
	devices.Seen("laptop", "owner@example.com", "")
	devices.defaultAllow = false
	stream, stop := s.cfg.Events.Subscribe("laptop")
	defer stop()

	w := do(t, s, "GET", "/api/whoami", "")
	if w.Code != http.StatusOK {
		t.Fatalf("whoami = %d, want 200", w.Code)
	}
	if got, ok := recv(t, stream); !ok || got != "devices" {
		t.Fatalf("approved stream got %q, ok=%v; want devices", got, ok)
	}
}

// A module service worker's script request carries no cookie, so the shell and
// its assets answer without one. Nothing behind that door holds data.
func TestShellAnswersWithoutIdentity(t *testing.T) {
	s, _ := newTestServer(t, false)
	unauthenticated := func(method, path string) int {
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	for _, path := range []string{"/", "/open", "/sw.js"} {
		if code := unauthenticated("GET", path); code != http.StatusOK {
			t.Fatalf("%s without identity = %d, want 200", path, code)
		}
	}
	for _, path := range []string{"/api/whoami", "/api/config", "/api/inbox"} {
		if code := unauthenticated("GET", path); code != http.StatusForbidden {
			t.Fatalf("%s without identity = %d, want 403", path, code)
		}
	}
}

// Embedded assets have no version in their names and no modification time, so
// without this a browser is free to invent a lifetime for them and keep running
// an old client against an upgraded server.
func TestShellAssetsAreRevalidated(t *testing.T) {
	s, _ := newTestServer(t, true)
	for _, path := range []string{"/", "/sw.js"} {
		if got := do(t, s, "GET", path, "").Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s Cache-Control = %q, want no-cache", path, got)
		}
	}
}

// Somebody opening the app by following a link is the normal way in, and a
// browser labels that arrival cross-site because the previous page was another
// origin. Refusing it makes the address unusable from a chat message, a
// bookmark or a QR code, so the read-only top-level navigation is allowed while
// everything a hostile page can fire without leaving itself is not.
func TestGateAllowsCrossSiteTopLevelNavigation(t *testing.T) {
	s, _ := newTestServer(t, true)
	nav := func(r *http.Request) *http.Request {
		r.Header.Set("Sec-Fetch-Site", "cross-site")
		r.Header.Set("Sec-Fetch-Mode", "navigate")
		r.Header.Set("Sec-Fetch-Dest", "document")
		return r
	}
	cases := []struct {
		name string
		req  func() *http.Request
		want int
	}{
		{"the app itself", func() *http.Request {
			return nav(httptest.NewRequest("GET", "/", nil))
		}, http.StatusOK},
		{"the file handler launch path", func() *http.Request {
			return nav(httptest.NewRequest("GET", "/open", nil))
		}, http.StatusOK},
		// A navigation is a whole-tab move the person can see. Framing is not,
		// and it is how a hostile page would read the app in place, so the
		// exemption must not extend to it.
		{"framed in a hostile page", func() *http.Request {
			r := nav(httptest.NewRequest("GET", "/", nil))
			r.Header.Set("Sec-Fetch-Dest", "iframe")
			return r
		}, http.StatusForbidden},
		// A cross-site form post arrives labelled as a navigation too, so the
		// method is what separates reading from writing.
		{"a form post claiming to be a navigation", func() *http.Request {
			return nav(httptest.NewRequest("POST", "/api/check", strings.NewReader("evil-bytes")))
		}, http.StatusForbidden},
		// Subresources are the actual CSRF surface: fetch from a hostile page
		// carries the same labels minus the navigation mode.
		{"a fetch from a hostile page", func() *http.Request {
			r := httptest.NewRequest("GET", "/api/whoami", nil)
			r.Header.Set("Sec-Fetch-Site", "cross-site")
			r.Header.Set("Sec-Fetch-Mode", "cors")
			r.Header.Set("Sec-Fetch-Dest", "empty")
			return r
		}, http.StatusForbidden},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.ServeHTTP(w, c.req())
			if w.Code != c.want {
				t.Fatalf("got %d, want %d", w.Code, c.want)
			}
		})
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

func TestDirectTransferRequiresARecipient(t *testing.T) {
	s, _ := newTestServer(t, true)
	w := do(t, s, "POST", "/api/transfer", `{"cids":["`+cid(1)+`"]}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("create without a recipient = %d, want 400: %s", w.Code, w.Body)
	}
}

func TestDirectTransferRejectsTheSenderAsARecipient(t *testing.T) {
	s, _ := newTestServer(t, true) // test identity is node "pixel"
	w := do(t, s, "POST", "/api/transfer", `{"to":["pixel"],"cids":["`+cid(1)+`"]}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("create addressed to the sender = %d, want 400: %s", w.Code, w.Body)
	}
}

func TestHeldTransferAllowsBroadcast(t *testing.T) {
	s, _ := newTestServer(t, true)
	w := do(t, s, "POST", "/api/transfer", `{"held":true,"cids":["`+cid(1)+`"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create held broadcast = %d, want 200: %s", w.Code, w.Body)
	}
}

func TestTransferRoundTripWithDedup(t *testing.T) {
	s, _ := newTestServer(t, true)
	a, b := cid(1), cid(2)

	id, missing := createTransfer(t, s, `{"held":true,"cids":["`+a+`","`+b+`"]}`)
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
	_, missing2 := createTransfer(t, s, `{"held":true,"cids":["`+a+`","`+b+`"]}`)
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
	id, _ := createTransfer(t, s, `{"held":true,"cids":["`+cid(1)+`"],"sender":"someone-else","id":"deadbeef"}`)
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
	mineRec, _, err := s.cfg.Transfers.Create("laptop", []string{"pixel"}, []string{cid(1)})
	if err != nil {
		t.Fatal(err)
	}
	mine := mineRec.ID
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
	id, _ := createTransfer(t, s, `{"held":true,"cids":["`+cid(1)+`"]}`)
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

func TestDeleteNudgesTheCallerAndSender(t *testing.T) {
	s, devices := newTestServer(t, true)
	node := "pixel"
	s.cfg.Ident = func(*http.Request) (Identity, bool) {
		return Identity{Node: node, User: "owner@example.com"}, true
	}
	id, _ := createTransfer(t, s, `{"to":["desktop"],"cids":["`+cid(1)+`"]}`)
	devices.Seen("desktop", "owner@example.com", "")
	devices.Seen("laptop", "owner@example.com", "")
	pixel, stopPixel := s.cfg.Events.Subscribe("pixel")
	desktop, stopDesktop := s.cfg.Events.Subscribe("desktop")
	laptop, stopLaptop := s.cfg.Events.Subscribe("laptop")
	defer stopPixel()
	defer stopDesktop()
	defer stopLaptop()

	node = "desktop"
	if code := do(t, s, "DELETE", "/api/transfer/"+id, "").Code; code != http.StatusNoContent {
		t.Fatalf("delete = %d, want 204", code)
	}
	for party, ch := range map[string]<-chan string{"caller": desktop, "sender": pixel} {
		if got, ok := recv(t, ch); !ok || !strings.HasPrefix(got, "inbox") {
			t.Fatalf("%s stream got %q, ok=%v; want inbox", party, got, ok)
		}
	}
	select {
	case got := <-laptop:
		t.Fatalf("unaffected laptop received %q", got)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestTerminalMutationStillSucceedsWhenChunkReclamationFails(t *testing.T) {
	tests := []struct {
		name  string
		setup func(*testing.T, *Server) (string, string)
	}{
		{
			name: "delete",
			setup: func(t *testing.T, s *Server) (string, string) {
				rec, _, err := s.cfg.Transfers.CreateHeld("pixel", nil, []string{cid(1)})
				if err != nil {
					t.Fatal(err)
				}
				return rec.ID, "DELETE /api/transfer/" + rec.ID
			},
		},
		{
			name: "final decline",
			setup: func(t *testing.T, s *Server) (string, string) {
				rec, _, err := s.cfg.Transfers.CreateHeld("laptop", []string{"pixel"}, []string{cid(1)})
				if err != nil {
					t.Fatal(err)
				}
				return rec.ID, "POST /api/transfer/" + rec.ID + "/decline"
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _ := newTestServer(t, true)
			id, request := tt.setup(t, s)
			// Prime the authenticated device before subscribing, so the first
			// event under test is the terminal mutation's lifecycle nudge rather
			// than the registry's first-seen devices event.
			do(t, s, "GET", "/api/whoami", "")
			events, stop := s.cfg.Events.Subscribe("pixel")
			defer stop()
			if err := os.RemoveAll(s.cfg.Chunks.dir); err != nil {
				t.Fatal(err)
			}

			method, path, _ := strings.Cut(request, " ")
			if code := do(t, s, method, path, "").Code; code != http.StatusNoContent {
				t.Fatalf("terminal mutation = %d, want 204 after its state committed", code)
			}
			if _, err := s.cfg.Transfers.Get(id); !errors.Is(err, ErrNotFound) {
				t.Fatalf("transfer survived its terminal mutation: %v", err)
			}
			if got, ok := recv(t, events); !ok || !strings.HasPrefix(got, "inbox") {
				t.Fatalf("lifecycle stream got %q, ok=%v; want inbox", got, ok)
			}
		})
	}
}

// The test identity is fixed at node "pixel", and every transfer created over
// HTTP therefore has "pixel" as its sender, which is already enough to see and
// delete it. A transfer between two other devices has to be made through the
// store, and that is what these two tests need to have any power at all.
func TestHistoryEndpointIsScoped(t *testing.T) {
	s, _ := newTestServer(t, true)
	mine, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["desktop"]}`)
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
	if code := do(t, s, "POST", "/api/transfer", `{"held":true,"cids":["../../etc/passwd"]}`).Code; code != http.StatusBadRequest {
		t.Fatalf("traversal-shaped cid = %d, want 400", code)
	}
	id, _ := createTransfer(t, s, `{"held":true,"cids":["`+cid(1)+`"]}`)
	if code := do(t, s, "PUT", "/api/transfer/"+id+"/cids.json", "x").Code; code != http.StatusBadRequest {
		t.Fatalf("record kind naming an internal file = %d, want 400", code)
	}
}

func TestOversizeChunkIsRejected(t *testing.T) {
	s, _ := newTestServer(t, true) // maxChunkBytes is 64 in tests
	id, _ := createTransfer(t, s, `{"held":true,"cids":["`+cid(1)+`"]}`)
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
	id, _ := createTransfer(t, s, `{"held":true,"cids":["`+cid(1)+`"]}`)

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

func TestDeleteWaitsForAnInFlightChunkUpload(t *testing.T) {
	s, _ := newTestServer(t, true)
	id, _ := createTransfer(t, s, `{"held":true,"cids":["`+cid(1)+`"]}`)
	started := make(chan struct{})
	release := make(chan struct{})
	uploadDone := make(chan int, 1)
	go func() {
		r := httptest.NewRequest("PUT", "/api/chunk/"+cid(1)+"?transfer="+id, &pausedReader{
			body: []byte("sealed chunk"), started: started, gate: release,
		})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		uploadDone <- w.Code
	}()
	<-started

	deleteStarted := make(chan struct{})
	deleteDone := make(chan int, 1)
	go func() {
		close(deleteStarted)
		deleteDone <- do(t, s, "DELETE", "/api/transfer/"+id, "").Code
	}()
	<-deleteStarted
	select {
	case code := <-deleteDone:
		close(release)
		<-uploadDone
		t.Fatalf("delete finished with %d while its chunk upload was still in flight", code)
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	if code := <-uploadDone; code != http.StatusNoContent {
		t.Fatalf("upload = %d, want 204", code)
	}
	if code := <-deleteDone; code != http.StatusNoContent {
		t.Fatalf("delete = %d, want 204", code)
	}
	if s.cfg.Chunks.Has(cid(1)) {
		t.Fatal("the upload committed an orphan chunk after its transfer was deleted")
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
	id, _ := createTransfer(t, s, `{"held":true,"cids":["`+cid(1)+`"]}`)

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
	body, _ := json.Marshal(map[string]any{"held": true, "cids": ids})
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

	gone, orphans, err := sweepOnce(transfers)
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

	gone, orphans, err := sweepOnce(transfers)
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
	rec, _, err := s.cfg.Transfers.Create("laptop", []string{"pixel"}, []string{cid(1)})
	if err != nil {
		t.Fatal(err)
	}
	id := rec.ID

	if code := do(t, s, "POST", "/api/transfer/"+id+"/decline", "").Code; code != http.StatusNoContent {
		t.Fatalf("decline = %d, want 204", code)
	}
	var inbox []map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/inbox", "").Body.Bytes(), &inbox)
	if len(inbox) != 0 {
		t.Fatalf("a declined transfer is still in the inbox: %v", inbox)
	}
}

func TestDeclineNudgesEveryAffectedParty(t *testing.T) {
	s, devices := newTestServer(t, true)
	node := "pixel"
	s.cfg.Ident = func(*http.Request) (Identity, bool) {
		return Identity{Node: node, User: "owner@example.com"}, true
	}
	id, _ := createTransfer(t, s, `{"to":["desktop","laptop"],"cids":["`+cid(1)+`"]}`)
	devices.Seen("desktop", "owner@example.com", "")
	devices.Seen("laptop", "owner@example.com", "")
	streams := map[string]<-chan string{}
	stops := []func(){}
	for _, party := range []string{"pixel", "desktop", "laptop"} {
		stream, stop := s.cfg.Events.Subscribe(party)
		streams[party] = stream
		stops = append(stops, stop)
	}
	for _, stop := range stops {
		defer stop()
	}

	node = "desktop"
	if code := do(t, s, "POST", "/api/transfer/"+id+"/decline", "").Code; code != http.StatusNoContent {
		t.Fatalf("decline = %d, want 204", code)
	}
	for _, party := range []string{"pixel", "desktop", "laptop"} {
		if got, ok := recv(t, streams[party]); !ok || !strings.HasPrefix(got, "inbox") {
			t.Fatalf("%s stream got %q, ok=%v; want inbox", party, got, ok)
		}
	}
}

func TestPresenceReportsNobodyWithNoStreamsOpen(t *testing.T) {
	s, _ := newTestServer(t, true)

	var online []string
	json.Unmarshal(do(t, s, "GET", "/api/presence", "").Body.Bytes(), &online)
	if len(online) != 0 {
		t.Fatalf("presence = %v with no streams open", online)
	}
}

// TestProgressRoutesRoundTripAndDrainTheQueue also pins the route shape: a
// literal /progress has to win over the {kind} record patterns, which would
// answer with a 400 for a kind that is not a record.
func TestProgressRoutesRoundTripAndDrainTheQueue(t *testing.T) {
	s, _ := newTestServer(t, true)
	node := "pixel"
	s.cfg.Ident = func(*http.Request) (Identity, bool) {
		return Identity{Node: node, User: "owner@example.com"}, true
	}
	w := do(t, s, "POST", "/api/transfer", `{"cids":["`+cid(1)+`","`+cid(2)+`"],"to":["desktop"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", w.Code, w.Body)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if got := do(t, s, "PUT", "/api/transfer/"+created.ID+"/meta", "sealed-meta").Code; got != http.StatusNoContent {
		t.Fatalf("put meta = %d, want 204", got)
	}

	node = "desktop"
	if got := do(t, s, "PUT", "/api/transfer/"+created.ID+"/progress", "\x01").Code; got != http.StatusNoContent {
		t.Fatalf("put progress = %d, want 204", got)
	}
	w = do(t, s, "GET", "/api/transfer/"+created.ID+"/progress", "")
	if w.Code != http.StatusOK || w.Body.String() != "\x01" {
		t.Fatalf("get progress = %d %q, want 200 and the bitmap back", w.Code, w.Body.String())
	}

	node = "pixel"
	w = do(t, s, "GET", "/api/queue", "")
	var queue []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &queue); err != nil {
		t.Fatal(err)
	}
	if len(queue) != 1 || queue[0].ID != created.ID {
		t.Fatalf("queue = %v, want the transfer with a chunk still outstanding", queue)
	}

	node = "desktop"
	if got := do(t, s, "PUT", "/api/transfer/"+created.ID+"/progress", "\x03").Code; got != http.StatusNoContent {
		t.Fatalf("put full progress = %d, want 204", got)
	}
	node = "pixel"
	w = do(t, s, "GET", "/api/queue", "")
	queue = nil
	if err := json.Unmarshal(w.Body.Bytes(), &queue); err != nil {
		t.Fatal(err)
	}
	if len(queue) != 0 {
		t.Fatalf("queue = %v, want empty once the recipient has every chunk", queue)
	}
}

func TestProgressRejectsAWrongSizedBitmapOverHTTP(t *testing.T) {
	s, _ := newTestServer(t, true)
	node := "pixel"
	s.cfg.Ident = func(*http.Request) (Identity, bool) {
		return Identity{Node: node, User: "owner@example.com"}, true
	}
	w := do(t, s, "POST", "/api/transfer", `{"cids":["`+cid(1)+`"],"to":["desktop"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", w.Code, w.Body)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	node = "desktop"
	if got := do(t, s, "PUT", "/api/transfer/"+created.ID+"/progress", "\x00\x00").Code; got != http.StatusBadRequest {
		t.Fatalf("put oversized bitmap = %d, want 400", got)
	}
}

// The tailnet address is the thing a person actually recognizes a machine by,
// and it reaches the device list only if every hop carries it: the identity, the
// registry, and both read endpoints.
func TestTailnetAddressReachesTheDeviceList(t *testing.T) {
	s, _ := newTestServerWithLimits(t, true, 4096, 1<<20)
	s.cfg.Ident = func(*http.Request) (Identity, bool) {
		return Identity{Node: "pixel", User: "owner@example.com", Addr: "100.101.102.103"}, true
	}

	var me map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/whoami", "").Body.Bytes(), &me)
	if me["addr"] != "100.101.102.103" {
		t.Fatalf("whoami addr = %v", me["addr"])
	}

	var list []map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/devices", "").Body.Bytes(), &list)
	if len(list) != 1 || list[0]["addr"] != "100.101.102.103" {
		t.Fatalf("devices = %v", list)
	}
}

// The client says who vouched for a device, so it has to be told rather than
// guess. A server running on a token would otherwise print a claim about
// Tailscale that is not true of it.
func TestConfigNamesTheAuthenticationMode(t *testing.T) {
	s, _ := newTestServer(t, true)
	s.cfg.Auth = "token"
	var got map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/config", "").Body.Bytes(), &got)
	if got["auth"] != "token" {
		t.Fatalf("auth = %v, want token", got["auth"])
	}
}

// The product's default is a direct transfer: the sender keeps the bytes and
// hands them to the recipient itself, so the server never holds a chunk and the
// transfer is never "complete" here. Announcing on completeness therefore told
// nobody about the only kind of transfer most people ever send. A recipient is
// told once its metadata record lands, which is what names the file.
func TestDirectTransferAnnouncesWithoutTheServerHoldingChunks(t *testing.T) {
	s, devices := newTestServer(t, true)
	devices.Seen("laptop", "owner@example.com", "")

	// Two chunks the server will never receive, which is what "direct" means.
	body := `{"to":["laptop"],"cids":["` + strings.Repeat("a", 64) + `","` + strings.Repeat("b", 64) + `"]}`
	w := do(t, s, "POST", "/api/transfer", body)
	if w.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", w.Code, w.Body)
	}
	var created struct {
		ID string `json:"id"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)

	events, cancel := s.cfg.Events.Subscribe("laptop")
	defer cancel()

	if code := do(t, s, "PUT", "/api/transfer/"+created.ID+"/meta", "sealed-meta").Code; code != http.StatusNoContent {
		t.Fatalf("meta = %d", code)
	}

	select {
	case got := <-events:
		if !strings.HasPrefix(got, "inbox") {
			t.Fatalf("announced %q, want an inbox event", got)
		}
	case <-time.After(2 * time.Second):
		info, _ := s.cfg.Transfers.Get(created.ID)
		t.Fatalf("no announcement for a direct transfer (complete=%v, missing=%d): "+
			"the recipient is never told a file is waiting", info.Complete, len(info.Missing))
	}

	// Writes keep arriving after the announcement, and each one asks again. A
	// recipient should not be nudged once per record.
	if code := do(t, s, "PUT", "/api/transfer/"+created.ID+"/thumb", "sealed-thumb").Code; code != http.StatusNoContent {
		t.Fatalf("thumb = %d", code)
	}
	select {
	case got := <-events:
		t.Fatalf("announced twice for one transfer (second event %q)", got)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestServerHeldTransferLeavesTheDirectDeliveryQueue(t *testing.T) {
	s, _ := newTestServer(t, true)
	cid := strings.Repeat("a", 64)

	w := do(t, s, "POST", "/api/transfer", `{"held":true,"to":["desktop"],"cids":["`+cid+`"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", w.Code, w.Body)
	}
	var created Transfer
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	for path, body := range map[string]string{
		"/api/chunk/" + cid + "?transfer=" + created.ID: "sealed-chunk",
		"/api/transfer/" + created.ID + "/meta":         "sealed-meta",
		"/api/transfer/" + created.ID + "/chunklist":    "sealed-list",
	} {
		if code := do(t, s, "PUT", path, body).Code; code != http.StatusNoContent {
			t.Fatalf("PUT %s = %d, want 204", path, code)
		}
	}

	queue := do(t, s, "GET", "/api/queue", "")
	if queue.Code != http.StatusOK {
		t.Fatalf("queue = %d: %s", queue.Code, queue.Body)
	}
	var pending []TransferInfo
	if err := json.Unmarshal(queue.Body.Bytes(), &pending); err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("queue contains %d transfer(s), want none after the server holds the complete transfer", len(pending))
	}
}

func TestIncompleteServerHeldTransferNeverEntersTheDirectDeliveryQueue(t *testing.T) {
	s, _ := newTestServer(t, true)
	cid := strings.Repeat("b", 64)

	w := do(t, s, "POST", "/api/transfer", `{"held":true,"to":["desktop"],"cids":["`+cid+`"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", w.Code, w.Body)
	}

	queue := do(t, s, "GET", "/api/queue", "")
	if queue.Code != http.StatusOK {
		t.Fatalf("queue = %d: %s", queue.Code, queue.Body)
	}
	var pending []TransferInfo
	if err := json.Unmarshal(queue.Body.Bytes(), &pending); err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("queue contains %d transfer(s), want no peer work for a partial server-held upload", len(pending))
	}
}

// The announcement is the amplified half of a progress write: one request
// becomes a message to every device that can see the transfer and a read back
// from each. The write is never rationed, so the last update always lands; this
// is only about how often the others are told to come and look.
func TestProgressAnnouncementsAreRationedPerDeviceAndTransfer(t *testing.T) {
	s := &Server{progressSeen: map[string]time.Time{}}
	base := time.Now()

	if s.tooSoon("t1", "pixel", base) {
		t.Fatal("the first announcement for a device and transfer must go out")
	}
	if !s.tooSoon("t1", "pixel", base.Add(progressEvery/2)) {
		t.Fatal("a second announcement inside the window must be suppressed")
	}
	if s.tooSoon("t1", "pixel", base.Add(progressEvery)) {
		t.Fatal("the window must reopen once it has elapsed")
	}

	// Rationed per device and per transfer, not globally. Two phones saving at
	// once, or one phone saving two files, must not silence each other.
	if s.tooSoon("t1", "ipad", base.Add(progressEvery)) {
		t.Fatal("another device must have its own window")
	}
	if s.tooSoon("t2", "pixel", base.Add(progressEvery)) {
		t.Fatal("another transfer must have its own window")
	}
}

// One entry per device per transfer being saved would otherwise outlive every
// transfer it named and be held for the life of the process.
func TestProgressRationingForgetsOldEntries(t *testing.T) {
	s := &Server{progressSeen: map[string]time.Time{}}
	base := time.Now()
	for i := 0; i < 1100; i++ {
		s.tooSoon("t" + strconv.Itoa(i), "pixel", base)
	}
	// A later write sweeps whatever has gone stale rather than growing forever.
	s.tooSoon("fresh", "pixel", base.Add(2*time.Hour))
	if len(s.progressSeen) > 1024 {
		t.Fatalf("stale rationing entries were kept: %d", len(s.progressSeen))
	}
}
