// Package reporoot locates the monorepo root that contains the control-plane
// application and its language-neutral contracts.
package reporoot

import (
	"fmt"
	"os"
	"path/filepath"
)

const controlPlaneModule = "apps/control-plane/go.mod"

// Find walks from start towards the filesystem root until it finds the
// workspace marker for this application. It intentionally does not rely on
// .git, which is absent from release image build contexts.
func Find(start string) (string, error) {
	if start == "" {
		start = "."
	}
	absolute, err := filepath.Abs(start)
	if err != nil {
		return "", fmt.Errorf("resolve repository root start: %w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("inspect repository root start: %w", err)
	}
	if !info.IsDir() {
		absolute = filepath.Dir(absolute)
	}
	for candidate := absolute; ; candidate = filepath.Dir(candidate) {
		marker := filepath.Join(candidate, filepath.FromSlash(controlPlaneModule))
		if info, statErr := os.Stat(marker); statErr == nil && info.Mode().IsRegular() {
			return candidate, nil
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			break
		}
	}
	return "", fmt.Errorf(
		"repository root containing %s was not found from %s",
		controlPlaneModule,
		absolute,
	)
}
