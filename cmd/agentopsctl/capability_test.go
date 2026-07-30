package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/mrbaron3/workflow/internal/lifecycle"
)

// privateStateDirectory points the capability store at a per-test root so no
// test generates, reads, or overwrites a secret in the operator's real home.
func privateStateDirectory(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("AGENTOPSCTL_STATE_DIR", root)
	return root
}

// capabilityEnvironment isolates loadConfig from the developer's own shell: the
// prefix, project root, and provider are pinned so a failure can only come from
// the capability resolution under test.
func capabilityEnvironment(t *testing.T, triage, runner string) string {
	t.Helper()
	root := privateStateDirectory(t)
	t.Setenv("AGENTOPSCTL_NAME_PREFIX", "agentops")
	t.Setenv("AGENTOPSCTL_PROJECT_ROOT", t.TempDir())
	t.Setenv("AGENTOPS_RUNNER_PROVIDER", "codex")
	t.Setenv("AGENTOPS_GITHUB_BROKER_TRIAGE_CAPABILITY", triage)
	t.Setenv("AGENTOPS_GITHUB_BROKER_RUNNER_CAPABILITY", runner)
	return root
}

func storePath(t *testing.T, root string) string {
	t.Helper()
	return filepath.Join(root, "agentops", brokerCapabilityFileName)
}

