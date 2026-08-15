package main

// Pusher owns Web Push credentials and subscriptions. Phase 2 fills these in.
// The zero value is a working no-op, so the HTTP layer can be built and tested
// without push.
//
// ponytail: notifications are silently dropped until the real implementation
// lands. Fill in PublicKey and Notify with VAPID keys and a subscription store.
type Pusher struct{}

func (p *Pusher) PublicKey() string { return "" }

// Notify wakes the given recipient nodes. An empty recipients slice means every
// device except the sender.
func (p *Pusher) Notify(recipients []string, sender string) {}
