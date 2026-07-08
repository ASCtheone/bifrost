//go:build !windows

package main

import (
	"fmt"
	"os"
)

// The Bifrost desktop client targets Windows only; this stub keeps the module
// buildable on other platforms (CI, cross-checks).
func main() {
	fmt.Fprintln(os.Stderr, "The Bifrost desktop client runs on Windows only.")
	os.Exit(1)
}
