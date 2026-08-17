package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"reflect"
	"strings"
	"testing"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

// fakeWhoIs stands in for the Tailscale local client. Both real clients satisfy
// whoIser, so exercising the identity path through this fake covers host and
// embedded mode alike without a tailnet.
type fakeWhoIs struct {
	resp    *apitype.WhoIsResponse
	respErr error
	gotAddr string
	calls   int

	status    *ipnstate.Status
	statusErr error
	statusHit int
}

func (f *fakeWhoIs) WhoIs(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error) {
	f.calls++
	f.gotAddr = remoteAddr
	if f.respErr != nil {
		return nil, f.respErr
	}
	return f.resp, nil
}

func (f *fakeWhoIs) Status(ctx context.Context) (*ipnstate.Status, error) {
	f.statusHit++
	if f.statusErr != nil {
		return nil, f.statusErr
	}
	return f.status, nil
}

func whois(login, computedName string, tags ...string) *apitype.WhoIsResponse {
	return &apitype.WhoIsResponse{
		Node:        &tailcfg.Node{ComputedName: computedName, Tags: tags},
		UserProfile: &tailcfg.UserProfile{LoginName: login},
	}
}

// setFlag points a string flag at v for the duration of one test and restores it
// afterwards, so tests that share these package-level flags cannot leak into
// each other.
func setFlag(t *testing.T, p *string, v string) {
	t.Helper()
	old := *p
	*p = v
	t.Cleanup(func() { *p = old })
}

func request(remoteAddr string) *http.Request {
	r := httptest.NewRequest("GET", "/api/whoami", nil)
	r.RemoteAddr = remoteAddr
	return r
}

func TestIdentityFromWhoIsAcceptsAllowedUser(t *testing.T) {
	setFlag(t, allowNodes, "")
	fake := &fakeWhoIs{resp: whois("alice@example.com", "laptop")}
	ident := identityFromWhoIs(fake, map[string]bool{"alice@example.com": true})

	got, ok := ident(request("100.64.0.7:51234"))
	if !ok {
		t.Fatalf("allowed user was refused")
	}
	want := Identity{Node: "laptop", User: "alice@example.com"}
	if got != want {
		t.Fatalf("identity = %+v, want %+v", got, want)
	}
	if fake.gotAddr != "100.64.0.7:51234" {
		t.Fatalf("WhoIs got remote addr %q, want the request's RemoteAddr verbatim", fake.gotAddr)
	}
}

func TestIdentityFromWhoIsRejectsUserNotOnAllowlist(t *testing.T) {
	setFlag(t, allowNodes, "")
	fake := &fakeWhoIs{resp: whois("mallory@example.com", "laptop")}
	ident := identityFromWhoIs(fake, map[string]bool{"alice@example.com": true})

	if _, ok := ident(request("100.64.0.9:1")); ok {
		t.Fatal("a login outside the allowlist was accepted")
	}
}

// A tagged device has no human owner. This case gives it a login that IS on the
// allowlist, so the only thing that can refuse it is the tag check itself.
func TestIdentityFromWhoIsRejectsTaggedNode(t *testing.T) {
	setFlag(t, allowNodes, "")
	fake := &fakeWhoIs{resp: whois("alice@example.com", "ci-runner", "tag:ci")}
	ident := identityFromWhoIs(fake, map[string]bool{"alice@example.com": true})

	if _, ok := ident(request("100.64.0.3:1")); ok {
		t.Fatal("a tagged node was accepted")
	}
}

func TestIdentityFromWhoIsRejectsIncompleteAnswers(t *testing.T) {
	setFlag(t, allowNodes, "")
	users := map[string]bool{"alice@example.com": true}
	cases := map[string]*fakeWhoIs{
		"whois error":     {respErr: errors.New("peer not found")},
		"nil node":        {resp: &apitype.WhoIsResponse{UserProfile: &tailcfg.UserProfile{LoginName: "alice@example.com"}}},
		"nil userprofile": {resp: &apitype.WhoIsResponse{Node: &tailcfg.Node{ComputedName: "laptop"}}},
	}
	for name, fake := range cases {
		t.Run(name, func(t *testing.T) {
			if _, ok := identityFromWhoIs(fake, users)(request("100.64.0.4:1")); ok {
				t.Fatalf("%s was accepted", name)
			}
		})
	}
}

