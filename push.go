package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// A push service that accepts the connection and then never answers would
// otherwise hold the request open forever: the default transport bounds the dial
// and the TLS handshake but never the response, and webpush-go supplies a client
// with no timeout of its own. One unanswered endpoint must cost a bounded wait,
// not a permanently stuck send.
const pushTimeout = 10 * time.Second

// Every push body is padded to this size before encryption. The library's own
// default is 4096, and a mobile push endpoint registered as a constrained device
// refuses that outright: Mozilla's autopush answers 413 for anything much over
// two kilobytes on such a subscription, which is silent unless the status is
// read, and means a phone is the one device that never hears about an arrival.
//
// A small record also keeps the encrypted routing payload from being padded to
// several kilobytes when its sealed metadata is only a filename and size.
const pushRecordBytes = 1024

// Keep the useful part of a push comfortably below the payload ceilings of the
// browser push services. Metadata is already a compact sealed record in normal
// use, but the record endpoint is configurable and can admit much larger input;
// a pathological filename must not turn the wake-up itself into an oversized
// request. When the rich form does not fit, the routing fields still do and the
// worker can show a generic notification immediately.
const maxPushPayloadBytes = 2048

const (
	pushPayloadVersion = 1
	pushKindArrival    = "arrival"
	pushKindTest       = "test"
	testPushTTL        = 60 * time.Second
)

// The ceiling a push service will honor regardless of what is asked for. Four
// weeks is the documented maximum for both Mozilla's autopush and FCM.
const maxPushTTL = 28 * 24 * 60 * 60

type subscription struct {
	Node string               `json:"node"`
	Sub  webpush.Subscription `json:"sub"`
}

type vapidKeys struct {
	Private string `json:"private"`
	Public  string `json:"public"`
}

// pushMessage is deliberately enough to notify without calling Airlock back.
// Web Push encrypts this body to one browser subscription, and Meta is still
// independently sealed with the household key, so the push provider learns no
// filename. It does see the ordinary delivery metadata: endpoint, timing,
// urgency, payload length and the opaque Topic header.
type pushMessage struct {
	Version   int    `json:"v"`
	Kind      string `json:"kind"`
	ID        string `json:"id,omitempty"`
	Sender    string `json:"sender,omitempty"`
	CreatedAt string `json:"createdAt,omitempty"`
	Complete  bool   `json:"complete"`
	Meta      string `json:"meta,omitempty"`
}

type pushDelivery struct {
	Attempted int
	Accepted  int
}

var errNoPushSubscription = errors.New("this device has no push subscription")

// Pusher owns the VAPID identity and the device subscription list. Both persist
// in the data directory, because regenerating the keys would silently invalidate
// every existing subscription and look exactly like push being broken.
type Pusher struct {
	dir     string
	subject string
	// How long a push service should hold a notification for a device that is
	// not reachable when it is sent. A phone asleep, out of signal, or with its
	// browser not running is the ordinary case rather than the exception, and a
	// notification dropped before the device comes back is one the owner never
	// learns about while the file is still there to collect.
	ttl    uint32
	keys   vapidKeys
	client *http.Client

	mu   sync.Mutex
	subs []subscription
}

