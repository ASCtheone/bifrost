//go:build windows

// Package tunnel applies WireGuard configurations on Windows by driving the
// WireGuard tunnel service (the same mechanism the official WireGuard for
// Windows client uses): wireguard.exe /installtunnelservice <conf>.
package tunnel

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// State is the coarse connection state surfaced to the UI.
type State int

const (
	StateDisconnected State = iota
	StateConnecting
	StateConnected
	StateError
)

func (s State) String() string {
	switch s {
	case StateConnecting:
		return "Connecting"
	case StateConnected:
		return "Connected"
	case StateError:
		return "Error"
	default:
		return "Disconnected"
	}
}

// tunnelName is the WireGuard tunnel identity; it derives from the .conf
// basename and yields the service name "WireGuardTunnel$bifrost".
const tunnelName = "bifrost"

func serviceName() string { return `WireGuardTunnel$` + tunnelName }

// Manager owns the single Bifrost tunnel on this machine.
type Manager struct {
	dir string // directory to write the active .conf into
}

// NewManager returns a tunnel Manager that stores its active config under dir.
func NewManager(dir string) *Manager { return &Manager{dir: dir} }

func (m *Manager) confPath() string { return filepath.Join(m.dir, tunnelName+".conf") }

// Up writes the given WireGuard config and (re)installs the tunnel service so
// the tunnel comes up. Any previously running Bifrost tunnel is replaced.
func (m *Manager) Up(wgConfig string) error {
	wg, err := wireguardExe()
	if err != nil {
		return err
	}
	// Replace an existing tunnel so a config change takes effect cleanly.
	if m.serviceExists() {
		_ = m.Down()
	}
	if err := os.WriteFile(m.confPath(), []byte(normaliseConfig(wgConfig)), 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if err := run(wg, "/installtunnelservice", m.confPath()); err != nil {
		return fmt.Errorf("install tunnel service: %w", err)
	}
	return nil
}

// Down stops and removes the tunnel service. It is a no-op when not running.
func (m *Manager) Down() error {
	if !m.serviceExists() {
		return nil
	}
	wg, err := wireguardExe()
	if err != nil {
		return err
	}
	if err := run(wg, "/uninstalltunnelservice", tunnelName); err != nil {
		return fmt.Errorf("uninstall tunnel service: %w", err)
	}
	return nil
}

// State reports the current tunnel state by inspecting the Windows service.
func (m *Manager) State() State {
	man, err := mgr.Connect()
	if err != nil {
		return StateDisconnected
	}
	defer man.Disconnect()

	s, err := openService(man, serviceName())
	if err != nil {
		return StateDisconnected
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return StateError
	}
	switch status.State {
	case svc.Running:
		return StateConnected
	case svc.StartPending, svc.ContinuePending:
		return StateConnecting
	case svc.StopPending, svc.Stopped, svc.Paused, svc.PausePending:
		return StateDisconnected
	default:
		return StateDisconnected
	}
}

func (m *Manager) serviceExists() bool {
	man, err := mgr.Connect()
	if err != nil {
		return false
	}
	defer man.Disconnect()
	s, err := openService(man, serviceName())
	if err != nil {
		return false
	}
	_ = s.Close()
	return true
}

// openService opens a service by name without requiring enumerate rights.
func openService(m *mgr.Mgr, name string) (*mgr.Service, error) {
	h, err := windows.OpenService(m.Handle, windows.StringToUTF16Ptr(name),
		windows.SERVICE_QUERY_STATUS|windows.SERVICE_QUERY_CONFIG)
	if err != nil {
		return nil, err
	}
	return &mgr.Service{Name: name, Handle: h}, nil
}

// wireguardExe locates wireguard.exe (default install path, then PATH).
func wireguardExe() (string, error) {
	def := filepath.Join(programFiles(), "WireGuard", "wireguard.exe")
	if _, err := os.Stat(def); err == nil {
		return def, nil
	}
	if p, err := exec.LookPath("wireguard"); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("WireGuard for Windows is not installed (wireguard.exe not found). Install it from https://www.wireguard.com/install/")
}

func programFiles() string {
	if p := os.Getenv("ProgramFiles"); p != "" {
		return p
	}
	return `C:\Program Files`
}

// run executes a command, wrapping non-zero exits with any captured output.
func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			return err
		}
		return fmt.Errorf("%s: %s", err, msg)
	}
	return nil
}

// normaliseConfig ensures CRLF line endings, which the WireGuard service parser
// on Windows is happiest with.
func normaliseConfig(cfg string) string {
	cfg = strings.ReplaceAll(cfg, "\r\n", "\n")
	return strings.ReplaceAll(cfg, "\n", "\r\n")
}
