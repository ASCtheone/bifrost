//go:build !windows

package auth

// Off-Windows stub for the Credential Manager store, so the module builds on CI.
// The real implementation lives in credstore.go (Windows only).

// Credentials is a stored username/password pair.
type Credentials struct {
	Username string
	Password string
}

// CredStore is a no-op credential store on non-Windows platforms.
type CredStore struct{}

// NewCredStore returns a stub store.
func NewCredStore() *CredStore { return &CredStore{} }

func (CredStore) Save(string, string) error   { return nil }
func (CredStore) Load() (*Credentials, error) { return nil, nil }
func (CredStore) Has() bool                    { return false }
func (CredStore) Clear() error                 { return nil }
