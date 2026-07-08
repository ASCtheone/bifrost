// Package config holds the shared data model for the Bifrost Windows client and
// the on-disk persistence of the device's provisioning state.
package config

// NodeConfig is a single VPN node (a "spark") the device can connect through.
// It mirrors the shape returned by the provision endpoints and the Android
// client's NodeConfig, so the two clients stay wire-compatible.
type NodeConfig struct {
	NodeID     string `json:"nodeId"`
	Name       string `json:"name"`
	ServerName string `json:"serverName,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	Port       int    `json:"port,omitempty"`
	// WgConfig is the ready-to-apply WireGuard [Interface]/[Peer] document the
	// server builds for this device against this node.
	WgConfig  string `json:"wgConfig"`
	Location  string `json:"location,omitempty"`
	Role      string `json:"role,omitempty"`
	ISPName   string `json:"ispName,omitempty"`
	SpeedDown *int   `json:"speedDown,omitempty"`
	SpeedUp   *int   `json:"speedUp,omitempty"`
}

// IsPrimary reports whether this node is the current primary in the cluster.
func (n NodeConfig) IsPrimary() bool { return n.Role == "primary" }

// Label is a human-friendly name for menus, preferring location context.
func (n NodeConfig) Label() string {
	name := n.Name
	if name == "" {
		name = n.NodeID
	}
	if n.Location != "" {
		return name + " — " + n.Location
	}
	return name
}

// DeviceConfig is the response payload from a provision call: the device
// identity plus every node it may connect through.
type DeviceConfig struct {
	DeviceID   string       `json:"deviceId"`
	Name       string       `json:"name"`
	AssignedIP string       `json:"assignedIp"`
	Nodes      []NodeConfig `json:"nodes"`
}

// StoredConfig is the persisted client state written to %APPDATA%\Bifrost.
// It is an immutable snapshot — callers replace it wholesale rather than
// mutating fields in place.
type StoredConfig struct {
	DeviceID       string       `json:"deviceId"`
	DeviceName     string       `json:"deviceName"`
	AssignedIP     string       `json:"assignedIp"`
	Nodes          []NodeConfig `json:"nodes"`
	ProvisionURL   string       `json:"provisionUrl,omitempty"`
	IsAdmin        bool         `json:"isAdmin,omitempty"`
	SelectedNodeID string       `json:"selectedNodeId,omitempty"`
}

// FromDevice builds a StoredConfig from a freshly fetched DeviceConfig,
// preserving the provision URL and the previously selected node when it still
// exists in the new node set. Returns a new value; inputs are not modified.
func FromDevice(dc DeviceConfig, provisionURL string, isAdmin bool, prevSelected string) StoredConfig {
	selected := selectNode(dc.Nodes, prevSelected)
	return StoredConfig{
		DeviceID:       dc.DeviceID,
		DeviceName:     dc.Name,
		AssignedIP:     dc.AssignedIP,
		Nodes:          dc.Nodes,
		ProvisionURL:   provisionURL,
		IsAdmin:        isAdmin,
		SelectedNodeID: selected,
	}
}

// SelectedNode returns the currently selected node, falling back to the primary
// node, then the first node. Returns nil when there are no nodes.
func (c StoredConfig) SelectedNode() *NodeConfig {
	if len(c.Nodes) == 0 {
		return nil
	}
	if c.SelectedNodeID != "" {
		for i := range c.Nodes {
			if c.Nodes[i].NodeID == c.SelectedNodeID {
				return &c.Nodes[i]
			}
		}
	}
	for i := range c.Nodes {
		if c.Nodes[i].IsPrimary() {
			return &c.Nodes[i]
		}
	}
	return &c.Nodes[0]
}

// WithSelected returns a copy of the config with a different selected node.
func (c StoredConfig) WithSelected(nodeID string) StoredConfig {
	c.SelectedNodeID = nodeID // c is a value copy — safe, no mutation of caller's struct
	return c
}

// selectNode chooses which node id should be selected given a preferred id.
func selectNode(nodes []NodeConfig, preferred string) string {
	if len(nodes) == 0 {
		return ""
	}
	if preferred != "" {
		for _, n := range nodes {
			if n.NodeID == preferred {
				return preferred
			}
		}
	}
	for _, n := range nodes {
		if n.IsPrimary() {
			return n.NodeID
		}
	}
	return nodes[0].NodeID
}
