# Bifrost VPN — Windows client

A Windows system-tray VPN client for Bifrost. It provisions a device against the
AWS control plane (API Gateway + Cognito), applies the returned WireGuard
configuration through the **WireGuard tunnel service**, and keeps the connection
healthy with periodic refresh and automatic node failover.

It is the desktop counterpart to the `bifrost-android` app and speaks the same
provisioning contract.

## How it works

```
 tray menu ──▶ controller ──▶ api  ──▶  GET /provision/{token}      (public URL onboarding)
    ▲              │           auth ─▶  Cognito USER_PASSWORD_AUTH  ─▶ POST /auth/provision
    │              │           tunnel▶  wireguard.exe /installtunnelservice  (WireGuard service)
    └── status ◀───┘           store ▶  %APPDATA%\Bifrost\config.json
                               creds ▶  Windows Credential Manager
```

- **Onboarding** — two paths, both returning a `DeviceConfig` whose nodes each
  carry a ready-to-apply `wgConfig`:
  1. *Add device from URL* — paste a provision URL (`GET /provision/{token}`).
  2. *Sign in* — Cognito username/password → `POST /auth/provision`. Credentials
     are saved in the Windows Credential Manager for silent re-auth.
- **Connect** — the selected node's `wgConfig` is written to
  `%APPDATA%\Bifrost\bifrost.conf` and installed as the `WireGuardTunnel$bifrost`
  Windows service.
- **Failover** — a watchdog polls the tunnel's handshake age over the WireGuard
  IPC pipe; if the active node goes stale it re-syncs (picking up a newly
  promoted primary) and reconnects. Config is also refreshed every 5 minutes.

## Requirements

- **Windows 10/11**
- **[WireGuard for Windows](https://www.wireguard.com/install/)** installed
  (the client drives its tunnel service; it does not bundle WireGuard).
- **Administrator rights** — managing the tunnel service requires elevation. The
  app self-elevates via UAC on launch, and the release build embeds a
  `requireAdministrator` manifest.

## Configuration

Deployment targets default to the production stack and can be overridden with
environment variables (useful for pointing at a dev stage):

| Variable            | Default                                               |
| ------------------- | ----------------------------------------------------- |
| `BIFROST_API_URL`   | `https://gc6426p037.execute-api.us-east-1.amazonaws.com` |
| `BIFROST_REGION`    | `us-east-1`                                            |
| `BIFROST_CLIENT_ID` | Cognito app client id                                 |

## Build & test

```sh
# from apps/bifrost-windows
go test -race -cover ./...        # unit tests
go build ./...                    # dev build (console attached)

# release: embed manifest/version and hide the console window
go generate ./...                 # produces resource.syso
go build -ldflags "-s -w -H=windowsgui" -o dist/bifrost-vpn.exe .
```

Or via Nx from the repo root:

```sh
nx test bifrost-windows
nx package bifrost-windows        # dist/bifrost-vpn.exe
```

## Layout

| Path                  | Responsibility                                            |
| --------------------- | -------------------------------------------------------- |
| `internal/config`     | data model, endpoint config, on-disk store               |
| `internal/auth`       | Cognito login, Windows Credential Manager                |
| `internal/api`        | provisioning HTTP client                                 |
| `internal/tunnel`     | WireGuard service control, elevation, live stats (Windows)|
| `internal/app`        | controller: state, background loops, failover            |
| `internal/tray`       | system-tray menu + generated icons                       |
| `internal/ui`         | native sign-in / URL dialogs                              |
