//go:build windows

// Command bifrost-windows is the Bifrost VPN desktop client for Windows: a
// system-tray app that provisions a device (via Cognito sign-in or a provision
// URL), applies the WireGuard config through the WireGuard tunnel service, and
// keeps the connection healthy with periodic refresh and node failover.
package main

import (
	"fmt"
	"os"

	"fyne.io/systray"

	"github.com/bifrost-vpn/bifrost-windows/internal/app"
	"github.com/bifrost-vpn/bifrost-windows/internal/config"
	"github.com/bifrost-vpn/bifrost-windows/internal/tray"
	"github.com/bifrost-vpn/bifrost-windows/internal/tunnel"
)

func main() {
	// Installing/removing the WireGuard tunnel service requires administrator
	// rights. If we are not elevated (and not already a relaunch), request
	// elevation via UAC and hand off to the elevated instance.
	if !tunnel.IsElevated() && !tunnel.WasElevatedRelaunch() {
		if err := tunnel.RelaunchElevated(); err != nil {
			fmt.Fprintln(os.Stderr, "Bifrost needs administrator rights to manage the VPN tunnel:", err)
			os.Exit(1)
		}
		return // the elevated process takes over
	}

	endpoints := config.Load()

	store, err := config.NewStore()
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to initialise data directory:", err)
		os.Exit(1)
	}

	tun := tunnel.NewManager(store.Dir())
	ctrl := app.New(endpoints, store, tun)
	t := tray.New(ctrl)

	systray.Run(t.OnReady, t.OnExit)
}
