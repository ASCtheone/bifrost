// Package app is the client controller: it owns the provisioning state, drives
// the tunnel, and runs the background loops (status polling, periodic refresh,
// and failover) that keep the connection healthy.
package app

import (
	"context"
	"sync"
	"time"

	"github.com/bifrost-vpn/bifrost-windows/internal/api"
	"github.com/bifrost-vpn/bifrost-windows/internal/auth"
	"github.com/bifrost-vpn/bifrost-windows/internal/config"
	"github.com/bifrost-vpn/bifrost-windows/internal/tunnel"
)

const (
	statusPollInterval = 3 * time.Second
	refreshInterval    = 5 * time.Minute
	handshakeStaleFor  = 180 * time.Second // a live tunnel handshakes ~every 2min
	failoverGrace      = 30 * time.Second  // don't judge a tunnel dead right after connect
)

// Status is an immutable snapshot of the client state handed to the UI.
type Status struct {
	Provisioned    bool
	DeviceName     string
	AssignedIP     string
	IsAdmin        bool
	Nodes          []config.NodeConfig
	SelectedNodeID string
	Tunnel         tunnel.State
	Stats          tunnel.Stats
	Syncing        bool
	LastError      string
}

// SelectedNode returns the node the status has selected, if any.
func (s Status) SelectedNode() *config.NodeConfig {
	for i := range s.Nodes {
		if s.Nodes[i].NodeID == s.SelectedNodeID {
			return &s.Nodes[i]
		}
	}
	if len(s.Nodes) > 0 {
		return &s.Nodes[0]
	}
	return nil
}

// Controller coordinates auth, provisioning, storage and the tunnel.
type Controller struct {
	endpoints config.Endpoints
	store     *config.Store
	creds     *auth.CredStore
	cognito   *auth.Cognito
	apic      *api.Client
	tun       *tunnel.Manager

	mu       sync.Mutex
	cfg      *config.StoredConfig
	tunState tunnel.State
	stats    tunnel.Stats
	syncing  bool
	lastErr  string

	connectedAt time.Time
	lastFailover time.Time

	onChange func(Status)
	ctx      context.Context
	cancel   context.CancelFunc
}

// New builds a Controller from an endpoints config and the tunnel data dir.
func New(endpoints config.Endpoints, store *config.Store, tun *tunnel.Manager) *Controller {
	return &Controller{
		endpoints: endpoints,
		store:     store,
		creds:     auth.NewCredStore(),
		cognito:   auth.NewCognito(endpoints.Region, endpoints.ClientID),
		apic:      api.New(),
		tun:       tun,
	}
}

// Start loads persisted state, wires the change callback, and launches the
// background loops. onChange is invoked on the caller's behalf whenever the
// observable status changes.
func (c *Controller) Start(onChange func(Status)) {
	c.onChange = onChange
	c.ctx, c.cancel = context.WithCancel(context.Background())

	if cfg, err := c.store.Load(); err == nil && cfg != nil {
		c.mu.Lock()
		c.cfg = cfg
		c.mu.Unlock()
	}
	// Reflect the real tunnel state at launch (it may already be up).
	c.refreshTunnelState()
	c.emit()

	go c.pollLoop()
	go c.refreshLoop()

	// Best-effort refresh at launch to pick up node/role changes.
	go c.SyncNow()
}

// Stop cancels the background loops.
func (c *Controller) Stop() {
	if c.cancel != nil {
		c.cancel()
	}
}

// ── Snapshot ────────────────────────────────────────────────────────────────

func (c *Controller) snapshot() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := Status{
		Tunnel:    c.tunState,
		Stats:     c.stats,
		Syncing:   c.syncing,
		LastError: c.lastErr,
	}
	if c.cfg != nil {
		st.Provisioned = len(c.cfg.Nodes) > 0
		st.DeviceName = c.cfg.DeviceName
		st.AssignedIP = c.cfg.AssignedIP
		st.IsAdmin = c.cfg.IsAdmin
		st.Nodes = c.cfg.Nodes
		if sel := c.cfg.SelectedNode(); sel != nil {
			st.SelectedNodeID = sel.NodeID
		}
	}
	return st
}

