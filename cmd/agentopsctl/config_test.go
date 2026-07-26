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

func TestValidateRunnerActualRequiresFullHardenedTopology(t *testing.T) {
	cfg := config{
		Network:          "agentops-internal",
		RunnerContainer:  "agentops-runner",
		RunnerImage:      "agentops-runner:dev",
		RunnerVolume:     "agentops-runner-workspace",
		CredentialVolume: "agentops-runner-credentials",
		Provider:         "codex",
		CodexAuthPath:    "/operator/.codex/auth.json",
	}
	actual := &lifecycle.ContainerActual{ID: cfg.RunnerContainer}
	actual.Status.State = "running"
	actual.Configuration.Labels = map[string]string{
		"com.mrbaron3.workflow.agentopsctl": "v1",
		"com.mrbaron3.workflow.role":        "runner",
	}
	actual.Configuration.Image.Reference = "docker.io/library/agentops-runner:dev"
	actual.Configuration.Networks = append(
		actual.Configuration.Networks,
		struct {
			Network string `json:"network"`
		}{Network: cfg.Network},
	)
	actual.Configuration.ReadOnly = true
	actual.Configuration.CapDrop = []string{"ALL"}
	actual.Configuration.InitProcess.User.ID.UID = 65532
	for destination, kind := range map[string]string{
		"/tmp":                      "tmpfs",
		"/home/agentops":            "tmpfs",
		"/workspace":                cfg.RunnerVolume,
		"/run/agentops-credentials": cfg.CredentialVolume,
	} {
		mount := struct {
			Destination string         `json:"destination"`
			Source      string         `json:"source"`
			Type        map[string]any `json:"type"`
		}{Destination: destination}
		if kind == "tmpfs" {
			mount.Type = map[string]any{"tmpfs": map[string]any{}}
		} else {
			mount.Type = map[string]any{
				"volume": map[string]any{"name": kind},
			}
		}
		actual.Configuration.Mounts = append(actual.Configuration.Mounts, mount)
	}
	if err := validateRunnerActual(actual, cfg); err != nil {
		t.Fatalf("valid runner topology rejected: %v", err)
	}
	actual.Configuration.CapAdd = []string{"CAP_SYS_ADMIN"}
	if err := validateRunnerActual(actual, cfg); err == nil {
		t.Fatal("runner with added capability was accepted")
	}
}

func TestStartRejectsEveryControlGitHubCredential(t *testing.T) {
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
		MonitorRepository: "mrbaron3/workflow",
	}
	if err := value.validateStart(lifecycle.ModeActive); err == nil ||
		!strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("control GitHub credential was accepted: %v", err)
	}
}

func TestActiveAllowsCredentialFreeControlWithPrivateBrokerAndCodexLogin(t *testing.T) {
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
	auth := filepath.Join(root, "auth.json")
	if err := os.WriteFile(auth, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	value := config{
		Prefix: "agentops", ProjectRoot: root,
		PostgresPassword:  strings.Repeat("a", 32),
		ControlDBPassword: strings.Repeat("b", 32),
		RunnerDBPassword:  strings.Repeat("c", 32),
		ControlToken:      strings.Repeat("d", 32),
		DashboardToken:    strings.Repeat("e", 32),
		WebhookSecret:     strings.Repeat("f", 32),
		RunnerGitHubToken: strings.Repeat("g", 32),
		Provider:          "codex",
		CodexAuthPath:     auth,
		MonitorRepository: "mrbaron3/workflow",
	}
	if err := value.validateStart(lifecycle.ModeActive); err != nil {
		t.Fatalf("credential-free-control/private-runner boundary was rejected: %v", err)
	}
	if !value.usesCodexAuthFile() {
		t.Fatal("Codex login file mode was not selected")
	}
}

func TestCodexAuthSourceRejectsPermissiveOrNonCanonicalFile(t *testing.T) {
	root := t.TempDir()
	unsafe := filepath.Join(root, "auth.json")
	if err := os.WriteFile(unsafe, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := validateCodexAuthSource(unsafe); err == nil {
		t.Fatal("group/world-readable Codex auth was accepted")
	}
	safe := filepath.Join(root, "not-auth.json")
	if err := os.WriteFile(safe, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateCodexAuthSource(safe); err == nil {
		t.Fatal("non-canonical Codex auth filename was accepted")
	}
	missing := filepath.Join(root, "missing", "auth.json")
	err := validateCodexAuthSource(missing)
	if err == nil || strings.Contains(err.Error(), root) {
		t.Fatalf("missing Codex auth leaked its host path: %v", err)
	}
}

func TestPostgresRotationRequiresDistinctCurrentAndNextCredentials(t *testing.T) {
	value := config{
		PostgresPassword:     strings.Repeat("a", 32),
		NextPostgresPassword: strings.Repeat("b", 32),
		ControlDBPassword:    strings.Repeat("c", 32),
		RunnerDBPassword:     strings.Repeat("d", 32),
	}
	if err := value.validatePostgresRotation(); err != nil {
		t.Fatalf("valid PostgreSQL credential rotation rejected: %v", err)
	}
	value.NextPostgresPassword = value.ControlDBPassword
	if err := value.validatePostgresRotation(); err == nil {
		t.Fatal("database role credential reuse was accepted for admin rotation")
	}
}
