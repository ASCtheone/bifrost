//go:build windows

package tunnel

import (
	"bufio"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

// Stats is a best-effort snapshot of tunnel transfer counters.
type Stats struct {
	Available     bool
	RxBytes       uint64
	TxBytes       uint64
	LastHandshake time.Time
}

// Stats reads live counters from the WireGuard userspace IPC named pipe. It is
// strictly best-effort: any failure (pipe absent, not elevated, parse error)
// returns Stats{Available:false} rather than an error, so callers can call it
// on a timer without handling failures.
func (m *Manager) Stats() Stats {
	pipe := `\\.\pipe\ProtectedPrefix\Administrators\WireGuard\` + tunnelName
	p, err := windows.UTF16PtrFromString(pipe)
	if err != nil {
		return Stats{}
	}
	handle, err := windows.CreateFile(
		p,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		0, nil,
		windows.OPEN_EXISTING,
		0, 0,
	)
	if err != nil {
		return Stats{}
	}
	defer windows.CloseHandle(handle)

	file := &pipeConn{handle: handle}
	if _, err := file.Write([]byte("get=1\n\n")); err != nil {
		return Stats{}
	}

	var st Stats
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			break // blank line terminates the response
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "rx_bytes":
			if n, err := strconv.ParseUint(val, 10, 64); err == nil {
				st.RxBytes += n
			}
		case "tx_bytes":
			if n, err := strconv.ParseUint(val, 10, 64); err == nil {
				st.TxBytes += n
			}
		case "last_handshake_time_sec":
			if n, err := strconv.ParseInt(val, 10, 64); err == nil && n > 0 {
				hs := time.Unix(n, 0)
				if hs.After(st.LastHandshake) {
					st.LastHandshake = hs
				}
			}
		}
	}
	st.Available = true
	return st
}

// pipeConn adapts a Windows pipe handle to io.Reader/Writer for bufio.
type pipeConn struct{ handle windows.Handle }

func (c *pipeConn) Read(b []byte) (int, error) {
	var n uint32
	err := windows.ReadFile(c.handle, b, &n, nil)
	if err != nil {
		return int(n), err
	}
	return int(n), nil
}

func (c *pipeConn) Write(b []byte) (int, error) {
	var n uint32
	err := windows.WriteFile(c.handle, b, &n, nil)
	return int(n), err
}
