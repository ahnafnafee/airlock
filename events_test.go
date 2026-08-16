package main

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
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

	// The headers are flushed before the handler subscribes, so publishing the
	// moment Do returns would race the subscription and drop the nudge.
	deadline := time.Now().Add(2 * time.Second)
	for s.cfg.Events.Count() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the handler never subscribed")
		}
		time.Sleep(time.Millisecond)
	}
	// The test identity is node "pixel", and a device is never nudged about its
	// own upload.
	s.cfg.Events.Publish(nil, "desktop")

	lines := bufio.NewScanner(res.Body)
	for lines.Scan() {
		if strings.HasPrefix(lines.Text(), "event: inbox") {
			return
		}
	}
	t.Fatalf("the stream ended without a nudge: %v", lines.Err())
}
