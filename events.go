package main

import "sync"

// Events is a fan-out of "something arrived for you" nudges. It carries no
// detail: a client that receives one re-fetches its inbox, which keeps every
// filename behind the encryption boundary and makes a dropped event harmless.
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
	// Buffered by one: a nudge already waiting makes a second one redundant,
	// since the client re-reads the whole inbox either way.
	ch := make(chan string, 1)
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

// Publish nudges every device that should care, never the sender. It drops
// rather than blocks when a subscriber is not reading, because a device that
// has stopped reading must not be able to wedge somebody else's upload.
//
// The send happens under the same lock the release closure takes, which is what
// keeps a subscription that ends mid-publish from being sent to after its
// channel is closed.
func (e *Events) Publish(recipients []string, sender string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, s := range e.subs {
		if s.node == sender {
			continue
		}
		if len(recipients) > 0 && !addressedTo(recipients, s.node) {
			continue
		}
		select {
		case s.ch <- "inbox":
		default:
		}
	}
}
