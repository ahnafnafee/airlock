package main

import "sync"

// Events is a fan-out of "something arrived for you" nudges. It carries no
// detail: a client that receives one re-fetches its inbox, which keeps every
// filename behind the encryption boundary and makes a dropped event harmless.
//
// addressed to one node and carry an opaque payload this package never parses,
// and unlike a nudge they may not be dropped.
type Events struct {
	mu   sync.Mutex
	next int
	subs map[int]subscriber
}

type subscriber struct {
	node string
	ch   chan string
}

func NewEvents() *Events {
	return &Events{subs: map[int]subscriber{}}
}

// Subscribe returns a channel and the function that releases it. The caller must
// call the returned function, normally with defer, or the subscription leaks for
// the lifetime of the process.
func (e *Events) Subscribe(node string) (<-chan string, func()) {
	e.mu.Lock()
	defer e.mu.Unlock()

	id := e.next
	e.next++
	// Nudges collapse, so one slot would do for them. Signalling messages do
	// not: dropping an answer or a candidate stalls a handshake that has no
	// other way to recover.
	//
	// ponytail: sixteen slots buy room for one handshake's worth of candidates
	// against a stream that is reading at all, and no more. A reader that has
	// stopped entirely still loses messages, silently, because Send drops
	// rather than blocks and a wedged stream must never hold the lock. The
	// ceiling is a peer whose stream stalls mid-handshake: it hangs until the
	// caller times out. Lift it by closing a stream whose buffer fills, so the
	// peer reconnects and starts a fresh handshake instead of waiting on a
	// half-delivered one.
	ch := make(chan string, 16)
	e.subs[id] = subscriber{node: node, ch: ch}

	var once sync.Once
	return ch, func() {
		once.Do(func() {
			e.mu.Lock()
			defer e.mu.Unlock()
			if s, ok := e.subs[id]; ok {
				delete(e.subs, id)
				close(s.ch)
			}
		})
	}
}

func (e *Events) Count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.subs)
}

// Disconnect closes every stream for one node. Revocation uses it so presence
// stops advertising a device that the very next request will reject.
func (e *Events) Disconnect(node string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for id, s := range e.subs {
		if s.node != node {
			continue
		}
		delete(e.subs, id)
		close(s.ch)
	}
}

// Publish nudges every device that should care, never the sender. It drops
// rather than blocks when a subscriber is not reading, because a device that
// has stopped reading must not be able to wedge somebody else's upload.
//
// The send happens under the same lock the release closure takes, which is what
// keeps a subscription that ends mid-publish from being sent to after its
// channel is closed.
// The sender rides along so a recipient's notice can name the device the file
// came from. It is excluded from delivery and carried in the message, which are
// two different uses of the same value.
func (e *Events) Publish(recipients []string, sender string) {
	e.publish(recipients, sender, "inbox:"+sender)
}

// Nudge tells every affected party to re-read transfer state. Unlike Publish,
// it deliberately includes the actor: another tab on that same device may be
// showing the inbox or queue that just changed.
func (e *Events) Nudge(recipients []string) {
	e.publish(recipients, "", "inbox:")
}

// PublishProgress says that one device has moved along with one transfer. It is
// its own event rather than a nudge because a nudge means "re-read the inbox",
// and a save ticking a hundred times would have every other device re-reading
// and re-decrypting the whole list a hundred times to learn one number.
//
// What travels is a transfer id and a device name, both of which every receiver
// can already see. How far along the save is deliberately does not travel: it is
// read from the endpoint that already scopes it to people entitled to the
// transfer, so this stays a pointer at what changed rather than a second,
// unscoped copy of it.
//
// The saving device is excluded. It is the one device that already knows.
func (e *Events) PublishProgress(recipients []string, id, node string) {
	e.publish(recipients, node, "progress:"+id+":"+node)
}

func (e *Events) publish(recipients []string, excluded, message string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, s := range e.subs {
		if excluded != "" && s.node == excluded {
			continue
		}
		if len(recipients) > 0 && !addressedTo(recipients, s.node) {
			continue
		}
		select {
		case s.ch <- message:
		default:
		}
	}
}

// PublishDevices tells every open approved client that device eligibility
// changed. The event carries no detail; clients re-read the device registry.
func (e *Events) PublishDevices() {
	e.publish(nil, "", "devices")
}

// Online reports which nodes hold at least one open stream. A device with
// several tabs open is still one device.
func (e *Events) Online() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	seen := map[string]bool{}
	out := []string{}
	for _, s := range e.subs {
		if !seen[s.node] {
			seen[s.node] = true
			out = append(out, s.node)
		}
	}
	return out
}
