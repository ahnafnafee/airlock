package main

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"
)

func recv(t *testing.T, ch <-chan string) (string, bool) {
	t.Helper()
	select {
	case v, ok := <-ch:
		return v, ok
	case <-time.After(time.Second):
		return "", false
	}
}

func TestPublishReachesRecipientsAndNotTheSender(t *testing.T) {
	e := NewEvents()
	pixel, closePixel := e.Subscribe("pixel")
	desktop, closeDesktop := e.Subscribe("desktop")
	defer closePixel()
	defer closeDesktop()

	e.Publish(nil, "pixel")

	if _, ok := recv(t, desktop); !ok {
		t.Fatal("an unaddressed publish should reach other devices")
	}
	select {
	case v := <-pixel:
		t.Fatalf("the sender was notified of its own upload: %q", v)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestPublishRespectsAddressing(t *testing.T) {
	e := NewEvents()
	desktop, closeDesktop := e.Subscribe("desktop")
	laptop, closeLaptop := e.Subscribe("laptop")
	defer closeDesktop()
	defer closeLaptop()

	e.Publish([]string{"desktop"}, "pixel")

	if _, ok := recv(t, desktop); !ok {
		t.Fatal("the addressee should be notified")
	}
	select {
	case <-laptop:
		t.Fatal("a device not addressed was notified")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestPublishDevicesReachesEveryOpenStream(t *testing.T) {
	e := NewEvents()
	pixel, closePixel := e.Subscribe("pixel")
	desktop, closeDesktop := e.Subscribe("desktop")
	defer closePixel()
	defer closeDesktop()

	e.PublishDevices()
	for node, ch := range map[string]<-chan string{"pixel": pixel, "desktop": desktop} {
		if got, ok := recv(t, ch); !ok || got != "devices" {
			t.Fatalf("%s stream got %q, ok=%v; want devices", node, got, ok)
		}
	}
}

func TestNudgeIncludesEveryAffectedNode(t *testing.T) {
	e := NewEvents()
	pixel, closePixel := e.Subscribe("pixel")
	desktop, closeDesktop := e.Subscribe("desktop")
	laptop, closeLaptop := e.Subscribe("laptop")
	defer closePixel()
	defer closeDesktop()
	defer closeLaptop()

	e.Nudge([]string{"pixel", "desktop"})
	for node, ch := range map[string]<-chan string{"pixel": pixel, "desktop": desktop} {
		if got, ok := recv(t, ch); !ok || got != "inbox" {
			t.Fatalf("%s stream got %q, ok=%v; want inbox", node, got, ok)
		}
	}
	select {
	case got := <-laptop:
		t.Fatalf("unaffected laptop received %q", got)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestUnsubscribeIsIdempotentAndFrees(t *testing.T) {
	e := NewEvents()
	_, stop := e.Subscribe("pixel")
	if e.Count() != 1 {
		t.Fatalf("count = %d, want 1", e.Count())
	}
	stop()
	stop()
	if e.Count() != 0 {
		t.Fatalf("count after unsubscribe = %d, want 0", e.Count())
	}
}

func TestASlowSubscriberDoesNotBlockPublish(t *testing.T) {
	// A device that stops reading must never wedge an upload. Publish drops
	// rather than blocks, because the client re-fetches the inbox on any event
	// and a missed nudge costs nothing.
	e := NewEvents()
	// Released at the end rather than with defer. A Publish that blocks holds
	// the lock this release needs, so a deferred one would stall behind the
	// very regression under test and bury the message below in a timeout dump.
	_, stop := e.Subscribe("desktop")

	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			e.Publish(nil, "pixel")
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked on a subscriber that was not reading")
	}
	stop()
}

// publishOnFlushRecorder makes the response setup window deterministic. The
// callback fires at the exact point a real client can observe the response as
// an SSE stream, rather than relying on a scheduler race between the request
// and a publisher.
type publishOnFlushRecorder struct {
	*httptest.ResponseRecorder
	published bool
	publish   func()
	cancel    context.CancelFunc
}

func (w *publishOnFlushRecorder) Write(p []byte) (int, error) {
	n, err := w.ResponseRecorder.Write(p)
	if strings.Contains(w.Body.String(), "event: devices\n") {
		w.cancel()
	}
	return n, err
}

func (w *publishOnFlushRecorder) Flush() {
	if !w.published {
		w.published = true
		w.publish()
	}
	w.ResponseRecorder.Flush()
}

func TestFirstEventsConnectionCatchesUpAcrossResponseSetup(t *testing.T) {
	s, _ := newTestServer(t, true)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	w := &publishOnFlushRecorder{
		ResponseRecorder: httptest.NewRecorder(),
		publish:          s.cfg.Events.PublishDevices,
		cancel:           cancel,
	}
	r := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)

	s.ServeHTTP(w, r)

	body := w.Body.String()
	if !strings.Contains(body, "event: inbox\ndata: 1\n\n") {
		t.Fatalf("first stream did not catch up the inbox: %q", body)
	}
	if !strings.Contains(body, "event: devices\ndata: 1\n\n") {
		t.Fatalf("event published while the response was established was lost: %q", body)
	}
}

// The route is the half of this feature a browser actually uses, and the
// spec-level tests above cannot see it. This one holds an open stream against a
// real listener and requires the nudge to arrive on it.
func TestEventsRouteStreamsANudge(t *testing.T) {
	s, _ := newTestServer(t, true)
	ts := httptest.NewServer(s)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	// A browser refuses to treat the response as a stream under any other type.
	if got := res.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("content type = %q, want text/event-stream", got)
	}

	lines := bufio.NewScanner(res.Body)
	for lines.Scan() {
		if lines.Text() == "event: inbox" {
			break
		}
	}
	if err := lines.Err(); err != nil {
		t.Fatalf("reading initial catch-up: %v", err)
	}

	// This is a second inbox event, after the stream's initial catch-up. Keeping
	// the two distinct makes this test retain its power over live publication.
	// The test identity is node "pixel", and a device is never nudged about its
	// own upload.
	s.cfg.Events.Publish(nil, "desktop")

	for lines.Scan() {
		if strings.HasPrefix(lines.Text(), "event: inbox") {
			return
		}
	}
	t.Fatalf("the stream ended without a nudge: %v", lines.Err())
}

func TestEventsRouteStreamsADevicesChange(t *testing.T) {
	s, _ := newTestServer(t, true)
	ts := httptest.NewServer(s)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	deadline := time.Now().Add(2 * time.Second)
	for s.cfg.Events.Count() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the handler never subscribed")
		}
		time.Sleep(time.Millisecond)
	}
	s.cfg.Events.PublishDevices()

	lines := bufio.NewScanner(res.Body)
	for lines.Scan() {
		if lines.Text() == "event: devices" {
			return
		}
	}
	t.Fatalf("the stream ended without a devices event: %v", lines.Err())
}

func TestOnlineListsSubscribedNodesOnce(t *testing.T) {
	e := NewEvents()
	_, stopA := e.Subscribe("pixel")
	_, stopB := e.Subscribe("desktop")
	// A device with two tabs open is still one device.
	_, stopC := e.Subscribe("desktop")
	defer stopA()
	defer stopB()
	defer stopC()

	got := e.Online()
	sort.Strings(got)
	if len(got) != 2 || got[0] != "desktop" || got[1] != "pixel" {
		t.Fatalf("Online = %v, want [desktop pixel]", got)
	}

	stopB()
	stopC()
	if got := e.Online(); len(got) != 1 || got[0] != "pixel" {
		t.Fatalf("after both desktop streams closed, Online = %v", got)
	}
}

func TestSendReachesEveryStreamForANode(t *testing.T) {
	e := NewEvents()
	first, stop1 := e.Subscribe("desktop")
	second, stop2 := e.Subscribe("desktop")
	other, stop3 := e.Subscribe("laptop")
	defer stop1()
	defer stop2()
	defer stop3()

	if !e.Send("desktop", "sdp-blob") {
		t.Fatal("Send should report delivery when the node has a stream")
	}
	for i, ch := range []<-chan string{first, second} {
		got, ok := recv(t, ch)
		if !ok || got != "signal:sdp-blob" {
			t.Fatalf("stream %d got %q, ok=%v", i, got, ok)
		}
	}
	select {
	case v := <-other:
		t.Fatalf("an unrelated node received a signal: %q", v)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestSendToAnAbsentNodeReportsFailure(t *testing.T) {
	e := NewEvents()
	// The sender needs this answer so it can leave the transfer queued instead
	// of waiting for a reply that will never come.
	if e.Send("nobody", "sdp-blob") {
		t.Fatal("Send should report false when the node has no stream")
	}
}

func TestSignallingIsNotDroppedUnderLoad(t *testing.T) {
	// A nudge may be dropped, because the client re-reads the inbox anyway. A
	// signalling message may not: losing an answer stalls a handshake that has
	// no other way to recover.
	e := NewEvents()
	ch, stop := e.Subscribe("desktop")
	defer stop()

	for i := 0; i < 8; i++ {
		if !e.Send("desktop", "candidate") {
			t.Fatalf("send %d was dropped", i)
		}
	}
	for i := 0; i < 8; i++ {
		if _, ok := recv(t, ch); !ok {
			t.Fatalf("message %d never arrived", i)
		}
	}
}

// The prefix that separates a nudge from a signal is invisible to the spec-level
// tests above, so without this one the whole signal branch of the SSE handler
// could be deleted and everything would still pass.
func TestEventsRouteStreamsASignal(t *testing.T) {
	s, _ := newTestServer(t, true)
	ts := httptest.NewServer(s)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	deadline := time.Now().Add(2 * time.Second)
	for s.cfg.Events.Count() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the handler never subscribed")
		}
		time.Sleep(time.Millisecond)
	}
	// The test identity is node "pixel", and unlike a nudge a signal is
	// addressed, so it reaches its target whoever sent it.
	if !s.cfg.Events.Send("pixel", "YW4tb2ZmZXI=") {
		t.Fatal("Send found no stream for the connected node")
	}

	lines := bufio.NewScanner(res.Body)
	for lines.Scan() {
		if lines.Text() != "event: signal" {
			continue
		}
		if !lines.Scan() {
			t.Fatalf("the stream ended after the event name: %v", lines.Err())
		}
		if got := lines.Text(); got != "data: YW4tb2ZmZXI=" {
			t.Fatalf("data line = %q, want the payload verbatim", got)
		}
		return
	}
	t.Fatalf("the stream ended without a signal: %v", lines.Err())
}
