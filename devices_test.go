package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSeenRegistersAndUpdates(t *testing.T) {
	d, err := NewDevices(t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	first := d.Seen("pixel", "owner@example.com", "")
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
	second := d.Seen("pixel", "owner@example.com", "")
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
	d.Seen("first", "owner@example.com", "")
	if !d.Seen("pixel", "owner@example.com", "").Allowed {
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
	if !d.Seen("first", "owner@example.com", "").Allowed {
		t.Fatal("the first device ever seen must bootstrap in")
	}
	if d.Seen("pixel", "owner@example.com", "").Allowed {
		t.Fatal("defaultAllow false should hold a later device pending approval")
	}
	if d.Allowed("pixel") {
		t.Fatal("Allowed should agree")
	}
}

func TestRevokeTakesEffectImmediately(t *testing.T) {
	d, _ := NewDevices(t.TempDir(), true)
	d.Seen("pixel", "owner@example.com", "")
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
	// The identity gate runs Seen then Allowed on every request, so a later
	// sighting must never recompute Allowed from policy and undo the revocation.
	if d.Seen("pixel", "owner@example.com", "").Allowed || d.Allowed("pixel") {
		t.Fatal("a later sighting must not readmit a revoked device")
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
	d.Seen("pixel", "owner@example.com", "")
	if err := d.SetPaired("pixel"); err != nil {
		t.Fatal(err)
	}
	// Revoking before the reopen covers the Allowed field's round trip too: a
	// revocation that does not survive a restart is a silently reopened door.
	if err := d.SetAllowed("pixel", false); err != nil {
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
	if list[0].Allowed || reopened.Allowed("pixel") {
		t.Fatalf("revocation lost across reopen: %+v", list)
	}
}

func TestNewDevicesCreatesItsDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	d, err := NewDevices(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	d.Seen("pixel", "owner@example.com", "")
	if err := d.SaveErr(); err != nil {
		t.Fatalf("registration was not persisted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "devices.json")); err != nil {
		t.Fatalf("devices.json missing: %v", err)
	}
}

func TestListIsSortedByNode(t *testing.T) {
	d, _ := NewDevices(t.TempDir(), true)
	d.Seen("zeta", "o@e.com", "")
	d.Seen("alpha", "o@e.com", "")
	got := d.List()
	if len(got) != 2 || got[0].Node != "alpha" || got[1].Node != "zeta" {
		t.Fatalf("order = %v", got)
	}
}

// A sighting used to rewrite the whole registry, so every request paid a disk
// write under the lock every other request takes. What has to survive a restart
// is who is admitted, not when they were last here.
func TestRepeatSightingsDoNotRewriteTheRegistry(t *testing.T) {
	dir := t.TempDir()
	d, err := NewDevices(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "devices.json")

	// The first sighting is a registration and must reach disk, or a restart
	// bootstraps the next node straight in.
	d.Seen("pixel", "owner@example.com", "100.64.0.1")
	first, err := os.Stat(path)
	if err != nil {
		t.Fatalf("a registration did not reach disk: %v", err)
	}

	// Repeat sightings of an unchanged device change nothing that has to last.
	for i := 0; i < 20; i++ {
		d.Seen("pixel", "owner@example.com", "100.64.0.1")
	}
	again, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !again.ModTime().Equal(first.ModTime()) {
		t.Fatal("repeat sightings rewrote the registry")
	}

	// Anything that has to survive still does. A device that changes address is
	// a different device to reach.
	d.Seen("pixel", "owner@example.com", "100.64.0.9")
	moved, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if moved.ModTime().Equal(first.ModTime()) {
		t.Fatal("a changed address was not persisted")
	}

	// And it is the new value that survives a reload, not the old one.
	reloaded, err := NewDevices(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	var got string
	for _, dev := range reloaded.List() {
		if dev.Node == "pixel" {
			got = dev.Addr
		}
	}
	if got != "100.64.0.9" {
		t.Fatalf("reloaded addr = %q, want 100.64.0.9", got)
	}
}
