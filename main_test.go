package main

import (
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDefaultDataDirIsAbsoluteAndPlatformCorrect(t *testing.T) {
	got := defaultDataDir()
	if !filepath.IsAbs(got) {
		// A relative default is what makes a scheduled task write to
		// System32\data and a launch agent write to /data. Worse, starting from
		// a different working directory creates a fresh salt and an empty
		// check.bin, which presents as data loss or a wrong passphrase rather
		// than as a path problem.
		t.Fatalf("defaultDataDir() = %q, want an absolute path", got)
	}

	switch runtime.GOOS {
	case "windows":
		// LOCALAPPDATA on purpose, not the Roaming profile: a roaming profile
		// would try to sync the whole store.
		base, err := os.UserCacheDir()
		if err != nil {
			t.Skip("no user cache dir on this machine")
		}
		if !strings.HasPrefix(got, base) {
			t.Fatalf("defaultDataDir() = %q, want it under %q", got, base)
		}
	case "darwin":
		base, err := os.UserConfigDir()
		if err != nil {
			t.Skip("no user config dir on this machine")
		}
		if !strings.HasPrefix(got, base) {
			t.Fatalf("defaultDataDir() = %q, want it under %q", got, base)
		}
	default:
		// Not ~/.config: this is bulk data, not configuration.
		if strings.Contains(got, string(filepath.Separator)+".config"+string(filepath.Separator)) {
			t.Fatalf("defaultDataDir() = %q, want a data dir rather than a config dir", got)
		}
	}
}

func TestDefaultDataDirHonorsXDGOnUnix(t *testing.T) {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		t.Skip("XDG does not apply here")
	}
	t.Setenv("XDG_DATA_HOME", "/tmp/xdg-example")
	if got := defaultDataDir(); !strings.HasPrefix(got, "/tmp/xdg-example") {
		t.Fatalf("defaultDataDir() = %q, want it under XDG_DATA_HOME", got)
	}
}

