package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/mrbaron3/workflow/internal/control"
	"github.com/mrbaron3/workflow/internal/lifecycle"
)

type managerRuntimeRunner struct {
	results      []lifecycle.CommandResult
	args         [][]string
	environments []map[string]string
}

func (runner *managerRuntimeRunner) RunWithEnvironment(
	ctx context.Context,
	args []string,
	environment map[string]string,
) lifecycle.CommandResult {
	copied := make(map[string]string, len(environment))
	for key, value := range environment {
		copied[key] = value
	}
	runner.environments = append(runner.environments, copied)
	return runner.Run(ctx, args)
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
	actual.Configuration.InitProcess.Environment = []string{"SECRET=first"}
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

func TestRedactContainerStatusRemovesCredentialEnvironmentValues(t *testing.T) {
	actual := &lifecycle.ContainerActual{}
	actual.Configuration.InitProcess.Environment = []string{
		"AGENTOPS_DATABASE_URL=postgresql://role:database-secret@db/agentops",
		"AGENTOPS_RUNNER_GITHUB_TOKEN=github-secret",
		"AGENTOPS_OPERATING_MODE=ACTIVE",
	}
	redacted := redactContainerStatus(actual)
	encoded, err := json.Marshal(redacted)
	if err != nil {
		t.Fatal(err)
	}
	rendered := string(encoded)
	for _, secret := range []string{"database-secret", "github-secret"} {
		if strings.Contains(rendered, secret) {
			t.Fatalf("status JSON leaked %q: %s", secret, rendered)
		}
	}
	if !strings.Contains(rendered, "AGENTOPS_DATABASE_URL=***") ||
		!strings.Contains(rendered, "AGENTOPS_RUNNER_GITHUB_TOKEN=***") ||
		!strings.Contains(rendered, "AGENTOPS_OPERATING_MODE=ACTIVE") {
		t.Fatalf("unexpected redacted status JSON: %s", rendered)
	}
	if actual.Configuration.InitProcess.Environment[0] ==
		"AGENTOPS_DATABASE_URL=***" {
		t.Fatal("redaction mutated the runtime inspection source")
	}
}

func TestManagedNonRootUserAcceptsAppleNumericIdentityWithoutRoot(t *testing.T) {
	for _, user := range []struct {
		uid int
		raw string
	}{
		{uid: 65532},
		{raw: "agentops"},
		{raw: "65532"},
		{raw: "65532:65532"},
	} {
		if !managedNonRootUser(user.uid, user.raw) {
			t.Fatalf("managed identity was rejected: %#v", user)
		}
	}
	for _, user := range []struct {
		uid int
		raw string
	}{
		{},
		{raw: "root"},
		{raw: "0:0"},
		{raw: "65532:0"},
	} {
		if managedNonRootUser(user.uid, user.raw) {
			t.Fatalf("unsafe identity was accepted: %#v", user)
		}
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
	actual.Configuration.InitProcess.Environment = []string{
		"POSTGRES_PASSWORD=postgres-password-first-value-0001",
		"POSTGRES_DB=agentops",
		"PGDATA=/var/lib/postgresql/data",
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

func TestProbeRunnerProviderFailsClosedWithoutLeakingOutput(t *testing.T) {
	fake := &managerRuntimeRunner{results: []lifecycle.CommandResult{{
		Status: 1,
		Stderr: "secret provider rejection response",
	}}}
	subject := newManager(testManagerConfig(), lifecycle.NewAppleRuntimeForTest(fake))
	err := subject.probeRunnerProvider(context.Background())
	if err == nil || strings.Contains(err.Error(), "secret provider") {
		t.Fatalf("probeRunnerProvider() err=%v", err)
	}
	if len(fake.args) != 1 ||
		strings.Join(fake.args[0], " ") !=
			"exec agentops-runner codex debug models" {
		t.Fatalf("unexpected provider probe argv: %#v", fake.args)
	}
}

func TestPRIntentPinsCredentialAndProviderReadinessBoundaries(t *testing.T) {
	if ProviderProbeTimeout != 45*time.Second ||
		CredentialSeedReadyTimeout != 20*time.Second ||
		ContainerReadyPollInterval != 250*time.Millisecond ||
		CredentialInitializerLifetime != 10*time.Minute ||
		RunnerReadinessLogLines != 100 {
		t.Fatalf(
			"unexpected readiness boundaries: probe=%s seed=%s poll=%s initializer=%s logs=%d",
			ProviderProbeTimeout,
			CredentialSeedReadyTimeout,
			ContainerReadyPollInterval,
			CredentialInitializerLifetime,
			RunnerReadinessLogLines,
		)
	}
	if ProviderProbeTimeout <= control.DefaultMonitorBrokerTimeout ||
		CredentialSeedReadyTimeout >= CredentialInitializerLifetime {
		t.Fatal("provider/credential readiness relationships are unsafe")
	}
}

func TestPRIntentPostgresRotationUsesEnvironmentCapability(t *testing.T) {
	postgres := `[{"id":"agentops-postgres","configuration":{"labels":` +
		`{"com.mrbaron3.workflow.agentopsctl":"v1"}},"status":{"state":"running",` +
		`"networks":[{"network":"agentops-internal","ipv4Address":"192.0.2.10/24"}]}}]`
	fake := &managerRuntimeRunner{results: []lifecycle.CommandResult{
		{Status: 0, Stdout: "container 0.12.0"},
		{Status: 0},
		{Status: 0, Stdout: postgres},
		{Status: 0, Stdout: `{"rotated":true}`},
	}}
	cfg := testManagerConfig()
	cfg.PostgresPassword = "postgres-current-password-value-0001"
	cfg.NextPostgresPassword = "postgres-next-password-value-000002"
	cfg.ControlDBPassword = "control-role-password-value-000003"
	cfg.RunnerDBPassword = "runner-role-password-value-0000004"
	subject := newManager(cfg, lifecycle.NewAppleRuntimeForTest(fake))

	if err := subject.RotatePostgresAdmin(
		context.Background(),
		"rotation-request-001",
	); err != nil {
		t.Fatal(err)
	}
	if len(fake.environments) != 1 {
		t.Fatalf("admin environments = %#v", fake.environments)
	}
	environment := fake.environments[0]
	if environment["AGENTOPS_NEXT_POSTGRES_PASSWORD"] !=
		cfg.NextPostgresPassword {
		t.Fatal("next password was not forwarded through the environment")
	}
	argv := strings.Join(fake.args[len(fake.args)-1], " ")
	if strings.Contains(argv, cfg.NextPostgresPassword) ||
		!strings.Contains(argv, "rotate-postgres-admin --request-id rotation-request-001") {
		t.Fatalf("unsafe or incorrect rotation argv: %s", argv)
	}
}

func TestPRIntentPostgresRotationFailsClosedAndRedactsRuntimeFailure(t *testing.T) {
	cfg := testManagerConfig()
	cfg.PostgresPassword = "postgres-current-password-value-0001"
	cfg.ControlDBPassword = "control-role-password-value-000003"
	cfg.RunnerDBPassword = "runner-role-password-value-0000004"
	subject := newManager(cfg, lifecycle.NewAppleRuntimeForTest(
		&managerRuntimeRunner{},
	))
	if err := subject.RotatePostgresAdmin(
		context.Background(),
		"rotation-request-002",
	); err == nil {
		t.Fatal("missing next password was accepted")
	}

	cfg.NextPostgresPassword = "postgres-next-password-value-000002"
	postgres := `[{"id":"agentops-postgres","configuration":{"labels":` +
		`{"com.mrbaron3.workflow.agentopsctl":"v1"}},"status":{"state":"running",` +
		`"networks":[{"network":"agentops-internal","ipv4Address":"192.0.2.10/24"}]}}]`
	fake := &managerRuntimeRunner{results: []lifecycle.CommandResult{
		{Status: 0, Stdout: "container 0.12.0"},
		{Status: 0},
		{Status: 0, Stdout: postgres},
		{Status: 1, Stderr: "failure " + cfg.NextPostgresPassword},
	}}
	subject = newManager(cfg, lifecycle.NewAppleRuntimeForTest(fake))
	err := subject.RotatePostgresAdmin(
		context.Background(),
		"rotation-request-003",
	)
	if err == nil || strings.Contains(err.Error(), cfg.NextPostgresPassword) {
		t.Fatalf("rotation failure was absent or leaked a secret: %v", err)
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
