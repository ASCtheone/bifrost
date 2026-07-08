//go:build windows

package main

// Embed a Windows resource (version info + the requireAdministrator manifest)
// into the executable. Run `go generate ./...` before a release build to
// produce resource.syso; `go build` then links it automatically.
//
//go:generate go run github.com/josephspurrier/goversioninfo/cmd/goversioninfo -64 -o resource.syso versioninfo.json
