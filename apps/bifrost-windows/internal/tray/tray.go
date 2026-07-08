// Package tray renders the Bifrost system-tray menu and binds it to the app
// controller. It owns no business logic — every action delegates to the
// controller, and every render is driven by a controller Status snapshot.
package tray

import (
	"fmt"
	"strings"
	"sync"

	"fyne.io/systray"

	"github.com/bifrost-vpn/bifrost-windows/internal/app"
	"github.com/bifrost-vpn/bifrost-windows/internal/tunnel"
	"github.com/bifrost-vpn/bifrost-windows/internal/ui"
)

// maxNodeSlots caps the node picker. systray cannot remove items, so a fixed
// pool is pre-built and shown/hidden as the node set changes.
const maxNodeSlots = 16

// Tray is the system-tray presenter.
type Tray struct {
	ctrl *app.Controller

	mStatus  *systray.MenuItem
	mIP      *systray.MenuItem
	mToggle  *systray.MenuItem
	mNodes   *systray.MenuItem
	slots    []*systray.MenuItem
	mSync    *systray.MenuItem
	mSignIn  *systray.MenuItem
	mAddURL  *systray.MenuItem
	mSignOut *systray.MenuItem
	mQuit    *systray.MenuItem

	mu        sync.Mutex
	slotNodes []string // slot index → nodeID currently shown (or "")
}

// New returns a Tray bound to the given controller.
func New(ctrl *app.Controller) *Tray {
	return &Tray{ctrl: ctrl, slotNodes: make([]string, maxNodeSlots)}
}

// OnReady builds the menu and starts the controller. Pass it to systray.Run.
func (t *Tray) OnReady() {
	systray.SetIcon(iconIdle())
	systray.SetTitle("")
	systray.SetTooltip("Bifrost VPN")

	t.mStatus = systray.AddMenuItem("Not connected", "")
	t.mStatus.Disable()
	t.mIP = systray.AddMenuItem("", "")
	t.mIP.Disable()
	t.mIP.Hide()

	systray.AddSeparator()
	t.mToggle = systray.AddMenuItem("Connect", "Connect or disconnect the VPN")

	t.mNodes = systray.AddMenuItem("Location", "Choose which node to connect through")
	for i := 0; i < maxNodeSlots; i++ {
		slot := t.mNodes.AddSubMenuItemCheckbox("", "", false)
		slot.Hide()
		t.slots = append(t.slots, slot)
	}

	t.mSync = systray.AddMenuItem("Refresh", "Refresh nodes and config")

	systray.AddSeparator()
	t.mSignIn = systray.AddMenuItem("Sign in…", "Sign in with your Bifrost account")
	t.mAddURL = systray.AddMenuItem("Add device from URL…", "Provision from a provision URL")
	t.mSignOut = systray.AddMenuItem("Sign out", "Disconnect and clear this device")
	t.mSignOut.Hide()

	systray.AddSeparator()
	t.mQuit = systray.AddMenuItem("Quit", "Exit Bifrost")

	t.wire()

	// Drive all rendering from controller status changes.
	t.ctrl.Start(func(s app.Status) { t.render(s) })
}

// OnExit is the systray shutdown hook.
func (t *Tray) OnExit() { t.ctrl.Stop() }

// wire attaches click handlers. Handlers that block (dialogs, network) run in
// their own goroutines so the systray event loop is never stalled.
func (t *Tray) wire() {
	go clickLoop(t.mToggle, func() { go t.ctrl.Toggle() })
	go clickLoop(t.mSync, func() { go t.ctrl.SyncNow() })
	go clickLoop(t.mSignIn, t.doSignIn)
	go clickLoop(t.mAddURL, t.doAddURL)
	go clickLoop(t.mSignOut, t.doSignOut)
	go clickLoop(t.mQuit, func() { systray.Quit() })

	for i := range t.slots {
		i := i
		go clickLoop(t.slots[i], func() { t.selectSlot(i) })
	}
}

