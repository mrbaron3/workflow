package lifecycle

import (
	"context"
	"strings"
	"testing"
)

type fakeRuntimeRunner struct {
	results []CommandResult
	args    [][]string
}

func (runner *fakeRuntimeRunner) Run(
	_ context.Context,
	args []string,
) CommandResult {
	runner.args = append(runner.args, append([]string(nil), args...))
	if len(runner.results) == 0 {
		return CommandResult{}
	}
	result := runner.results[0]
	runner.results = runner.results[1:]
	result.Args = append([]string(nil), args...)
	return result
}

func TestBuildContainerArgsEnforcesPublicationAndNamedMounts(t *testing.T) {
	base := ContainerSpec{
		Name: "agentops-runner", Role: "runner", Image: "runner:test",
		Networks: []string{"agentops-internal"}, Detach: true,
		ReadOnly: true, CapDropAll: true,
		Mounts: []Mount{{Volume: "agentops-runner-data", Target: "/workspace"}},
	}
	if _, _, err := buildContainerArgs(base); err != nil {
		t.Fatal(err)
	}
	published := base
	published.Publish = []Publication{{
		HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 8080,
	}}
	if _, _, err := buildContainerArgs(published); err == nil {
		t.Fatal("runner host publication was accepted")
	}
	bind := base
	bind.Mounts[0].Volume = "/Users/operator"
	if _, _, err := buildContainerArgs(bind); err == nil {
		t.Fatal("host bind mount was accepted")
	}
}

func TestContainerSpecDigestBindsImageEnvironmentAndInit(t *testing.T) {
	spec := ContainerSpec{
		Name: "agentops-control", Role: "control", Image: "control:test",
		Networks: []string{"default", "agentops-internal"},
		Environment: map[string]string{
			"AGENTOPS_OPERATING_MODE": "ACTIVE",
			"SECRET":                  "first",
		},
		Init: true, ReadOnly: true, CapDropAll: true, Detach: true,
		Publish: []Publication{{
			HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 8080,
		}},
	}
	digest, err := SpecDigest(
		spec,
		"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	)
	if err != nil {
		t.Fatal(err)
	}
	spec.SpecDigest = digest
	args, _, err := buildContainerArgs(spec)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(
		strings.Join(args, " "),
		"--label com.mrbaron3.workflow.spec-sha256="+digest,
	) {
		t.Fatalf("spec digest label is absent: %v", args)
	}
	rotated := spec
	rotated.Environment = map[string]string{
		"AGENTOPS_OPERATING_MODE": "ACTIVE",
		"SECRET":                  "second",
	}
	rotatedDigest, err := SpecDigest(
		rotated,
		"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	)
	if err != nil {
		t.Fatal(err)
	}
	if rotatedDigest == digest {
		t.Fatal("environment rotation did not change the canonical digest")
	}
	imageDigest, err := SpecDigest(
		spec,
		"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	)
	if err != nil {
		t.Fatal(err)
	}
	if imageDigest == digest {
		t.Fatal("immutable image rotation did not change the canonical digest")
	}
}

func TestImageDigestParsesImmutableDescriptor(t *testing.T) {
	fake := &fakeRuntimeRunner{results: []CommandResult{{
		Status: 0,
		Stdout: `{"configuration":{"descriptor":{"digest":"sha256:` +
			strings.Repeat("a", 64) + `"}}}`,
	}}}
	runtime := NewAppleRuntimeForTest(fake)
	digest, err := runtime.ImageDigest(context.Background(), "control:test")
	if err != nil || digest != "sha256:"+strings.Repeat("a", 64) {
		t.Fatalf("ImageDigest() = %q, %v", digest, err)
	}
}

func TestBuildControlArgsAreExactLoopbackAndSecretsRedact(t *testing.T) {
	spec := ContainerSpec{
		Name: "agentops-control", Role: "control", Image: "control:test",
		Networks: []string{"agentops-internal", "default"}, Detach: true,
		ReadOnly: true, CapDropAll: true,
		Publish: []Publication{{
			HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 8080,
		}},
		Environment: map[string]string{"SECRET": "do-not-leak"},
	}
	args, _, err := buildContainerArgs(spec)
	if err != nil {
		t.Fatal(err)
	}
	rendered := strings.Join(args, " ")
	if !strings.Contains(rendered, "--publish 127.0.0.1:8080:8080") ||
		!strings.Contains(rendered, "--network agentops-internal --network default") {
		t.Fatalf("unexpected argv: %s", rendered)
	}
	if strings.Contains(rendered, "do-not-leak") ||
		!strings.Contains(rendered, "--env SECRET") {
		t.Fatalf("environment value leaked into argv: %s", rendered)
	}
	redacted := strings.Join(redactArgs(args), " ")
	if strings.Contains(redacted, "do-not-leak") {
		t.Fatalf("secret was not redacted: %s", redacted)
	}
}

func TestEnsureNetworkRejectsForeignResource(t *testing.T) {
	fake := &fakeRuntimeRunner{results: []CommandResult{{
		Status: 0,
		Stdout: `[{"id":"agentops-internal","configuration":{"mode":"host","labels":{}}}]`,
	}}}
	runtime := NewAppleRuntimeForTest(fake)
	if err := runtime.EnsureNetwork(context.Background(), "agentops-internal"); err == nil {
		t.Fatal("foreign network was accepted")
	}
}

func TestVolumeInitCanAddOnlyChownCapability(t *testing.T) {
	args, _, err := buildContainerArgs(ContainerSpec{
		Name:       "agentops-volume-init",
		Role:       "volume-init",
		Image:      "runner:test",
		Networks:   []string{"agentops-internal"},
		CapDropAll: true,
		CapAdd:     []string{"CAP_CHOWN"},
		Remove:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(
		strings.Join(args, " "),
		"--cap-drop ALL --cap-add CAP_CHOWN",
	) {
		t.Fatalf("unexpected argv: %s", strings.Join(args, " "))
	}
}

func TestEnsureNetworkAcceptsOwnedHostOnlyResource(t *testing.T) {
	fake := &fakeRuntimeRunner{results: []CommandResult{{
		Status: 0,
		Stdout: `[{"id":"agentops-internal","configuration":{"mode":"hostOnly","labels":{"com.mrbaron3.workflow.agentopsctl":"v1"}}}]`,
	}}}
	runtime := NewAppleRuntimeForTest(fake)
	if err := runtime.EnsureNetwork(context.Background(), "agentops-internal"); err != nil {
		t.Fatalf("owned host-only network was rejected: %v", err)
	}
}

func TestRuntimeErrorsRedactEnvironmentValues(t *testing.T) {
	fake := &fakeRuntimeRunner{results: []CommandResult{{
		Status: 1, Stderr: "credential secret-value rejected",
	}}}
	runtime := NewAppleRuntimeForTest(fake)
	_, err := runtime.RunContainer(context.Background(), ContainerSpec{
		Name: "agentops-control", Role: "control", Image: "control:test",
		Networks: []string{"agentops-internal"}, Detach: true,
		Publish: []Publication{{
			HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 8080,
		}},
		Environment: map[string]string{"TOKEN": "secret-value"},
	})
	if err == nil || strings.Contains(err.Error(), "secret-value") {
		t.Fatalf("error was not safely redacted: %v", err)
	}
}
