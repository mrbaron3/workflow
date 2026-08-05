package main

import (
	"os"
	"strings"

	"github.com/mrbaron3/servo/apps/control-plane/internal/reporoot"
)

// applicationRoot keeps release images explicit while making local execution
// independent of whether it starts at the workspace root or the Go module.
func applicationRoot() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("AGENTOPS_APP_ROOT")); configured != "" {
		return configured, nil
	}
	return reporoot.Find(".")
}
