package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"tailscale.com/client/local"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

// whoIser is the slice of the Tailscale local client this file needs. Both the
// embedded client and the host daemon's client satisfy it, which is what lets
// one identity implementation serve both modes.
type whoIser interface {
	WhoIs(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error)
	Status(ctx context.Context) (*ipnstate.Status, error)
}

func tailscaleListener() (net.Listener, IdentityFunc, error) {
	switch *tailscaleMode {
	case "host":
		return hostListener()
	case "embedded":
		return embeddedListener()
	default:
		return nil, nil, fmt.Errorf("unknown --tailscale-mode %q, want host or embedded", *tailscaleMode)
	}
}

// hostListener serves through the machine's running tailscaled. That daemon owns
// the kernel TUN path and Tailscale's TSO, GRO, GSO and mmsg throughput work.
// The embedded netstack in tsnet has none of it, which is why this is the
// default for a tool whose product is throughput.
func hostListener() (net.Listener, IdentityFunc, error) {
	lc := newLocalClient()
	ctx := context.Background()

	st, err := lc.Status(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf(
			"tailscaled status failed, is the daemon running and may this process reach its socket: %w", err)
	}
	if len(st.TailscaleIPs) == 0 {
		return nil, nil, errors.New("tailscaled reports no tailnet address")
	}
	url, err := tailnetHTTPSURL(st.CertDomains, *port)
	if err != nil {
		return nil, nil, err
	}

	users, err := resolveAllowedUsers(ctx, lc)
	if err != nil {
		return nil, nil, err
	}
	log.Printf("host mode, allowing tailnet users %v", sortedKeys(users))

	// Bind the tailnet addresses specifically rather than every interface, so
	// the listener is never reachable from the LAN even by accident. Every
	// address, not just the first, because a client that resolves the node's
	// name to the tailnet IPv6 address would otherwise find nothing listening.
	ips := make([]string, 0, len(st.TailscaleIPs))
	for _, ip := range st.TailscaleIPs {
		ips = append(ips, ip.String())
	}
	raw, err := listenAll(listenAddrs(ips, *port), *port)
	if err != nil {
		return nil, nil, err
	}
	// GetCertificate fetches and renews the tailnet certificate through the
	// daemon, so there is no rotation to schedule here.
	ln := tls.NewListener(raw, &tls.Config{GetCertificate: lc.GetCertificate})

	// The MagicDNS name is the only URL that works: GetCertificate has no
	// certificate for an IP literal, so reaching the same listener by address
	// fails during the handshake.
	log.Printf("open %s on any device on your tailnet", url)
	return ln, identityFromWhoIs(lc, users), nil
}

// embeddedListener joins the tailnet as its own node, needing nothing installed
// on the host. Slower than host mode, and kept for exactly that portability.
func embeddedListener() (net.Listener, IdentityFunc, error) {
	ts := &tsnet.Server{
		Hostname: *hostname,
		Dir:      filepath.Join(*dataDir, "tsnet"),
		AuthKey:  os.Getenv("TS_AUTHKEY"),
	}
	ctx := context.Background()
	if _, err := ts.Up(ctx); err != nil {
		return nil, nil, fmt.Errorf("tsnet up: %w", err)
	}
	lc, err := ts.LocalClient()
	if err != nil {
		return nil, nil, err
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("tsnet status: %w", err)
	}
	url, err := tailnetHTTPSURL(st.CertDomains, *port)
	if err != nil {
		return nil, nil, err
	}

	users, err := resolveAllowedUsers(ctx, lc)
	if err != nil {
		return nil, nil, err
	}
	log.Printf("embedded mode, allowing tailnet users %v", sortedKeys(users))

	// ListenTLS serves the tailnet certificate for <hostname>.<tailnet>.ts.net.
	// It requires HTTPS Certificates to be enabled in the admin console; without
	// that the browser has no secure context and the client design collapses.
	ln, err := ts.ListenTLS("tcp", fmt.Sprintf(":%d", *port))
	if err != nil {
		return nil, nil, fmt.Errorf("listen tls on port %d: %w", *port, err)
	}
	log.Printf("open %s on any device on your tailnet", url)
	return ln, identityFromWhoIs(lc, users), nil
}

