package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestArrivalPushCarriesRoutingAndBoundedSealedMetadata(t *testing.T) {
	created := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	info := &TransferInfo{
		Transfer: Transfer{
			ID:        "0123456789abcdef0123456789abcdef",
			Sender:    "desktop",
			To:        []string{"pixel"},
			CreatedAt: created,
		},
		Complete: true,
		Meta:     "sealed-metadata",
	}
	body, err := marshalArrivalPush(info)
	if err != nil {
		t.Fatal(err)
	}
	var got pushMessage
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Version != pushPayloadVersion || got.Kind != pushKindArrival {
		t.Fatalf("envelope = v%d %q, want v%d %q",
			got.Version, got.Kind, pushPayloadVersion, pushKindArrival)
	}
	if got.ID != info.ID || got.Sender != info.Sender ||
		got.CreatedAt != created.Format(time.RFC3339Nano) {
		t.Fatalf("routing fields = %#v, want transfer %#v", got, info.Transfer)
	}
	if !got.Complete || got.Meta != info.Meta {
		t.Fatalf("arrival state = complete %t meta %q", got.Complete, got.Meta)
	}
	info.Complete = false
	body, err = marshalArrivalPush(info)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	if complete, present := raw["complete"]; !present || complete != false {
		t.Fatalf("incomplete arrival encoded complete = %v, present=%t", complete, present)
	}

	info.Meta = strings.Repeat("x", maxPushPayloadBytes*2)
	body, err = marshalArrivalPush(info)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) > maxPushPayloadBytes {
		t.Fatalf("fallback payload is %d bytes, limit is %d", len(body), maxPushPayloadBytes)
	}
	got = pushMessage{}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Meta != "" {
		t.Fatal("oversized sealed metadata should be omitted from the wake-up")
	}
	if got.ID != info.ID || got.Sender != info.Sender {
		t.Fatal("the generic fallback lost the fields needed for an immediate notification")
	}
}

func TestArrivalPushIsHighUrgencyAndCollapsesPerTransfer(t *testing.T) {
	p, err := NewPusher(t.TempDir(), "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	headers := make(chan http.Header, 1)
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers <- r.Header.Clone()
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(endpoint.Close)
	p.subs = []subscription{testSubscription(t, "pixel", endpoint.URL)}

	info := &TransferInfo{Transfer: Transfer{
		ID:        "0123456789abcdef0123456789abcdef",
		Sender:    "desktop",
		To:        []string{"pixel"},
		CreatedAt: time.Now().UTC(),
	}}
	p.Notify(info)

	select {
	case got := <-headers:
		if got.Get("Urgency") != string(webpush.UrgencyHigh) {
			t.Fatalf("Urgency = %q, want %q", got.Get("Urgency"), webpush.UrgencyHigh)
		}
		if got.Get("Topic") != info.ID {
			t.Fatalf("Topic = %q, want transfer id %q", got.Get("Topic"), info.ID)
		}
		if got.Get("TTL") != "3600" {
			t.Fatalf("TTL = %q, want 3600", got.Get("TTL"))
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the push service never received the arrival")
	}
}

func TestPushTestRequiresARegisteredDevice(t *testing.T) {
	p, err := NewPusher(t.TempDir(), "mailto:test@invalid", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Test("pixel"); !errors.Is(err, errNoPushSubscription) {
		t.Fatalf("Test without a subscription = %v, want %v", err, errNoPushSubscription)
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
		p.Notify(&TransferInfo{Transfer: Transfer{
			ID:        "0123456789abcdef0123456789abcdef",
			Sender:    "sender",
			CreatedAt: time.Now().UTC(),
		}})
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
