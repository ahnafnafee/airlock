package main

import (
	"testing"
	"time"
)

func TestSeenRegistersAndUpdates(t *testing.T) {
	d, err := NewDevices(t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	first := d.Seen("pixel", "owner@example.com")
	if first.Node != "pixel" || first.User != "owner@example.com" {
		t.Fatalf("device = %+v", first)
	}
	if !first.Allowed {
		t.Fatal("defaultAllow true should admit a new device")
	}
	if first.FirstSeen.IsZero() || first.LastSeen.IsZero() {
		t.Fatal("timestamps should be set on first sight")
	}

	time.Sleep(2 * time.Millisecond)
	second := d.Seen("pixel", "owner@example.com")
	if !second.FirstSeen.Equal(first.FirstSeen) {
		t.Fatal("FirstSeen must not move")
	}
	if !second.LastSeen.After(first.LastSeen) {
		t.Fatal("LastSeen should advance")
	}
	if len(d.List()) != 1 {
		t.Fatalf("List has %d entries, want 1", len(d.List()))
	}
}

func TestDefaultAllowAdmitsDevicesAfterTheFirst(t *testing.T) {
	d, _ := NewDevices(t.TempDir(), true)
	// The first device is admitted by the bootstrap rule whatever the policy
	// says, so only a second device can show that defaultAllow is consulted.
	d.Seen("first", "owner@example.com")
	if !d.Seen("pixel", "owner@example.com").Allowed {
		t.Fatal("defaultAllow true should admit a device that is not the bootstrap one")
	}
	if !d.Allowed("pixel") {
		t.Fatal("Allowed should agree")
	}
}

func TestDefaultDenyHoldsNewDevices(t *testing.T) {
	d, _ := NewDevices(t.TempDir(), false)
	// The very first device bootstraps in, otherwise nobody could ever approve
	// anybody and the server would be permanently unreachable.
	if !d.Seen("first", "owner@example.com").Allowed {
		t.Fatal("the first device ever seen must bootstrap in")
	}
	if d.Seen("pixel", "owner@example.com").Allowed {
		t.Fatal("defaultAllow false should hold a later device pending approval")
	}
	if d.Allowed("pixel") {
		t.Fatal("Allowed should agree")
	}
}

func TestRevokeTakesEffectImmediately(t *testing.T) {
	d, _ := NewDevices(t.TempDir(), true)
	d.Seen("pixel", "owner@example.com")
	if !d.Allowed("pixel") {
		t.Fatal("should start allowed")
	}
	if err := d.SetAllowed("pixel", false); err != nil {
		t.Fatal(err)
	}
	// No restart, no reload: the identity gate calls Allowed on every request.
	if d.Allowed("pixel") {
		t.Fatal("revocation should be visible at once")
	}
	if err := d.SetAllowed("pixel", true); err != nil {
		t.Fatal(err)
	}
	if !d.Allowed("pixel") {
		t.Fatal("re-allow should be visible at once")
	}
}

func TestAllowedIsFalseForUnknownDevice(t *testing.T) {
	d, _ := NewDevices(t.TempDir(), true)
	if d.Allowed("never-seen") {
		t.Fatal("an unregistered node must not be allowed by default")
	}
}

func TestPairedFlagPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	d, _ := NewDevices(dir, true)
	d.Seen("pixel", "owner@example.com")
	if err := d.SetPaired("pixel"); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewDevices(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	list := reopened.List()
	if len(list) != 1 || !list[0].Paired {
		t.Fatalf("paired flag lost across reopen: %+v", list)
	}
}

func TestListIsSortedByNode(t *testing.T) {
	d, _ := NewDevices(t.TempDir(), true)
	d.Seen("zeta", "o@e.com")
	d.Seen("alpha", "o@e.com")
	got := d.List()
	if len(got) != 2 || got[0].Node != "alpha" || got[1].Node != "zeta" {
		t.Fatalf("order = %v", got)
	}
}
