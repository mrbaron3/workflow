package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mrbaron3/workflow/internal/lifecycle"
)

func TestDatabaseURLsEscapeCredentials(t *testing.T) {
	value := config{
		PostgresContainer: "agentops-postgres",
		PostgresPassword:  "admin:/?#[]@ password",
	}
	url := value.adminDatabaseURL("agentops-postgres")
	if strings.Contains(url, " password") || !strings.Contains(url, "agentops-postgres:5432") {
		t.Fatalf("unsafe database URL = %q", url)
	}
}

func TestExactLoopbackPublication(t *testing.T) {
	actual := &lifecycle.ContainerActual{}
	actual.Configuration.PublishedPorts = []map[string]any{{
		"hostAddress":   "127.0.0.1",
		"hostPort":      float64(8080),
		"containerPort": float64(8080),
		"count":         float64(1),
		"proto":         "tcp",
	}}
	if !exactLoopbackPublication(actual, 8080) {
		t.Fatal("exact loopback publication was rejected")
	}
	actual.Configuration.PublishedPorts[0]["hostAddress"] = "0.0.0.0"
	if exactLoopbackPublication(actual, 8080) {
		t.Fatal("wildcard publication was accepted")
	}
}

func TestStartCredentialSeparation(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "deploy"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "deploy", "Containerfile"),
		[]byte("FROM scratch\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	value := config{
		Prefix: "agentops", ProjectRoot: root,
		PostgresPassword:   strings.Repeat("a", 32),
		ControlDBPassword:  strings.Repeat("b", 32),
		RunnerDBPassword:   strings.Repeat("c", 32),
		ControlToken:       strings.Repeat("d", 32),
		DashboardToken:     strings.Repeat("e", 32),
		WebhookSecret:      strings.Repeat("f", 32),
		ControlGitHubToken: strings.Repeat("g", 32),
		RunnerGitHubToken:  strings.Repeat("g", 32),
		Provider:           "codex", ProviderToken: strings.Repeat("h", 32),
	}
	if err := value.validateStart(lifecycle.ModeActive); err == nil ||
		!strings.Contains(err.Error(), "distinct") {
		t.Fatalf("shared GitHub credential was accepted: %v", err)
	}
}