// render updates every menu item from a status snapshot.
func (t *Tray) render(s app.Status) {
	systray.SetIcon(iconFor(s.Tunnel))
	systray.SetTooltip(tooltip(s))

	t.mStatus.SetTitle(statusLine(s))

	if s.AssignedIP != "" {
		t.mIP.SetTitle("IP: " + s.AssignedIP)
		t.mIP.Show()
	} else {
		t.mIP.Hide()
	}

	// Connect / disconnect
	if s.Tunnel == tunnel.StateConnected || s.Tunnel == tunnel.StateConnecting {
		t.mToggle.SetTitle("Disconnect")
	} else {
		t.mToggle.SetTitle("Connect")
	}
	setEnabled(t.mToggle, s.Provisioned)
	setEnabled(t.mSync, s.Provisioned)

	// Node picker
	t.renderNodes(s)

	// Sign-in / out visibility
	if s.Provisioned {
		t.mSignOut.Show()
	} else {
		t.mSignOut.Hide()
	}
}

// renderNodes fills the fixed slot pool from the current node set.
func (t *Tray) renderNodes(s app.Status) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if len(s.Nodes) <= 1 {
		t.mNodes.Hide() // nothing to choose between
	} else {
		t.mNodes.Show()
	}

	for i, slot := range t.slots {
		if i >= len(s.Nodes) {
			slot.Hide()
			t.slotNodes[i] = ""
			continue
		}
		node := s.Nodes[i]
		t.slotNodes[i] = node.NodeID

		label := node.Label()
		if node.IsPrimary() {
			label += "  (primary)"
		}
		slot.SetTitle(label)
		if node.NodeID == s.SelectedNodeID {
			slot.Check()
		} else {
			slot.Uncheck()
		}
		slot.Show()
	}
}

// selectSlot resolves a slot index to its current node id and selects it.
func (t *Tray) selectSlot(i int) {
	t.mu.Lock()
	nodeID := ""
	if i < len(t.slotNodes) {
		nodeID = t.slotNodes[i]
	}
	t.mu.Unlock()
	if nodeID != "" {
		go t.ctrl.SelectNode(nodeID)
	}
}

// ── Actions ─────────────────────────────────────────────────────────────────

func (t *Tray) doSignIn() {
	go func() {
		user, pass, ok := ui.PromptLogin()
		if !ok {
			return
		}
		t.ctrl.LoginAndProvision(user, pass)
		if err := t.ctrl.Status().LastError; err != "" {
			ui.ShowError(err)
		}
	}()
}

func (t *Tray) doAddURL() {
	go func() {
		url, ok := ui.PromptProvisionURL()
		if !ok {
			return
		}
		t.ctrl.ProvisionFromURL(url)
		if err := t.ctrl.Status().LastError; err != "" {
			ui.ShowError(err)
		}
	}()
}

func (t *Tray) doSignOut() {
	go func() {
		if !ui.Confirm("Sign out and disconnect this device?") {
			return
		}
		t.ctrl.Logout()
	}()
}

// ── Rendering helpers ───────────────────────────────────────────────────────

func iconFor(s tunnel.State) []byte {
	switch s {
	case tunnel.StateConnected:
		return iconConnected()
	case tunnel.StateConnecting:
		return iconConnecting()
	case tunnel.StateError:
		return iconError()
	default:
		return iconIdle()
	}
}

func statusLine(s app.Status) string {
	if !s.Provisioned {
		return "Not connected — sign in"
	}
	node := s.SelectedNode()
	name := ""
	if node != nil {
		name = node.Name
	}
	switch s.Tunnel {
	case tunnel.StateConnected:
		if name != "" {
			return "● Connected — " + name
		}
		return "● Connected"
	case tunnel.StateConnecting:
		return "◌ Connecting…"
	case tunnel.StateError:
		if s.LastError != "" {
			return "⚠ " + truncate(s.LastError, 48)
		}
		return "⚠ Error"
	default:
		return "○ Disconnected"
	}
}

func tooltip(s app.Status) string {
	if s.Tunnel == tunnel.StateConnected && s.Stats.Available {
		return fmt.Sprintf("Bifrost VPN — ↓ %s  ↑ %s",
			humanBytes(s.Stats.RxBytes), humanBytes(s.Stats.TxBytes))
	}
	return "Bifrost VPN"
}

func setEnabled(m *systray.MenuItem, enabled bool) {
	if enabled {
		m.Enable()
	} else {
		m.Disable()
	}
}

// clickLoop forwards every click on an item to handler.
func clickLoop(m *systray.MenuItem, handler func()) {
	for range m.ClickedCh {
		handler()
	}
}

func humanBytes(b uint64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := uint64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
