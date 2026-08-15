package main

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Device is one node that has authenticated at least once. The registry is what
// the recipient picker and the pairing screen read, and what the identity gate
// consults for revocation.
type Device struct {
	Node      string    `json:"node"`
	User      string    `json:"user"`
	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`
	Paired    bool      `json:"paired"`
	Allowed   bool      `json:"allowed"`
}

type Devices struct {
	path         string
	defaultAllow bool

	mu     sync.RWMutex
	byNode map[string]Device
	// lastSaveErr holds the most recent persistence failure. A registry that
	// cannot write is a degraded security posture, not a cosmetic problem: the
	// allowlist on disk is what survives a restart, so a silent write failure
	// would readmit a revoked device the next time the process starts.
	lastSaveErr error
}

func NewDevices(dir string, defaultAllow bool) (*Devices, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	d := &Devices{
		path:         filepath.Join(dir, "devices.json"),
		defaultAllow: defaultAllow,
		byNode:       map[string]Device{},
	}
	b, err := os.ReadFile(d.path)
	if errors.Is(err, os.ErrNotExist) {
		return d, nil
	}
	if err != nil {
		return nil, err
	}
	var list []Device
	if err := json.Unmarshal(b, &list); err != nil {
		return nil, err
	}
	for _, dev := range list {
		d.byNode[dev.Node] = dev
	}
	return d, nil
}

// Seen records a node's authentication. Registration is not authorization: a
// device is recorded whether or not it is allowed, so the pairing screen can
// offer it for approval.
func (d *Devices) Seen(node, user string) Device {
	d.mu.Lock()
	defer d.mu.Unlock()

	now := time.Now().UTC()
	dev, ok := d.byNode[node]
	if !ok {
		// The first device ever seen is admitted regardless of policy. With
		// approval required and an empty registry there is nobody who could
		// approve anyone, so a strict default would lock the server shut.
		allowed := d.defaultAllow || len(d.byNode) == 0
		dev = Device{Node: node, FirstSeen: now, Allowed: allowed}
	}
	dev.User = user
	dev.LastSeen = now
	d.byNode[node] = dev
	// The signature returns only a Device, so a persistence failure cannot reach
	// the caller. It must not vanish either: an unrecorded registration means the
	// on-disk allowlist is stale, and after a restart an empty registry bootstraps
	// the next node straight in.
	if err := d.saveLocked(); err != nil {
		log.Printf("devices: persisting %s failed: %v", node, err)
	}
	return dev
}

// SaveErr reports the most recent persistence failure, or nil if the last write
// landed. The wiring layer surfaces it on the health route so an operator can
// see that revocations are no longer durable.
func (d *Devices) SaveErr() error {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.lastSaveErr
}

// Allowed is called on every request, so revoking a device takes effect on its
// next call with no restart.
func (d *Devices) Allowed(node string) bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	dev, ok := d.byNode[node]
	return ok && dev.Allowed
}

func (d *Devices) SetAllowed(node string, allowed bool) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	dev, ok := d.byNode[node]
	if !ok {
		return ErrNotFound
	}
	dev.Allowed = allowed
	d.byNode[node] = dev
	return d.saveLocked()
}

func (d *Devices) SetPaired(node string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	dev, ok := d.byNode[node]
	if !ok {
		return ErrNotFound
	}
	dev.Paired = true
	d.byNode[node] = dev
	return d.saveLocked()
}

func (d *Devices) List() []Device {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]Device, 0, len(d.byNode))
	for _, dev := range d.byNode {
		out = append(out, dev)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Node < out[j].Node })
	return out
}

func (d *Devices) saveLocked() error {
	out := make([]Device, 0, len(d.byNode))
	for _, dev := range d.byNode {
		out = append(out, dev)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Node < out[j].Node })
	b, err := json.Marshal(out)
	if err == nil {
		err = atomicWrite(d.path, b)
	}
	d.lastSaveErr = err
	return err
}