// Generation must be stable across commands. A capability regenerated on the
// second command would not match the one a running broker and its workers were
// started with, so every later status would read as topology drift.
func TestBrokerCapabilityGenerationIsIdempotentAndPerRole(t *testing.T) {
	root := privateStateDirectory(t)
	path, err := brokerCapabilityStorePath("agentops")
	if err != nil {
		t.Fatal(err)
	}
	if path != storePath(t, root) {
		t.Fatalf("store path = %q, want it under the configured state root", path)
	}
	first, err := loadOrCreateBrokerCapabilities(path)
	if err != nil {
		t.Fatalf("first bootstrap failed: %v", err)
	}
	second, err := loadOrCreateBrokerCapabilities(path)
	if err != nil {
		t.Fatalf("reading back the generated store failed: %v", err)
	}
	if first != second {
		t.Fatal("capabilities were regenerated; a started topology would read as drift")
	}
	if first.Triage == first.Runner {
		t.Fatal("triage and development were given one shared capability")
	}
	for role, capability := range map[string]string{
		"triage": first.Triage,
		"runner": first.Runner,
	} {
		if !brokerCapabilityPattern.MatchString(capability) {
			t.Errorf(
				"generated %s capability is not one the broker would accept",
				role,
			)
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("store mode = %v, want 0600", info.Mode().Perm())
	}
	directory, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if directory.Mode().Perm() != 0o700 {
		t.Errorf("store directory mode = %v, want 0700", directory.Mode().Perm())
	}
	// The atomic write must leave nothing readable behind on the way in.
	if _, err := os.Lstat(path + ".new"); !os.IsNotExist(err) {
		t.Errorf("temporary store survived the rename: %v", err)
	}
}

// foreignOwner presents a real entry as belonging to another account. Only root
// may chown one, so the foreign owner is presented rather than created — that is
// also the point of the check: an unprivileged principal who can write an
// ancestor may replace the store's directory but cannot forge whose it is.
type foreignOwner struct {
	os.FileInfo
	uid uint32
}

func (value foreignOwner) Sys() any {
	return &syscall.Stat_t{Uid: value.uid}
}

// unknownOwner stands for a filesystem that reports no owner at all.
type unknownOwner struct{ os.FileInfo }

func (unknownOwner) Sys() any { return nil }

// Mode bits stop deciding access when agentopsctl runs privileged, or when an
// ACL grants what the permission bits do not express. Ownership is what still
// holds, so a store that looks private but belongs to someone else is refused.
func TestBrokerCapabilityStoreRejectsAnotherAccountsOwnership(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agentops", brokerCapabilityFileName)
	if err := writeBrokerCapabilityStore(path, brokerCapabilityStore{
		Version: brokerCapabilityStoreVersion,
		Triage:  strings.Repeat("t", 43),
		Runner:  strings.Repeat("r", 43),
	}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !brokerCapabilityStoreOwnedByCaller(info) {
		t.Fatal("a store agentopsctl just created was read as another account's")
	}
	if brokerCapabilityStoreOwnedByCaller(foreignOwner{
		FileInfo: info,
		uid:      uint32(os.Geteuid() + 1),
	}) {
		t.Error("a store owned by another account was accepted")
	}
	if brokerCapabilityStoreOwnedByCaller(unknownOwner{FileInfo: info}) {
		t.Error("a store whose owner could not be established was accepted")
	}
}

// Two commands can bootstrap at once — a start in one terminal and a status in
// another. Whoever loses the race must adopt the persisted capabilities: a
// command that injected its own pair into the broker while the store kept
// another would make every later status report drift on a correct topology.
func TestConcurrentBrokerCapabilityBootstrapAgreesOnOnePair(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agentops", brokerCapabilityFileName)
	const commands = 8
	results := make(chan brokerCapabilityStore, commands)
	failures := make(chan error, commands)
	start := make(chan struct{})
	var waiting sync.WaitGroup
	for range commands {
		waiting.Add(1)
		go func() {
			defer waiting.Done()
			<-start
			store, err := loadOrCreateBrokerCapabilities(path)
			if err != nil {
				failures <- err
				return
			}
			results <- store
		}()
	}
	close(start)
	waiting.Wait()
	close(results)
	close(failures)
	for err := range failures {
		t.Fatalf("a concurrent bootstrap failed: %v", err)
	}
	persisted, err := readBrokerCapabilityStore(path)
	if err != nil {
		t.Fatal(err)
	}
	for store := range results {
		if store != persisted {
			t.Fatal("a concurrent command resolved capabilities the store does not hold")
		}
	}
	// The losers' temporaries must not be left behind next to the store.
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != brokerCapabilityFileName {
		t.Errorf("state directory holds %d entries, want only the store", len(entries))
	}
}

// A store that cannot be trusted is refused rather than replaced. Generating a
// fresh pair would hand the operator a capability the already-running broker
// does not honour, and would paper over a substituted or tampered store.
func TestBrokerCapabilityStoreRejectsUntrustworthyState(t *testing.T) {
	valid := brokerCapabilityStore{
		Version: brokerCapabilityStoreVersion,
		Triage:  strings.Repeat("t", 43),
		Runner:  strings.Repeat("r", 43),
	}
	rewrite := func(t *testing.T, path string, contents []byte) {
		t.Helper()
		if err := os.WriteFile(path, contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	encode := func(t *testing.T, store brokerCapabilityStore) []byte {
		t.Helper()
		contents, err := json.Marshal(store)
		if err != nil {
			t.Fatal(err)
		}
		return contents
	}
	for name, corrupt := range map[string]func(*testing.T, string){
		"group-readable store": func(t *testing.T, path string) {
			if err := os.Chmod(path, 0o640); err != nil {
				t.Fatal(err)
			}
		},
		// Directory write permission is substitution permission.
		"group-writable directory": func(t *testing.T, path string) {
			if err := os.Chmod(filepath.Dir(path), 0o770); err != nil {
				t.Fatal(err)
			}
		},
		// The directory the store is read from must be the real one, not a link
		// an attacker who can write an ancestor planted in its place.
		"symlinked directory": func(t *testing.T, path string) {
			elsewhere := t.TempDir()
			directory := filepath.Dir(path)
			if err := os.Rename(path, filepath.Join(
				elsewhere,
				brokerCapabilityFileName,
			)); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(directory); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(elsewhere, directory); err != nil {
				t.Fatal(err)
			}
		},
		"symlink to a valid store": func(t *testing.T, path string) {
			elsewhere := filepath.Join(t.TempDir(), brokerCapabilityFileName)
			rewrite(t, elsewhere, encode(t, valid))
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(elsewhere, path); err != nil {
				t.Fatal(err)
			}
		},
		"empty store": func(t *testing.T, path string) {
			rewrite(t, path, nil)
		},
		"truncated JSON": func(t *testing.T, path string) {
			rewrite(t, path, []byte(`{"version":1,"triage":"`))
		},
		"JSON that is not an object": func(t *testing.T, path string) {
			rewrite(t, path, []byte(`["capability"]`))
		},
		"oversized store": func(t *testing.T, path string) {
			padded := append(
				encode(t, valid),
				[]byte(strings.Repeat(" ", maxBrokerCapabilityStoreSize))...,
			)
			rewrite(t, path, padded)
		},
		"future store version": func(t *testing.T, path string) {
			ahead := valid
			ahead.Version = brokerCapabilityStoreVersion + 1
			rewrite(t, path, encode(t, ahead))
		},
		"unversioned store": func(t *testing.T, path string) {
			legacy := valid
			legacy.Version = 0
			rewrite(t, path, encode(t, legacy))
		},
		"short capability": func(t *testing.T, path string) {
			short := valid
			short.Runner = strings.Repeat("r", 42)
			rewrite(t, path, encode(t, short))
		},
		"non-URL-safe capability": func(t *testing.T, path string) {
			unsafe := valid
			unsafe.Triage = strings.Repeat("t", 42) + "="
			rewrite(t, path, encode(t, unsafe))
		},
		"shared capability": func(t *testing.T, path string) {
			shared := valid
			shared.Runner = shared.Triage
			rewrite(t, path, encode(t, shared))
		},
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(
				t.TempDir(),
				"agentops",
				brokerCapabilityFileName,
			)
			if err := writeBrokerCapabilityStore(path, valid); err != nil {
				t.Fatal(err)
			}
			corrupt(t, path)
			if _, err := readBrokerCapabilityStore(path); err == nil {
				t.Fatal("an untrustworthy capability store was accepted")
			}
			if _, err := loadOrCreateBrokerCapabilities(path); err == nil {
				t.Fatal("an untrustworthy capability store was silently replaced")
			}
		})
	}
}

// The prefix reaches a filesystem path, so it is a traversal vector: it names
// the state subdirectory the capabilities live in.
func TestBrokerCapabilityStorePathRefusesEscapingPrefixAndRoot(t *testing.T) {
	root := privateStateDirectory(t)
	for _, prefix := range []string{
		"",
		"..",
		"../elsewhere",
		"agentops/../../elsewhere",
		"agentops/nested",
		"/etc",
		".hidden",
		"name with spaces",
		strings.Repeat("p", 81),
	} {
		path, err := brokerCapabilityStorePath(prefix)
		if err == nil {
			t.Errorf("prefix %q was accepted and resolved to %q", prefix, path)
		}
	}
	// A rejected prefix must not have left state behind on the way out.
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("rejected prefixes created %d state entries", len(entries))
	}
	for _, invalid := range []string{"relative/state", ".", "/"} {
		t.Setenv("AGENTOPSCTL_STATE_DIR", invalid)
		if path, err := brokerCapabilityStorePath("agentops"); err == nil {
			t.Errorf("state root %q was accepted and resolved to %q", invalid, path)
		}
	}
}

// With no state directory configured the store belongs to the operator's home,
// which is the one place a per-user secret can default to.
func TestBrokerCapabilityStoreDefaultsUnderTheOperatorHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("AGENTOPSCTL_STATE_DIR", "")
	t.Setenv("HOME", home)
	path, err := brokerCapabilityStorePath("agentops")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, ".agentops", "agentops", brokerCapabilityFileName)
	if path != want {
		t.Fatalf("default store path = %q, want %q", path, want)
	}
}