// The node allowlist is compared against the name after the trailing dot is
// trimmed, so a shared-in node's FQDN form still matches a plain configured name.
func TestIdentityFromWhoIsNodeAllowlist(t *testing.T) {
	users := map[string]bool{"alice@example.com": true}
	cases := []struct {
		name         string
		allow        string
		computedName string
		wantOK       bool
		wantNode     string
	}{
		{"empty allowlist admits any node", "", "phone", true, "phone"},
		{"listed node admitted", "laptop,phone", "phone", true, "phone"},
		{"unlisted node refused", "laptop,phone", "tablet", false, ""},
		{"trailing dot trimmed before matching", "laptop", "laptop.", true, "laptop"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			setFlag(t, allowNodes, c.allow)
			fake := &fakeWhoIs{resp: whois("alice@example.com", c.computedName)}
			got, ok := identityFromWhoIs(fake, users)(request("100.64.0.5:1"))
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v", ok, c.wantOK)
			}
			if ok && got.Node != c.wantNode {
				t.Fatalf("node = %q, want %q", got.Node, c.wantNode)
			}
		})
	}
}

func TestResolveAllowedUsersPrefersTheFlag(t *testing.T) {
	setFlag(t, allowUsers, " alice@example.com , bob@example.com ,")
	fake := &fakeWhoIs{status: &ipnstate.Status{
		Self: &ipnstate.PeerStatus{UserID: 7},
		User: map[tailcfg.UserID]tailcfg.UserProfile{7: {LoginName: "owner@example.com"}},
	}}

	got, err := resolveAllowedUsers(context.Background(), fake)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"alice@example.com": true, "bob@example.com": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("users = %v, want %v", got, want)
	}
	if fake.statusHit != 0 {
		t.Fatalf("Status was queried %d times despite an explicit --allow-users", fake.statusHit)
	}
}

func TestResolveAllowedUsersDefaultsToTheNodeOwner(t *testing.T) {
	setFlag(t, allowUsers, "")
	fake := &fakeWhoIs{status: &ipnstate.Status{
		Self: &ipnstate.PeerStatus{UserID: 7},
		User: map[tailcfg.UserID]tailcfg.UserProfile{
			7: {LoginName: "owner@example.com"},
			8: {LoginName: "someone@example.com"},
		},
	}}

	got, err := resolveAllowedUsers(context.Background(), fake)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"owner@example.com": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("users = %v, want %v", got, want)
	}
}

func TestResolveAllowedUsersFailsClosed(t *testing.T) {
	cases := map[string]*fakeWhoIs{
		"status error": {statusErr: errors.New("dial local api: permission denied")},
		"no self node": {status: &ipnstate.Status{}},
		"owner id absent from user map": {status: &ipnstate.Status{
			Self: &ipnstate.PeerStatus{UserID: 7},
			User: map[tailcfg.UserID]tailcfg.UserProfile{8: {LoginName: "other@example.com"}},
		}},
		"owner has an empty login": {status: &ipnstate.Status{
			Self: &ipnstate.PeerStatus{UserID: 7},
			User: map[tailcfg.UserID]tailcfg.UserProfile{7: {LoginName: ""}},
		}},
	}
	for name, fake := range cases {
		t.Run(name, func(t *testing.T) {
			setFlag(t, allowUsers, "")
			got, err := resolveAllowedUsers(context.Background(), fake)
			if err == nil {
				t.Fatalf("%s produced allowlist %v instead of an error", name, got)
			}
			if got != nil {
				t.Fatalf("%s returned a non-nil allowlist %v alongside its error", name, got)
			}
		})
	}
}

