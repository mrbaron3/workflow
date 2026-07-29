package main

import (
	"testing"

	"github.com/mrbaron3/workflow/internal/githubapp"
	"github.com/mrbaron3/workflow/internal/lifecycle"
)

// Compensation restores the broker while draining, so DRAINING has to be a
// state the broker serves rather than one it refuses. It carries exactly
// ACTIVE's scopes — no more, and not fewer than a draining runner needs to
// close the attempt it was told to finish.
func TestBrokerPoliciesPerLifecycleMode(t *testing.T) {
	monitor := []string{"acme/design-system", "acme/widgets"}
	runner := []string{"acme/design-system"}
	for _, expectation := range []struct {
		mode          lifecycle.Mode
		roles         int
		issues        string
		runnerScopes  []string
		developmental bool
	}{
		{
			mode: lifecycle.ModeMonitorOnly, roles: 1, issues: "read",
		},
		{
			mode: lifecycle.ModeActive, roles: 2, issues: "write",
			runnerScopes: runner, developmental: true,
		},
		{
			mode: lifecycle.ModeDraining, roles: 2, issues: "write",
			runnerScopes: runner, developmental: true,
		},
	} {
		if DevelopmentMode(expectation.mode) != expectation.developmental {
			t.Fatalf("%s development classification is wrong", expectation.mode)
		}
		policies := brokerPolicies(expectation.mode, monitor, runner)
		if len(policies) != expectation.roles {
			t.Fatalf("%s policies = %#v", expectation.mode, policies)
		}
		if policies[0].Role != githubapp.RoleTriage ||
			policies[0].Permissions["issues"] != expectation.issues ||
			policies[0].Permissions["contents"] != "read" ||
			policies[0].Permissions["pull_requests"] != "read" ||
			len(policies[0].Repositories) != len(monitor) {
			t.Fatalf("%s triage policy = %#v", expectation.mode, policies[0])
		}
		if !expectation.developmental {
			continue
		}
		if policies[1].Role != githubapp.RoleRunner ||
			len(policies[1].Repositories) != len(expectation.runnerScopes) ||
			policies[1].Permissions["contents"] != "write" ||
			policies[1].Permissions["workflows"] != "write" {
			t.Fatalf("%s runner policy = %#v", expectation.mode, policies[1])
		}
	}
	// ACTIVE and DRAINING must not diverge; a drain that quietly narrowed the
	// runner's scope would fail its in-flight attempt instead of finishing it.
	active := brokerPolicies(lifecycle.ModeActive, monitor, runner)
	draining := brokerPolicies(lifecycle.ModeDraining, monitor, runner)
	for index := range active {
		if active[index].Role != draining[index].Role ||
			len(active[index].Permissions) !=
				len(draining[index].Permissions) {
			t.Fatalf("DRAINING diverged from ACTIVE at role %d", index)
		}
		for name, level := range active[index].Permissions {
			if draining[index].Permissions[name] != level {
				t.Fatalf(
					"DRAINING %s permission %s = %q, want %q",
					active[index].Role,
					name,
					draining[index].Permissions[name],
					level,
				)
			}
		}
	}
}