// Issue #46's bootstrap requirement: a start needs no capability from the
// operator, and what agentopsctl generates has to satisfy the same start-time
// rule an operator-supplied value does.
func TestLoadConfigBootstrapsBothCapabilitiesWithoutOperatorInput(t *testing.T) {
	capabilityEnvironment(t, "", "")
	value, err := loadConfig()
	if err != nil {
		t.Fatalf("capability-free environment was rejected: %v", err)
	}
	// The remaining bootstrap credentials are supplied so the assertion below
	// tests the capability rule rather than a missing password.
	value.PostgresPassword = strings.Repeat("a", 32)
	value.ControlDBPassword = strings.Repeat("b", 32)
	value.TriageDBPassword = strings.Repeat("c", 32)
	value.RunnerDBPassword = strings.Repeat("d", 32)
	value.ControlToken = strings.Repeat("e", 32)
	value.DashboardToken = strings.Repeat("f", 32)
	value.WebhookSecret = strings.Repeat("g", 32)
	if err := value.validateBrokerCapabilities(lifecycle.ModeActive); err != nil {
		t.Fatalf("generated capabilities failed the start-time rule: %v", err)
	}
	if value.githubBrokerCapability("triage") ==
		value.githubBrokerCapability("runner") {
		t.Fatal("both roles were injected with one capability")
	}
	again, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if again.TriageBrokerCapability != value.TriageBrokerCapability ||
		again.RunnerBrokerCapability != value.RunnerBrokerCapability {
		t.Fatal("a second command resolved different capabilities")
	}
}

// An external secret manager stays the source of truth when it supplies both
// values: agentopsctl must not write a store it would never read.
func TestLoadConfigPrefersOperatorCapabilitiesOverTheStore(t *testing.T) {
	triage := strings.Repeat("T", 43)
	runner := strings.Repeat("R", 43)
	root := capabilityEnvironment(t, "  "+triage+"  ", runner)
	value, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if value.TriageBrokerCapability != triage ||
		value.RunnerBrokerCapability != runner {
		t.Fatalf(
			"operator capabilities were not used: triage match=%t runner match=%t",
			value.TriageBrokerCapability == triage,
			value.RunnerBrokerCapability == runner,
		)
	}
	if _, err := os.Lstat(storePath(t, root)); !os.IsNotExist(err) {
		t.Errorf("a capability store was created despite both values being supplied: %v", err)
	}
}

// A half-configured environment is the likely migration state: an operator who
// registered triage by hand should not have to register the runner too.
func TestLoadConfigGeneratesOnlyTheMissingCapability(t *testing.T) {
	triage := strings.Repeat("T", 43)
	root := capabilityEnvironment(t, triage, "")
	value, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if value.TriageBrokerCapability != triage {
		t.Fatal("the operator's triage capability was overwritten by the store")
	}
	if !brokerCapabilityPattern.MatchString(value.RunnerBrokerCapability) ||
		value.RunnerBrokerCapability == triage {
		t.Fatalf(
			"the missing runner capability was not independently generated: %q",
			value.RunnerBrokerCapability,
		)
	}
	store, err := readBrokerCapabilityStore(storePath(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if store.Runner != value.RunnerBrokerCapability {
		t.Fatal("the injected runner capability is not the persisted one")
	}
	if store.Triage == triage {
		t.Fatal("the operator's capability was copied into the store")
	}
}