func TestListenAddrsCoversEveryTailnetAddress(t *testing.T) {
	// Using only the first address leaves the tailnet IPv6 address dark, so a
	// client that resolves to it fails with no diagnosis.
	got := listenAddrs([]string{"100.86.123.42", "fd7a:115c:a1e0::2e01:7b2d"}, 4443)
	want := []string{"100.86.123.42:4443", "[fd7a:115c:a1e0::2e01:7b2d]:4443"}
	if len(got) != len(want) {
		t.Fatalf("listenAddrs = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("listenAddrs[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// Every bound address must reach the single listener http.Serve is given. A
// multiplexer that only ever accepted from lns[0] would pass a one-address test
// and still leave the tailnet IPv6 address dark in production, so both
// connections are made before either is accepted.
func TestListenAllAcceptsFromEveryBoundAddress(t *testing.T) {
	ln, err := listenAll([]string{"127.0.0.1:0", "127.0.0.1:0"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	m, ok := ln.(*multiListener)
	if !ok {
		t.Fatalf("listenAll returned %T, want a multiplexer over every address", ln)
	}
	if len(m.lns) != 2 {
		t.Fatalf("listenAll bound %d addresses, want 2", len(m.lns))
	}

	for i, sub := range m.lns {
		client, err := net.Dial("tcp", sub.Addr().String())
		if err != nil {
			t.Fatalf("dial address %d at %s: %v", i, sub.Addr(), err)
		}
		defer client.Close()
		if _, err := client.Write([]byte{byte('a' + i)}); err != nil {
			t.Fatal(err)
		}
	}

	// Both writes are already in flight, so a multiplexer that starves one
	// address blocks here rather than returning a wrong answer.
	seen := map[byte]bool{}
	for range m.lns {
		conn, err := acceptWithin(t, ln, 5*time.Second)
		if err != nil {
			t.Fatalf("accept: %v", err)
		}
		defer conn.Close()
		var b [1]byte
		if _, err := io.ReadFull(conn, b[:]); err != nil {
			t.Fatal(err)
		}
		seen[b[0]] = true
	}
	if !seen['a'] || !seen['b'] {
		t.Fatalf("accepted bytes %v, want one connection from each bound address", seen)
	}
}

// Close must unblock a parked Accept. http.Serve holds one, and a Close that
// left it parked would keep the process alive after shutdown.
func TestMultiListenerCloseUnblocksAccept(t *testing.T) {
	ln, err := listenAll([]string{"127.0.0.1:0"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := ln.Accept()
		done <- err
	}()
	// Give the accept a moment to park before closing underneath it.
	time.Sleep(50 * time.Millisecond)
	if err := ln.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	// A second Close must not panic on an already-closed done channel.
	ln.Close()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Accept returned a connection after Close")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Accept stayed parked after Close")
	}
}

// A port already held must not leave the addresses bound before it listening,
// and the message must name the port and the flag that fixes it.
func TestListenAllBindsEveryAddressOrNone(t *testing.T) {
	held, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	taken := held.Addr().String()

	free, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	first := free.Addr().String()
	free.Close()

	port := held.Addr().(*net.TCPAddr).Port
	ln, err := listenAll([]string{first, taken}, port)
	if err == nil {
		ln.Close()
		t.Fatal("listenAll succeeded despite an address already in use")
	}
	if !strings.Contains(err.Error(), "--port") {
		t.Fatalf("error %q does not suggest --port", err)
	}
	if !strings.Contains(err.Error(), strconv.Itoa(port)) {
		t.Fatalf("error %q does not name port %d", err, port)
	}

	// The address bound before the failure must have been released, otherwise a
	// retry on the same port would fail for a reason the operator did not cause.
	retry, err := net.Listen("tcp", first)
	if err != nil {
		t.Fatalf("listenAll left %s bound after failing: %v", first, err)
	}
	retry.Close()
}

// An empty address list has no first address, so a multiplexer built over it
// would panic inside Addr rather than report a problem.
func TestListenAllRefusesAnEmptyAddressList(t *testing.T) {
	ln, err := listenAll(nil, 443)
	if err == nil {
		ln.Close()
		t.Fatal("listenAll accepted an empty address list")
	}
	if ln != nil {
		t.Fatal("listenAll returned a listener alongside its error")
	}
}

func acceptWithin(t *testing.T, ln net.Listener, d time.Duration) (net.Conn, error) {
	t.Helper()
	type result struct {
		conn net.Conn
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		conn, err := ln.Accept()
		ch <- result{conn, err}
	}()
	select {
	case r := <-ch:
		return r.conn, r.err
	case <-time.After(d):
		return nil, errors.New("timed out waiting for a connection")
	}
}

// isLoopback decides whether a request is refused before WhoIs is ever asked, so
// a version that answered true for a tailnet address would refuse every request
// on the machine, and one that answered false for ::1 would restore the bare
// "not authorized" this exists to explain.
func TestIsLoopback(t *testing.T) {
	cases := []struct {
		remoteAddr string
		want       bool
	}{
		{"127.0.0.1:51234", true},
		{"127.0.0.53:9", true},
		{"[::1]:51234", true},
		{"100.86.123.42:443", false},
		{"[fd7a:115c:a1e0::2e01:7b2d]:443", false},
		{"192.168.1.5:443", false},
		{"laptop.example.ts.net:443", false},
		{"", false},
	}
	for _, c := range cases {
		if got := isLoopback(c.remoteAddr); got != c.want {
			t.Errorf("isLoopback(%q) = %v, want %v", c.remoteAddr, got, c.want)
		}
	}
}

// A sweep is what makes the advertised lifetime true. Sweeping hourly against a
// ten minute life would leave an expired transfer listed for most of an hour,
// which is the product quietly not keeping the promise its own flag makes.
func TestSweepRunsOftenEnoughToKeepTheAdvertisedLifetime(t *testing.T) {
	for _, ttl := range []time.Duration{
		10 * time.Minute, time.Hour, 24 * time.Hour, 5 * time.Minute,
	} {
		every := sweepInterval(ttl)
		if every > ttl/2 {
			t.Errorf("a %s life is swept every %s, so it can outlive itself by half again", ttl, every)
		}
		if every < 30*time.Second {
			t.Errorf("a %s life sweeps every %s, which is a busy loop", ttl, every)
		}
		if every > time.Hour {
			t.Errorf("a %s life sweeps every %s, which is longer than any sweep needs to wait", ttl, every)
		}
	}

	// A life shorter than the floor still sweeps at the floor rather than
	// spinning, which costs accuracy on a setting nobody should be using.
	if got := sweepInterval(time.Second); got != 30*time.Second {
		t.Errorf("a one second life sweeps every %s, want the 30s floor", got)
	}
}
