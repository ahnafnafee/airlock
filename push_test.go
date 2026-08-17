package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func TestVapidKeysPersistAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	p, err := NewPusher(dir, "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if p.PublicKey() == "" {
		t.Fatal("a VAPID public key should be generated on first run")
	}

	again, err := NewPusher(dir, "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// Regenerating would silently invalidate every existing subscription, which
	// looks exactly like push being broken.
	if again.PublicKey() != p.PublicKey() {
		t.Fatal("VAPID keys must survive a restart")
	}
}

func TestSubscribeIsIdempotentPerEndpoint(t *testing.T) {
	dir := t.TempDir()
	p, err := NewPusher(dir, "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"endpoint":"https://push.example/abc","keys":{"p256dh":"k","auth":"a"}}`)

	for i := 0; i < 3; i++ {
		if err := p.Subscribe("pixel", raw); err != nil {
			t.Fatal(err)
		}
	}
	if p.Count() != 1 {
		t.Fatalf("count = %d, want 1 for a repeated endpoint", p.Count())
	}

	reloaded, err := NewPusher(dir, "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Count() != 1 {
		t.Fatalf("count after reload = %d, want 1", reloaded.Count())
	}
}

func TestRemoveNodeStopsGenericPushAndPersists(t *testing.T) {
	dir := t.TempDir()
	p, err := NewPusher(dir, "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	for endpoint, node := range map[string]string{
		"pixel-one": "pixel",
		"pixel-two": "pixel",
		"desktop":   "desktop",
	} {
		raw := []byte(`{"endpoint":"https://push.example/` + endpoint + `","keys":{"p256dh":"k","auth":"a"}}`)
		if err := p.Subscribe(node, raw); err != nil {
			t.Fatal(err)
		}
	}

	if err := p.RemoveNode("pixel"); err != nil {
		t.Fatal(err)
	}
	if got := nodesOf(p.targets(nil, "sender")); len(got) != 1 || got[0] != "desktop" {
		t.Fatalf("generic push targets after removal = %v, want [desktop]", got)
	}

	reloaded, err := NewPusher(dir, "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if got := nodesOf(reloaded.targets(nil, "sender")); len(got) != 1 || got[0] != "desktop" {
		t.Fatalf("generic push targets after reload = %v, want [desktop]", got)
	}
}

func TestSubscribeRejectsMissingEndpoint(t *testing.T) {
	p, err := NewPusher(t.TempDir(), "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Subscribe("pixel", []byte(`{"keys":{"p256dh":"k","auth":"a"}}`)); err == nil {
		t.Fatal("a subscription with no endpoint should be refused")
	}
	if err := p.Subscribe("pixel", []byte("not json")); err == nil {
		t.Fatal("malformed json should be refused")
	}
	if p.Count() != 0 {
		t.Fatalf("count = %d, want 0 after two refusals", p.Count())
	}
}

// The server later makes a request to whatever endpoint it stored, so an
// endpoint that names something other than a push service over https is a way
// to aim the server at a host of the caller's choosing.
func TestSubscribeRejectsNonHTTPSEndpoints(t *testing.T) {
	p, err := NewPusher(t.TempDir(), "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{
		"http://192.168.1.1/admin",
		"file:///etc/passwd",
		"https:///no-host",
		"push.example/abc",
	} {
		raw := []byte(`{"endpoint":"` + endpoint + `","keys":{"p256dh":"k","auth":"a"}}`)
		if err := p.Subscribe("pixel", raw); err == nil {
			t.Fatalf("endpoint %q should be refused", endpoint)
		}
	}
	if p.Count() != 0 {
		t.Fatalf("count = %d, want 0", p.Count())
	}
}

func TestTargetsExcludeTheSenderAndRespectAddressing(t *testing.T) {
	p, err := NewPusher(t.TempDir(), "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	for _, node := range []string{"pixel", "desktop", "laptop"} {
		raw := []byte(`{"endpoint":"https://push.example/` + node + `","keys":{"p256dh":"k","auth":"a"}}`)
		if err := p.Subscribe(node, raw); err != nil {
			t.Fatal(err)
		}
	}

	// Addressed to desktop, sent by pixel: only desktop should be woken.
	got := nodesOf(p.targets([]string{"desktop"}, "pixel"))
	if len(got) != 1 || got[0] != "desktop" {
		t.Fatalf("targets = %v, want [desktop]", got)
	}

	// Addressed to the sender itself: nobody is woken, because a device does not
	// need telling about the file it just sent.
	if got := nodesOf(p.targets([]string{"pixel"}, "pixel")); len(got) != 0 {
		t.Fatalf("targets = %v, want none", got)
	}

	// Unaddressed: everyone except the sender.
	got = nodesOf(p.targets(nil, "pixel"))
	if len(got) != 2 {
		t.Fatalf("targets = %v, want two devices", got)
	}
	for _, n := range got {
		if n == "pixel" {
			t.Fatal("the sender must never be notified of its own upload")
		}
	}
}

// A push service that accepts the connection and never answers must cost one
// device its notification, not the whole tailnet its notifications. Without a
// deadline on the request the send never returns, and without concurrent sends
// every device behind the silent one in the list waits on it forever. Neither
// failure logs anything, and neither can be pruned, because nothing ever errors.
func TestNotifySurvivesAnEndpointThatNeverAnswers(t *testing.T) {
	p, err := NewPusher(t.TempDir(), "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if p.client.Timeout <= 0 {
		t.Fatal("the push client must carry a deadline; webpush-go's default client has none")
	}
	p.client = &http.Client{Timeout: 250 * time.Millisecond}

	block := make(chan struct{})
	stalled := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		<-block
	}))
	t.Cleanup(func() { close(block); stalled.Close() })

	reached := make(chan struct{}, 1)
	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached <- struct{}{}
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(live.Close)

	// Built directly rather than through Subscribe, which requires https of a
	// caller-supplied endpoint. What is under test is the send, and the stalled
	// device deliberately sits ahead of the live one.
	p.subs = []subscription{
		testSubscription(t, "stalled", stalled.URL),
		testSubscription(t, "live", live.URL),
	}

	returned := make(chan struct{})
	go func() {
		p.Notify(nil, "sender")
		close(returned)
	}()

	select {
	case <-reached:
	case <-time.After(10 * time.Second):
		t.Fatal("the live device was never woken: a silent endpoint must not hold up the rest")
	}
	select {
	case <-returned:
	case <-time.After(10 * time.Second):
		t.Fatal("Notify never returned: the send has no deadline")
	}
}

// A subscription webpush-go will actually encrypt for: p256dh has to be a real
// point on P-256 or the send fails before any request is made.
func testSubscription(t *testing.T, node, endpoint string) subscription {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	return subscription{Node: node, Sub: webpush.Subscription{
		Endpoint: endpoint,
		Keys: webpush.Keys{
			P256dh: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
			Auth:   base64.RawURLEncoding.EncodeToString(auth),
		},
	}}
}

func nodesOf(subs []subscription) []string {
	out := make([]string, 0, len(subs))
	for _, s := range subs {
		out = append(out, s.Node)
	}
	return out
}
