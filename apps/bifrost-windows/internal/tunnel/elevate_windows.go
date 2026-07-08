//go:build windows

package tunnel

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// IsElevated reports whether the current process is running with administrator
// rights. Installing/removing the WireGuard tunnel service requires elevation.
func IsElevated() bool {
	var sid *windows.SID
	// S-1-5-32-544 = BUILTIN\Administrators
	err := windows.AllocateAndInitializeSid(
		&windows.SECURITY_NT_AUTHORITY,
		2,
		windows.SECURITY_BUILTIN_DOMAIN_RID,
		windows.DOMAIN_ALIAS_RID_ADMINS,
		0, 0, 0, 0, 0, 0,
		&sid,
	)
	if err != nil {
		return false
	}
	defer windows.FreeSid(sid)

	token := windows.Token(0) // current process token
	member, err := token.IsMember(sid)
	return err == nil && member
}

// RelaunchElevated re-launches the current executable through ShellExecute with
// the "runas" verb, triggering a UAC prompt. It returns after the elevated
// process has been requested to start; the caller should then exit.
func RelaunchElevated() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	// Preserve args (skip argv[0]); mark so the child does not loop-elevate.
	args := append([]string{elevatedFlag}, os.Args[1:]...)
	params, _ := windows.UTF16PtrFromString(strings.Join(args, " "))
	cwd, _ := windows.UTF16PtrFromString(filepath.Dir(exe))

	return windows.ShellExecute(0, verb, file, params, cwd, windows.SW_NORMAL)
}

// elevatedFlag marks a child process that was spawned by RelaunchElevated, so
// we never enter an infinite elevation loop if elevation is declined/failed.
const elevatedFlag = "--elevated"

// WasElevatedRelaunch reports whether this process is the elevated child.
func WasElevatedRelaunch() bool {
	for _, a := range os.Args[1:] {
		if a == elevatedFlag {
			return true
		}
	}
	return false
}