// Status returns the current status snapshot.
func (c *Controller) Status() Status { return c.snapshot() }

func (c *Controller) emit() {
	if c.onChange != nil {
		c.onChange(c.snapshot())
	}
}

// ── Provisioning / auth ─────────────────────────────────────────────────────

// ProvisionFromURL onboards the device from a public provision URL.
func (c *Controller) ProvisionFromURL(url string) {
	c.setSyncing(true)
	dc, err := c.apic.FetchProvision(c.ctx, url)
	if err != nil {
		c.fail("Provision failed: " + err.Error())
		return
	}
	c.applyDevice(*dc, url, false)
}

// LoginAndProvision authenticates with Cognito, stores the credentials for
// silent re-auth, and provisions the caller's device.
func (c *Controller) LoginAndProvision(username, password string) {
	c.setSyncing(true)
	tokens, err := c.cognito.Login(c.ctx, username, password)
	if err != nil {
		c.fail(err.Error())
		return
	}
	if err := c.creds.Save(username, password); err != nil {
		// Non-fatal: continue without silent re-auth.
		_ = err
	}
	dc, err := c.apic.AutoProvision(c.ctx, c.endpoints, tokens.IDToken)
	if err != nil {
		c.fail("Provision failed: " + err.Error())
		return
	}
	if dc == nil {
		c.fail("Signed in, but no VPN device is available for this account.")
		return
	}
	c.applyDevice(*dc, c.endpoints.AuthProvisionURL(), true)
}

// applyDevice persists a fresh device config and notifies listeners.
func (c *Controller) applyDevice(dc config.DeviceConfig, provisionURL string, isAdmin bool) {
	c.mu.Lock()
	prevSelected := ""
	if c.cfg != nil {
		prevSelected = c.cfg.SelectedNodeID
		isAdmin = isAdmin || c.cfg.IsAdmin
	}
	cfg := config.FromDevice(dc, provisionURL, isAdmin, prevSelected)
	c.cfg = &cfg
	c.syncing = false
	c.lastErr = ""
	c.mu.Unlock()

	_ = c.store.Save(cfg)
	c.emit()
}

// ── Tunnel control ──────────────────────────────────────────────────────────

// Connect brings the selected node's tunnel up.
func (c *Controller) Connect() {
	node := c.snapshot().SelectedNode()
	if node == nil {
		c.fail("No VPN node selected.")
		return
	}
	c.setTunnelState(tunnel.StateConnecting)
	if err := c.tun.Up(node.WgConfig); err != nil {
		c.fail(err.Error())
		c.setTunnelState(tunnel.StateError)
		return
	}
	c.mu.Lock()
	c.connectedAt = time.Now()
	c.mu.Unlock()
	c.refreshTunnelState()
	c.emit()
}

// Disconnect tears the tunnel down.
func (c *Controller) Disconnect() {
	if err := c.tun.Down(); err != nil {
		c.fail(err.Error())
		return
	}
	c.setTunnelState(tunnel.StateDisconnected)
}

// Toggle connects if disconnected, otherwise disconnects.
func (c *Controller) Toggle() {
	if c.snapshot().Tunnel == tunnel.StateConnected {
		c.Disconnect()
	} else {
		c.Connect()
	}
}

// SelectNode switches the active node, reconnecting if a tunnel is up.
func (c *Controller) SelectNode(nodeID string) {
	c.mu.Lock()
	if c.cfg == nil {
		c.mu.Unlock()
		return
	}
	cfg := c.cfg.WithSelected(nodeID)
	c.cfg = &cfg
	wasConnected := c.tunState == tunnel.StateConnected
	c.mu.Unlock()

	_ = c.store.Save(cfg)
	if wasConnected {
		c.Connect() // Up() replaces the existing tunnel with the new node
	} else {
		c.emit()
	}
}

// ── Sync / refresh ──────────────────────────────────────────────────────────

