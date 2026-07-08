//go:build !windows

// This stub lets the module compile on non-Windows hosts (e.g. Linux CI) even
// though the client only runs on Windows. Every operation reports that the
// platform is unsupported.
package tunnel

import (
	"errors"
	"time"
)

// State mirrors the Windows implementation's connection state.
type State int

const (
	StateDisconnected State = iota
	StateConnecting
	StateConnected
	StateError
)

func (s State) String() string { return "Unsupported" }

// Stats mirrors the Windows implementation's counters.
type Stats struct {
	Available     bool
	RxBytes       uint64
	TxBytes       uint64
	LastHandshake time.Time
}

var errUnsupported = errors.New("the Bifrost tunnel is only supported on Windows")

// Manager is a no-op on non-Windows platforms.
type Manager struct{}

// NewManager returns a stub manager.
func NewManager(string) *Manager { return &Manager{} }

func (m *Manager) Up(string) error { return errUnsupported }
func (m *Manager) Down() error     { return errUnsupported }
func (m *Manager) State() State     { return StateDisconnected }
func (m *Manager) Stats() Stats     { return Stats{} }

// IsElevated reports false off Windows.
func IsElevated() bool { return false }

// RelaunchElevated is unsupported off Windows.
func RelaunchElevated() error { return errUnsupported }

// WasElevatedRelaunch reports false off Windows.
func WasElevatedRelaunch() bool { return false }