// tailnetHTTPSURL turns the certificate name Tailscale assigned this node into
// the one browser URL an operator should use. IP literals do not match the
// tailnet certificate, and spelling out :443 is needless friction when copying
// the startup line to another device.
func tailnetHTTPSURL(domains []string, port int) (string, error) {
	if len(domains) == 0 {
		return "", errors.New(
			"this tailnet has no HTTPS certificate domains. Enable HTTPS Certificates " +
				"on the DNS page of the Tailscale admin console, then restart")
	}
	name := strings.TrimSuffix(domains[0], ".")
	if port == 443 {
		return "https://" + name + "/", nil
	}
	return fmt.Sprintf("https://%s:%d/", name, port), nil
}

func identityFromWhoIs(lc whoIser, users map[string]bool) IdentityFunc {
	nodes := splitSet(*allowNodes)
	return func(r *http.Request) (Identity, bool) {
		if isLoopback(r.RemoteAddr) {
			// A tailnet identity cannot be derived from a loopback connection.
			// Logged distinctly because the symptom, 403 on everything
			// including static assets, otherwise reads as a permissions bug.
			log.Printf("refusing a loopback request from %s: reach Airlock by its "+
				"tailnet name rather than through a local proxy", r.RemoteAddr)
			return Identity{}, false
		}
		whois, err := lc.WhoIs(r.Context(), r.RemoteAddr)
		if err != nil || whois.Node == nil || whois.UserProfile == nil {
			return Identity{}, false
		}
		// Tagged devices have no human owner, so they can never match a login
		// allowlist and are refused here rather than falling through.
		if whois.Node.IsTagged() {
			return Identity{}, false
		}
		user := whois.UserProfile.LoginName
		if !users[user] {
			return Identity{}, false
		}
		node := strings.TrimSuffix(whois.Node.ComputedName, ".")
		if len(nodes) > 0 && !nodes[node] {
			return Identity{}, false
		}
		return Identity{Node: node, User: user, Addr: tailnetAddr(whois.Node)}, true
	}
}

// resolveAllowedUsers defaults the tailnet-level allowlist to whoever owns the
// server's own node, which is the safe answer on a shared tailnet and needs no
// configuration on a personal one. Per-device approval is a separate layer, held
// in the device registry.
func resolveAllowedUsers(ctx context.Context, lc whoIser) (map[string]bool, error) {
	if set := splitSet(*allowUsers); len(set) > 0 {
		return set, nil
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return nil, fmt.Errorf("status: %w", err)
	}
	if st.Self == nil {
		return nil, errors.New("tailscale status has no self node")
	}
	owner, ok := st.User[st.Self.UserID]
	if !ok || owner.LoginName == "" {
		return nil, errors.New("cannot resolve the node owner; pass --allow-users")
	}
	return map[string]bool{owner.LoginName: true}, nil
}

func splitSet(csv string) map[string]bool {
	set := map[string]bool{}
	for _, s := range strings.Split(csv, ",") {
		if s = strings.TrimSpace(s); s != "" {
			set[s] = true
		}
	}
	return set
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// newLocalClient talks to the tailscaled running on this machine over its local
// API socket. Isolated into its own function because this package path has moved
// between Tailscale releases.
func newLocalClient() *local.Client { return &local.Client{} }

// tailnetAddr is the node's own address on the tailnet, preferring IPv4 because
// that is the form a person recognizes and types. It is informational only:
// nothing authorizes on it, WhoIs having already proved the caller.
func tailnetAddr(node *tailcfg.Node) string {
	if node == nil {
		return ""
	}
	var v6 string
	for _, p := range node.Addresses {
		ip := p.Addr()
		if ip.Is4() {
			return ip.String()
		}
		if v6 == "" {
			v6 = ip.String()
		}
	}
	return v6
}
