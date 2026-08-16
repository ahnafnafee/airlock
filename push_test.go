package main

import "testing"

func TestVapidKeysPersistAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	p, err := NewPusher(dir, "mailto:test@invalid")
	if err != nil {
		t.Fatal(err)
	}
	if p.PublicKey() == "" {
		t.Fatal("a VAPID public key should be generated on first run")
	}

	again, err := NewPusher(dir, "mailto:test@invalid")
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
	p, err := NewPusher(dir, "mailto:test@invalid")
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

	reloaded, err := NewPusher(dir, "mailto:test@invalid")
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Count() != 1 {
		t.Fatalf("count after reload = %d, want 1", reloaded.Count())
	}
}

func TestSubscribeRejectsMissingEndpoint(t *testing.T) {
	p, err := NewPusher(t.TempDir(), "mailto:test@invalid")
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

func TestTargetsExcludeTheSenderAndRespectAddressing(t *testing.T) {
	p, err := NewPusher(t.TempDir(), "mailto:test@invalid")
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

func nodesOf(subs []subscription) []string {
	out := make([]string, 0, len(subs))
	for _, s := range subs {
		out = append(out, s.Node)
	}
	return out
}
