package config

import "testing"

func TestStoreRoundTrip(t *testing.T) {
	s := &Store{dir: t.TempDir()}

	// Nothing saved yet.
	got, err := s.Load()
	if err != nil {
		t.Fatalf("load empty: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil on empty store, got %+v", got)
	}

	cfg := StoredConfig{
		DeviceID:       "dev-1",
		DeviceName:     "Laptop",
		AssignedIP:     "10.7.0.5",
		ProvisionURL:   "https://api/provision/tok",
		IsAdmin:        true,
		SelectedNodeID: "n2",
		Nodes:          []NodeConfig{node("n1", "primary"), node("n2", "secondary")},
	}
	if err := s.Save(cfg); err != nil {
		t.Fatalf("save: %v", err)
	}

	loaded, err := s.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded == nil {
		t.Fatal("expected config after save")
	}
	if loaded.DeviceID != cfg.DeviceID || loaded.SelectedNodeID != "n2" ||
		!loaded.IsAdmin || len(loaded.Nodes) != 2 {
		t.Fatalf("round-trip mismatch: %+v", loaded)
	}

	if err := s.Clear(); err != nil {
		t.Fatalf("clear: %v", err)
	}
	after, err := s.Load()
	if err != nil || after != nil {
		t.Fatalf("expected empty after clear, got %+v (err %v)", after, err)
	}
	// Clearing an already-empty store is not an error.
	if err := s.Clear(); err != nil {
		t.Fatalf("second clear: %v", err)
	}
}

func TestStoreIgnoresConfigWithNoNodes(t *testing.T) {
	s := &Store{dir: t.TempDir()}
	if err := s.Save(StoredConfig{DeviceID: "d"}); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got != nil {
		t.Fatalf("config with no nodes should load as nil, got %+v", got)
	}
}
