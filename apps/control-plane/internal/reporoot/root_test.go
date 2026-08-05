package reporoot

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFindFromWorkspaceAndApplicationDirectories(t *testing.T) {
	root, err := Find(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, start := range []string{
		root,
		filepath.Join(root, "apps", "control-plane"),
		filepath.Join(root, "apps", "control-plane", "internal", "control"),
		filepath.Join(root, "apps", "control-plane", "go.mod"),
	} {
		actual, findErr := Find(start)
		if findErr != nil {
			t.Fatalf("Find(%q): %v", start, findErr)
		}
		if actual != root {
			t.Fatalf("Find(%q) = %q, want %q", start, actual, root)
		}
	}
}

func TestFindRejectsDirectoryOutsideWorkspace(t *testing.T) {
	directory := t.TempDir()
	if _, err := Find(directory); err == nil {
		t.Fatalf("Find(%q) unexpectedly found a repository", directory)
	}
	file := filepath.Join(directory, "file")
	if err := os.WriteFile(file, []byte("not a workspace\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Find(file); err == nil {
		t.Fatalf("Find(%q) unexpectedly found a repository", file)
	}
}

func TestControlPlaneDoesNotReadAgentopsApplicationImplementation(t *testing.T) {
	root, err := Find(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, relativeRoot := range []string{
		filepath.Join("apps", "control-plane", "cmd"),
		filepath.Join("apps", "control-plane", "internal"),
	} {
		err := filepath.WalkDir(
			filepath.Join(root, relativeRoot),
			func(name string, entry os.DirEntry, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				if entry.IsDir() || !strings.HasSuffix(name, ".go") ||
					strings.HasSuffix(name, "_test.go") {
					return nil
				}
				body, readErr := os.ReadFile(name)
				if readErr != nil {
					return readErr
				}
				normalized := strings.NewReplacer(
					"\\", "/",
					"\"", "/",
					"`", "/",
					",", "/",
					" ", "/",
					"\t", "/",
					"\n", "/",
				).Replace(string(body))
				for strings.Contains(normalized, "//") {
					normalized = strings.ReplaceAll(normalized, "//", "/")
				}
				if strings.Contains(normalized, "apps/agentops") {
					t.Errorf(
						"%s reads the AgentOps application instead of a shared contract",
						name,
					)
				}
				return nil
			},
		)
		if err != nil {
			t.Fatal(err)
		}
	}
}