func NewPusher(dir, subject string, hold time.Duration) (*Pusher, error) {
	// Never outlive the transfer it announces. A notification that arrives after
	// the sweep has taken the file opens an inbox with nothing in it, which reads
	// as the app losing something rather than as an expiry working correctly.
	seconds := int64(hold / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	if seconds > int64(maxPushTTL) {
		seconds = int64(maxPushTTL)
	}
	p := &Pusher{
		dir:     dir,
		subject: subject,
		ttl:     uint32(seconds),
		client:  &http.Client{Timeout: pushTimeout},
	}

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
//
// The endpoint is the one field here the server later makes a request to, and it
// arrives from the caller, so it is checked rather than trusted. Requiring https
// keeps a device that has been taken over from pointing the server at a plain
// http address on the network it happens to sit on; every real push service
// speaks https anyway.
func (p *Pusher) Subscribe(node string, raw []byte) error {
	var sub webpush.Subscription
	if err := json.Unmarshal(raw, &sub); err != nil {
		return err
	}
	if sub.Endpoint == "" {
		return errors.New("subscription has no endpoint")
	}
	u, err := url.Parse(sub.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return errors.New("subscription endpoint is not an https url")
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

// RemoveNode forgets every push endpoint owned by one device. A node can have
// more than one endpoint after a browser rotation or across profiles, so
// revocation removes the whole set and persists that decision before it is
// reported as successful.
func (p *Pusher) RemoveNode(node string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	kept := make([]subscription, 0, len(p.subs))
	for _, s := range p.subs {
		if s.Node != node {
			kept = append(kept, s)
		}
	}
	if len(kept) == len(p.subs) {
		return nil
	}
	previous := p.subs
	p.subs = kept
	if err := p.saveLocked(); err != nil {
		p.subs = previous
		return err
	}
	return nil
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

func (p *Pusher) targetsForNode(node string) []subscription {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]subscription, 0, len(p.subs))
	for _, s := range p.subs {
		if s.Node == node {
			out = append(out, s)
		}
	}
	return out
}

func marshalArrivalPush(info *TransferInfo) ([]byte, error) {
	if info == nil {
		return nil, errors.New("cannot notify about a nil transfer")
	}
	message := pushMessage{
		Version:   pushPayloadVersion,
		Kind:      pushKindArrival,
		ID:        info.ID,
		Sender:    info.Sender,
		CreatedAt: info.CreatedAt.Format(time.RFC3339Nano),
		Complete:  info.Complete,
		Meta:      info.Meta,
	}
	body, err := json.Marshal(message)
	if err != nil {
		return nil, err
	}
	if len(body) > maxPushPayloadBytes && message.Meta != "" {
		message.Meta = ""
		body, err = json.Marshal(message)
		if err != nil {
			return nil, err
		}
	}
	if len(body) > maxPushPayloadBytes {
		return nil, fmt.Errorf("push payload is %d bytes; limit is %d", len(body), maxPushPayloadBytes)
	}
	return body, nil
}

// Notify wakes the relevant devices with enough encrypted payload to announce
// the transfer without another network request. The filename remains sealed in
// Meta, but the id and sender let a worker that has no key yet show a useful
// generic notification immediately.
//
// The sends run concurrently because they are independent, and because a device
// must not have its wake-up delayed by whatever another device's push service is
// doing. Each one carries its own deadline, so a silent endpoint costs one
// bounded wait on its own goroutine rather than everybody else's notification.
func (p *Pusher) Notify(info *TransferInfo) {
	body, err := marshalArrivalPush(info)
	if err != nil {
		log.Printf("push payload: %v", err)
		return
	}
	p.send(p.targets(info.To, info.Sender), body, info.ID, p.ttl)
}

// Test sends one short-lived notification to every current subscription for a
// device. Acceptance proves the whole server-side path through the browser's
// push service; the notification itself is the only honest proof that Android
// displayed it.
func (p *Pusher) Test(node string) error {
	targets := p.targetsForNode(node)
	if len(targets) == 0 {
		return errNoPushSubscription
	}
	body, err := json.Marshal(pushMessage{Version: pushPayloadVersion, Kind: pushKindTest})
	if err != nil {
		return err
	}
	delivery := p.send(targets, body, "airlock-test", uint32(testPushTTL/time.Second))
	if delivery.Accepted == 0 {
		return fmt.Errorf("no push service accepted the test notification")
	}
	return nil
}

func (p *Pusher) send(targets []subscription, body []byte, topic string, ttl uint32) pushDelivery {
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		dead     []string
		accepted int
	)
	// ponytail: one goroutine per subscribed device, unbounded. A tailnet holds a
	// handful of personal devices, so the fan-out is a handful of stalled requests
	// at worst. If the device list ever grows past that, feed the sends through a
	// worker pool instead of spawning per target.
	for _, s := range targets {
		wg.Add(1)
		go func(s subscription) {
			defer wg.Done()
			sub := s.Sub
			res, err := webpush.SendNotification(body, &sub, &webpush.Options{
				HTTPClient:      p.client,
				Subscriber:      p.subject,
				VAPIDPublicKey:  p.keys.Public,
				VAPIDPrivateKey: p.keys.Private,
				TTL:             int(ttl),
				Topic:           topic,
				Urgency:         webpush.UrgencyHigh,
				RecordSize:      pushRecordBytes,
			})
			if err != nil {
				log.Printf("push to %s: %v", s.Node, err)
				return
			}
			res.Body.Close()
			// A push service reports a refusal in the status, not in the error,
			// so a send that never reaches a phone otherwise looks exactly like
			// one that did. Silence here is the reason "no notification arrived"
			// has nowhere to be diagnosed from.
			if res.StatusCode >= 300 {
				log.Printf("push to %s refused: %s", s.Node, res.Status)
			} else {
				mu.Lock()
				accepted++
				mu.Unlock()
			}
			// The push service is the authority on whether an endpoint still
			// exists. These two codes mean it is gone for good, as opposed to a
			// transient failure, so the entry is dropped rather than retried
			// forever.
			if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone {
				mu.Lock()
				dead = append(dead, sub.Endpoint)
				mu.Unlock()
			}
		}(s)
	}
	wg.Wait()
	if len(dead) > 0 {
		p.prune(dead)
	}
	return pushDelivery{Attempted: len(targets), Accepted: accepted}
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
