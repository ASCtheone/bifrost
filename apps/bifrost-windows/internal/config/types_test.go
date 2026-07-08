package config

import "testing"

func node(id, role string) NodeConfig { return NodeConfig{NodeID: id, Name: id, Role: role, WgConfig: "cfg-" + id} }

func TestFromDeviceSelectsPrimary(t *testing.T) {
	dc := DeviceConfig{
		DeviceID: "dev1",
		Name:     "Laptop",
		Nodes:    []NodeConfig{node("a", "secondary"), node("b", "primary"), node("c", "secondary")},
	}
	got := FromDevice(dc, "https://api/provision/tok", true, "")
	if got.SelectedNodeID != "b" {
		t.Fatalf("expected primary 'b' selected, got %q", got.SelectedNodeID)
	}
	if !got.IsAdmin || got.ProvisionURL != "https://api/provision/tok" {
		t.Fatalf("metadata not carried through: %+v", got)
	}
}

func TestFromDevicePreservesSelectionWhenStillPresent(t *testing.T) {
	dc := DeviceConfig{DeviceID: "d", Nodes: []NodeConfig{node("a", "primary"), node("c", "secondary")}}
	got := FromDevice(dc, "", false, "c")
	if got.SelectedNodeID != "c" {
		t.Fatalf("expected preserved selection 'c', got %q", got.SelectedNodeID)
	}
}

func TestFromDeviceFallsBackWhenSelectionGone(t *testing.T) {
	dc := DeviceConfig{DeviceID: "d", Nodes: []NodeConfig{node("a", "secondary"), node("b", "primary")}}
	got := FromDevice(dc, "", false, "zzz") // previously selected node no longer exists
	if got.SelectedNodeID != "b" {
		t.Fatalf("expected fallback to primary 'b', got %q", got.SelectedNodeID)
	}
}

func TestSelectedNode(t *testing.T) {
	tests := []struct {
		name     string
		cfg      StoredConfig
		wantID   string
		wantNil  bool
	}{
		{
			name:    "no nodes",
			cfg:     StoredConfig{},
			wantNil: true,
		},
		{
			name:   "explicit selection",
			cfg:    StoredConfig{Nodes: []NodeConfig{node("a", "primary"), node("b", "secondary")}, SelectedNodeID: "b"},
			wantID: "b",
		},
		{
			name:   "primary when no selection",
			cfg:    StoredConfig{Nodes: []NodeConfig{node("a", "secondary"), node("b", "primary")}},
			wantID: "b",
		},
		{
			name:   "first when no primary and no selection",
			cfg:    StoredConfig{Nodes: []NodeConfig{node("a", "secondary"), node("b", "secondary")}},
			wantID: "a",
		},
		{
			name:   "stale selection falls back to primary",
			cfg:    StoredConfig{Nodes: []NodeConfig{node("a", "primary")}, SelectedNodeID: "gone"},
			wantID: "a",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.cfg.SelectedNode()
			if tc.wantNil {
				if got != nil {
					t.Fatalf("expected nil, got %+v", got)
				}
				return
			}
			if got == nil || got.NodeID != tc.wantID {
				t.Fatalf("expected %q, got %+v", tc.wantID, got)
			}
		})
	}
}

func TestWithSelectedDoesNotMutateOriginal(t *testing.T) {
	orig := StoredConfig{Nodes: []NodeConfig{node("a", "primary"), node("b", "secondary")}, SelectedNodeID: "a"}
	updated := orig.WithSelected("b")
	if orig.SelectedNodeID != "a" {
		t.Fatalf("original mutated: %q", orig.SelectedNodeID)
	}
	if updated.SelectedNodeID != "b" {
		t.Fatalf("copy not updated: %q", updated.SelectedNodeID)
	}
}

func TestNodeLabel(t *testing.T) {
	if got := (NodeConfig{Name: "Home", Location: "NYC, US"}).Label(); got != "Home — NYC, US" {
		t.Fatalf("label with location: %q", got)
	}
	if got := (NodeConfig{NodeID: "n1"}).Label(); got != "n1" {
		t.Fatalf("label falls back to id: %q", got)
	}
}

func TestEndpointsEnvOverride(t *testing.T) {
	t.Setenv("BIFROST_API_URL", "https://custom.example.com/")
	t.Setenv("BIFROST_REGION", "eu-west-1")
	e := Load()
	if e.APIBase != "https://custom.example.com" { // trailing slash trimmed
		t.Fatalf("api base: %q", e.APIBase)
	}
	if e.Region != "eu-west-1" {
		t.Fatalf("region: %q", e.Region)
	}
	if e.AuthProvisionURL() != "https://custom.example.com/auth/provision" {
		t.Fatalf("auth provision url: %q", e.AuthProvisionURL())
	}
}
