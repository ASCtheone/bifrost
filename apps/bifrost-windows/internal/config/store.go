package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Store persists the client's StoredConfig as JSON under %APPDATA%\Bifrost.
type Store struct {
	dir string
}

// NewStore returns a Store rooted at the per-user Bifrost data directory,
// creating the directory if needed.
func NewStore() (*Store, error) {
	base, err := os.UserConfigDir() // %APPDATA% on Windows
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(base, "Bifrost")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

// Dir is the directory the store writes into.
func (s *Store) Dir() string { return s.dir }

func (s *Store) path() string { return filepath.Join(s.dir, "config.json") }

// Load reads the persisted config. It returns (nil, nil) when no config has
// been saved yet, so callers can distinguish "not provisioned" from an error.
func (s *Store) Load() (*StoredConfig, error) {
	data, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg StoredConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if len(cfg.Nodes) == 0 {
		return nil, nil
	}
	return &cfg, nil
}

// Save atomically writes the config to disk (write-temp-then-rename).
func (s *Store) Save(cfg StoredConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path())
}

// Clear removes the persisted config (used on sign-out).
func (s *Store) Clear() error {
	err := os.Remove(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
