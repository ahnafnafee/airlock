package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	webpush "github.com/SherClockHolmes/webpush-go"
)

type subscription struct {
	Node string               `json:"node"`
	Sub  webpush.Subscription `json:"sub"`
}

type vapidKeys struct {
	Private string `json:"private"`
	Public  string `json:"public"`
}

// Pusher owns the VAPID identity and the device subscription list. Both persist
// in the data directory, because regenerating the keys would silently invalidate
// every existing subscription and look exactly like push being broken.
type Pusher struct {
	dir     string
	subject string
	keys    vapidKeys

	mu   sync.Mutex
	subs []subscription
}

func NewPusher(dir, subject string) (*Pusher, error) {
	p := &Pusher{dir: dir, subject: subject}

	// Only a genuinely absent file may be replaced. Any other read failure is
	// reported rather than treated as "no keys yet", because generating a fresh
	// pair over a key file that is merely unreadable would break every device
	// already subscribed, in the one way this type exists to prevent.
	keyPath := filepath.Join(dir, "vapid.json")
	switch b, err := os.ReadFile(keyPath); {
	case err == nil:
		if err := json.Unmarshal(b, &p.keys); err != nil {
			return nil, fmt.Errorf("reading %s: %w", keyPath, err)
		}
	case !errors.Is(err, os.ErrNotExist):
		return nil, err
	default:
		priv, pub, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			return nil, err
		}
		p.keys = vapidKeys{Private: priv, Public: pub}
		out, err := json.Marshal(p.keys)
		if err != nil {
			return nil, err
		}
		if err := atomicWrite(keyPath, out); err != nil {
			return nil, err
		}
	}

	subPath := filepath.Join(dir, "subs.json")
	switch b, err := os.ReadFile(subPath); {
	case err == nil:
		if err := json.Unmarshal(b, &p.subs); err != nil {
			return nil, fmt.Errorf("reading %s: %w", subPath, err)
		}
	case !errors.Is(err, os.ErrNotExist):
		return nil, err
	}
	return p, nil
}

func (p *Pusher) PublicKey() string { return p.keys.Public }

func (p *Pusher) Count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.subs)
}

// Subscribe records one device's push endpoint. The endpoint is the identity: a
// browser hands back the same one every time until it rotates, so a repeat
// subscription replaces its predecessor instead of growing the list.
func (p *Pusher) Subscribe(node string, raw []byte) error {
	var sub webpush.Subscription
	if err := json.Unmarshal(raw, &sub); err != nil {
		return err
	}
	if sub.Endpoint == "" {
		return errors.New("subscription has no endpoint")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.subs {
		if p.subs[i].Sub.Endpoint == sub.Endpoint {
			p.subs[i] = subscription{Node: node, Sub: sub}
			return p.saveLocked()
		}
	}
	p.subs = append(p.subs, subscription{Node: node, Sub: sub})
	return p.saveLocked()
}

// targets picks the devices to wake. The sender is never one of them, and an
// addressed transfer wakes only its recipients.
func (p *Pusher) targets(recipients []string, sender string) []subscription {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]subscription, 0, len(p.subs))
	for _, s := range p.subs {
		if s.Node == sender {
			continue
		}
		if len(recipients) > 0 && !addressedTo(recipients, s.Node) {
			continue
		}
		out = append(out, s)
	}
	return out
}

// Notify wakes the relevant devices. The push deliberately carries no useful
// payload: the filename lives behind the encryption boundary and this message
// travels through a third-party push service, so the worker fetches and
// decrypts the name locally instead.
func (p *Pusher) Notify(recipients []string, sender string) {
	var dead []string
	for _, s := range p.targets(recipients, sender) {
		sub := s.Sub
		res, err := webpush.SendNotification([]byte("{}"), &sub, &webpush.Options{
			Subscriber:      p.subject,
			VAPIDPublicKey:  p.keys.Public,
			VAPIDPrivateKey: p.keys.Private,
			TTL:             3600,
		})
		if err != nil {
			log.Printf("push to %s: %v", s.Node, err)
			continue
		}
		res.Body.Close()
		// The push service is the authority on whether an endpoint still exists.
		// These two codes mean it is gone for good, as opposed to a transient
		// failure, so the entry is dropped rather than retried forever.
		if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone {
			dead = append(dead, sub.Endpoint)
		}
	}
	if len(dead) > 0 {
		p.prune(dead)
	}
}

func (p *Pusher) prune(endpoints []string) {
	gone := make(map[string]bool, len(endpoints))
	for _, e := range endpoints {
		gone[e] = true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	kept := p.subs[:0]
	for _, s := range p.subs {
		if !gone[s.Sub.Endpoint] {
			kept = append(kept, s)
		}
	}
	p.subs = kept
	if err := p.saveLocked(); err != nil {
		log.Printf("prune: %v", err)
	}
}

func (p *Pusher) saveLocked() error {
	b, err := json.Marshal(p.subs)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(p.dir, "subs.json"), b)
}