func TestTailscaleListenerRejectsUnknownMode(t *testing.T) {
	setFlag(t, tailscaleMode, "hsot")
	ln, ident, err := tailscaleListener()
	if err == nil {
		t.Fatal("an unknown --tailscale-mode was accepted")
	}
	if ln != nil || ident != nil {
		t.Fatal("a failed dispatch still returned a listener or an identity function")
	}
	if !strings.Contains(err.Error(), `"hsot"`) {
		t.Fatalf("error %q does not name the rejected mode", err)
	}
}

func TestTailnetHTTPSURL(t *testing.T) {
	cases := []struct {
		name    string
		domains []string
		port    int
		want    string
		wantErr bool
	}{
		{"default https port is omitted", []string{"airlock.example.ts.net."}, 443, "https://airlock.example.ts.net/", false},
		{"custom port is explicit", []string{"airlock.example.ts.net"}, 4443, "https://airlock.example.ts.net:4443/", false},
		{"https certificates disabled", nil, 443, "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := tailnetHTTPSURL(c.domains, c.port)
			if (err != nil) != c.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, c.wantErr)
			}
			if got != c.want {
				t.Fatalf("url = %q, want %q", got, c.want)
			}
		})
	}
}

func TestSplitSet(t *testing.T) {
	cases := []struct {
		in   string
		want map[string]bool
	}{
		{"", map[string]bool{}},
		{"   ", map[string]bool{}},
		{",,", map[string]bool{}},
		{"a", map[string]bool{"a": true}},
		{" a , b ,, c ", map[string]bool{"a": true, "b": true, "c": true}},
	}
	for _, c := range cases {
		if got := splitSet(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("splitSet(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestSortedKeys(t *testing.T) {
	got := sortedKeys(map[string]bool{"c": true, "a": true, "b": true})
	if want := []string{"a", "b", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sortedKeys = %v, want %v", got, want)
	}
	if got := sortedKeys(map[string]bool{}); len(got) != 0 {
		t.Fatalf("sortedKeys of an empty map = %v, want empty", got)
	}
}

// A tailnet node holds both families and the person reading the screen knows the
// IPv4 one. Order in the node's own list is not guaranteed to put it first.
func TestTailnetAddrPrefersIPv4(t *testing.T) {
	node := func(addrs ...string) *tailcfg.Node {
		n := &tailcfg.Node{}
		for _, a := range addrs {
			n.Addresses = append(n.Addresses, netip.MustParsePrefix(a))
		}
		return n
	}
	cases := map[string]struct {
		node *tailcfg.Node
		want string
	}{
		"v6 listed first": {node("fd7a:115c:a1e0::1/128", "100.64.0.1/32"), "100.64.0.1"},
		"v4 only":         {node("100.64.0.1/32"), "100.64.0.1"},
		"v6 only":         {node("fd7a:115c:a1e0::1/128"), "fd7a:115c:a1e0::1"},
		"no addresses":    {node(), ""},
		"no node at all":  {nil, ""},
	}
	for name, c := range cases {
		if got := tailnetAddr(c.node); got != c.want {
			t.Fatalf("%s: got %q, want %q", name, got, c.want)
		}
	}
}

// tailnetAddr being correct is worth nothing if nothing calls it. This drives
// the whole path, from the WhoIs response to the Identity the gate hands on,
// which is the seam where a helper can sit finished and unwired.
func TestIdentityFromWhoIsCarriesTheTailnetAddress(t *testing.T) {
	setFlag(t, allowNodes, "")
	resp := whois("alice@example.com", "laptop")
	resp.Node.Addresses = []netip.Prefix{
		netip.MustParsePrefix("fd7a:115c:a1e0::1/128"),
		netip.MustParsePrefix("100.64.0.7/32"),
	}
	ident := identityFromWhoIs(&fakeWhoIs{resp: resp}, map[string]bool{"alice@example.com": true})

	got, ok := ident(request("100.64.0.7:51234"))
	if !ok {
		t.Fatal("allowed user was refused")
	}
	want := Identity{Node: "laptop", User: "alice@example.com", Addr: "100.64.0.7"}
	if got != want {
		t.Fatalf("identity = %+v, want %+v", got, want)
	}
}