// SyncNow re-fetches the device config from the provision URL, picking up new
// nodes and role changes. Safe to call frequently; failures are surfaced but
// non-fatal.
func (c *Controller) SyncNow() {
	c.mu.Lock()
	url := ""
	if c.cfg != nil {
		url = c.cfg.ProvisionURL
	}
	c.mu.Unlock()
	if url == "" {
		return
	}

	c.setSyncing(true)
	dc, err := c.apic.FetchProvision(c.ctx, url)
	if err != nil {
		// Keep the existing config; just note the error.
		c.mu.Lock()
		c.syncing = false
		c.lastErr = "Sync failed: " + err.Error()
		c.mu.Unlock()
		c.emit()
		return
	}
	c.applyDevice(*dc, url, false)
}

// ── Sign out ────────────────────────────────────────────────────────────────

// Logout tears down the tunnel and clears all persisted state.
func (c *Controller) Logout() {
	_ = c.tun.Down()
	_ = c.store.Clear()
	_ = c.creds.Clear()
	c.mu.Lock()
	c.cfg = nil
	c.tunState = tunnel.StateDisconnected
	c.stats = tunnel.Stats{}
	c.lastErr = ""
	c.mu.Unlock()
	c.emit()
}

// ── Background loops ────────────────────────────────────────────────────────

// pollLoop keeps tunnel state and stats fresh and runs the failover watchdog.
func (c *Controller) pollLoop() {
	ticker := time.NewTicker(statusPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			changed := c.refreshTunnelState()
			if changed {
				c.emit()
			}
			c.checkFailover()
		}
	}
}

// refreshLoop periodically re-syncs config to pick up role/node changes.
func (c *Controller) refreshLoop() {
	ticker := time.NewTicker(refreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			c.SyncNow()
		}
	}
}

// checkFailover detects a dead tunnel (stale/missing handshake) and recovers by
// re-syncing (to pick up a newly promoted primary) and reconnecting.
func (c *Controller) checkFailover() {
	c.mu.Lock()
	connected := c.tunState == tunnel.StateConnected
	stats := c.stats
	connectedAt := c.connectedAt
	lastFailover := c.lastFailover
	c.mu.Unlock()

	if !connected || !stats.Available {
		return
	}
	if time.Since(connectedAt) < failoverGrace {
		return
	}
	// A healthy tunnel handshakes roughly every two minutes; a handshake that
	// is missing or older than the stale threshold means the node is unreachable.
	dead := stats.LastHandshake.IsZero() || time.Since(stats.LastHandshake) > handshakeStaleFor
	if !dead {
		return
	}
	if time.Since(lastFailover) < refreshInterval {
		return // avoid flapping; give the last recovery time to settle
	}

	c.mu.Lock()
	c.lastFailover = time.Now()
	c.mu.Unlock()

	// Refresh to learn the current primary, then reconnect to the best node.
	c.SyncNow()
	c.reconnectBest()
}

// reconnectBest reconnects to the primary node (or first available), used by
// the failover watchdog after a refresh.
func (c *Controller) reconnectBest() {
	c.mu.Lock()
	if c.cfg == nil || len(c.cfg.Nodes) == 0 {
		c.mu.Unlock()
		return
	}
	// Prefer the primary after a role change.
	best := c.cfg.Nodes[0]
	for _, n := range c.cfg.Nodes {
		if n.IsPrimary() {
			best = n
			break
		}
	}
	cfg := c.cfg.WithSelected(best.NodeID)
	c.cfg = &cfg
	c.mu.Unlock()

	_ = c.store.Save(cfg)
	c.Connect()
}

// ── Small state helpers ─────────────────────────────────────────────────────

func (c *Controller) refreshTunnelState() bool {
	state := c.tun.State()
	var stats tunnel.Stats
	if state == tunnel.StateConnected {
		stats = c.tun.Stats()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	changed := state != c.tunState || stats != c.stats
	c.tunState = state
	c.stats = stats
	return changed
}

func (c *Controller) setTunnelState(s tunnel.State) {
	c.mu.Lock()
	c.tunState = s
	c.mu.Unlock()
	c.emit()
}

func (c *Controller) setSyncing(v bool) {
	c.mu.Lock()
	c.syncing = v
	if v {
		c.lastErr = ""
	}
	c.mu.Unlock()
	c.emit()
}

func (c *Controller) fail(msg string) {
	c.mu.Lock()
	c.syncing = false
	c.lastErr = msg
	c.mu.Unlock()
	c.emit()
}
