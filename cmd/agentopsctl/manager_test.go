package main

import (
	"context"
	"strings"
	"testing"

	"github.com/mrbaron3/workflow/internal/lifecycle"
)

type managerRuntimeRunner struct {
	results []lifecycle.CommandResult
	args    [][]string
}

func (runner *managerRuntimeRunner) Run(
	_ context.Context,
	args []string,
) lifecycle.CommandResult {
	runner.args = append(runner.args, append([]string(nil), args...))
	result := lifecycle.CommandResult{}
	if len(runner.results) != 0 {
		result = runner.results[0]
		runner.results = runner.results[1:]
	}
	result.Args = append([]string(nil), args...)
	return result
}

func TestReplaceControlPreflightFailureHasNoMutationReceipt(t *testing.T) {
	fake := &managerRuntimeRunner{results: []lifecycle.CommandResult{{
		Status: 1,
		Stderr: "injected list failure",
	}}}
	subject := newManager(testManagerConfig(), lifecycle.NewAppleRuntimeForTest(fake))
	receipt, err := subject.replaceControl(
		context.Background(),
		lifecycle.ModeMonitorOnly,
	)
	if err == nil || receipt.Mutated {
		t.Fatalf("replaceControl() receipt=%#v err=%v", receipt, err)
	}
	for _, args := range fake.args {
		if len(args) != 0 &&
			(args[0] == "kill" || args[0] == "delete" || args[0] == "run") {
			t.Fatalf("preflight failure mutated runtime with argv %v", args)
		}
	}
}

func TestReplaceControlPostDeleteFailureReturnsMutationReceipt(t *testing.T) {
	postgres := `[{"id":"agentops-postgres","configuration":{"labels":` +
		`{"com.mrbaron3.workflow.agentopsctl":"v1"}},"status":{"state":"running",` +
		`"networks":[{"network":"agentops-internal","ipv4Address":"192.0.2.10/24"}]}}]`
	stoppedControl := `[{"id":"agentops-control","configuration":{"labels":` +
		`{"com.mrbaron3.workflow.agentopsctl":"v1"}},"status":{"state":"stopped"}}]`
	fake := &managerRuntimeRunner{results: []lifecycle.CommandResult{
		{Status: 0, Stdout: postgres},
		{Status: 0, Stdout: `{"configuration":{"descriptor":{"digest":"sha256:` +
			strings.Repeat("a", 64) + `"}}}`},
		{Status: 0, Stdout: stoppedControl},
		{Status: 0, Stdout: stoppedControl},
		{Status: 0},
		{Status: 1, Stderr: "injected run failure"},
	}}
	subject := newManager(testManagerConfig(), lifecycle.NewAppleRuntimeForTest(fake))
	receipt, err := subject.replaceControl(
		context.Background(),
		lifecycle.ModeMonitorOnly,
	)
	if err == nil || !receipt.Mutated {
		t.Fatalf("replaceControl() receipt=%#v err=%v", receipt, err)
	}
	foundDelete := false
	for _, args := range fake.args {
		if len(args) != 0 && args[0] == "delete" {
			foundDelete = true
		}
	}
	if !foundDelete {
		t.Fatal("injected post-delete failure did not exercise a mutation")
	}
}

func TestValidateSpecActualRejectsImageAndConfigurationDrift(t *testing.T) {
	spec := lifecycle.ContainerSpec{
		Name: "agentops-control", Role: "control", Image: "control:test",
		Networks:    []string{"default", "agentops-internal"},
		Environment: map[string]string{"SECRET": "first"},
		Init:        true, ReadOnly: true, CapDropAll: true, Detach: true,
	}
	image := "sha256:" + strings.Repeat("a", 64)
	digest, err := lifecycle.SpecDigest(spec, image)
	if err != nil {
		t.Fatal(err)
	}
	spec.SpecDigest = digest
	actual := &lifecycle.ContainerActual{}
	actual.ID = spec.Name
	actual.Configuration.Image.Descriptor.Digest = image
	actual.Configuration.Labels = map[string]string{
		"com.mrbaron3.workflow.spec-sha256": digest,
	}
	if err := validateSpecActual(actual, spec); err != nil {
		t.Fatal(err)
	}
	actual.Configuration.Image.Descriptor.Digest =
		"sha256:" + strings.Repeat("b", 64)
	if err := validateSpecActual(actual, spec); err == nil {
		t.Fatal("mutable-tag image drift was accepted")
	}
	actual.Configuration.Image.Descriptor.Digest = image
	spec.Environment["SECRET"] = "rotated"
	if err := validateSpecActual(actual, spec); err == nil {
		t.Fatal("environment drift was accepted")
	}
}

func TestPostgresSpecRejectsMutableTagImageAndCredentialDrift(t *testing.T) {
	cfg := testManagerConfig()
	cfg.PostgresPassword = "postgres-password-first-value-0001"
	subject := newManager(cfg, nil)
	spec := subject.postgresSpec()
	image := "sha256:" + strings.Repeat("c", 64)
	digest, err := lifecycle.SpecDigest(spec, image)
	if err != nil {
		t.Fatal(err)
	}
	spec.SpecDigest = digest
	actual := &lifecycle.ContainerActual{}
	actual.ID = cfg.PostgresContainer
	actual.Configuration.Image.Descriptor.Digest = image
	actual.Configuration.Labels = map[string]string{
		"com.mrbaron3.workflow.spec-sha256": digest,
	}
	if err := validateSpecActual(actual, spec); err != nil {
		t.Fatal(err)
	}
	actual.Configuration.Image.Descriptor.Digest =
		"sha256:" + strings.Repeat("d", 64)
	if err := validateSpecActual(actual, spec); err == nil {
		t.Fatal("PostgreSQL mutable-tag image drift was accepted")
	}
	actual.Configuration.Image.Descriptor.Digest = image
	spec.Environment["POSTGRES_PASSWORD"] = "postgres-password-rotated-value-0002"
	if err := validateSpecActual(actual, spec); err == nil {
		t.Fatal("PostgreSQL administrator credential drift was accepted")
	}
}

func testManagerConfig() config {
	return config{
		Prefix:            "agentops",
		Network:           "agentops-internal",
		PostgresVolume:    "agentops-postgres-data",
		RunnerVolume:      "agentops-runner-workspace",
		CredentialVolume:  "agentops-runner-credentials",
		PostgresContainer: "agentops-postgres",
		ControlContainer:  "agentops-control",
		RunnerContainer:   "agentops-runner",
		PostgresImage:     "agentops-postgres:dev",
		ControlImage:      "control:test",
		RunnerImage:       "runner:test",
		ControlHostPort:   8080,
		Provider:          "codex",
		MonitorRepository: "mrbaron3/workflow",
	}
}
