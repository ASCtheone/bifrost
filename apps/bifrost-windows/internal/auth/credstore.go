//go:build windows

package auth

import (
	"errors"

	"github.com/danieljoos/wincred"
)

// credTarget is the Windows Credential Manager target name under which the
// admin's username/password are stored (encrypted per-user by DPAPI).
const credTarget = "Bifrost:admin"

// Credentials is a stored username/password pair for silent re-authentication.
type Credentials struct {
	Username string
	Password string
}

// CredStore reads and writes admin credentials in the Windows Credential Manager.
type CredStore struct{}

// NewCredStore returns a Credential Manager backed store.
func NewCredStore() *CredStore { return &CredStore{} }

// Save persists the credentials, encrypted for the current user.
func (CredStore) Save(username, password string) error {
	cred := wincred.NewGenericCredential(credTarget)
	cred.UserName = username
	cred.CredentialBlob = []byte(password)
	cred.Persist = wincred.PersistLocalMachine
	return cred.Write()
}

// Load returns the stored credentials, or (nil, nil) when none are stored.
func (CredStore) Load() (*Credentials, error) {
	cred, err := wincred.GetGenericCredential(credTarget)
	if err != nil {
		if errors.Is(err, wincred.ErrElementNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &Credentials{
		Username: cred.UserName,
		Password: string(cred.CredentialBlob),
	}, nil
}

// Has reports whether stored credentials exist.
func (c CredStore) Has() bool {
	creds, err := c.Load()
	return err == nil && creds != nil
}

// Clear deletes the stored credentials (used on sign-out).
func (CredStore) Clear() error {
	cred, err := wincred.GetGenericCredential(credTarget)
	if err != nil {
		if errors.Is(err, wincred.ErrElementNotFound) {
			return nil
		}
		return err
	}
	return cred.Delete()
}
