package control

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegistrationPublishedFixtureMatchesGoModel(t *testing.T) {
	path := filepath.Join(
		"..",
		"..",
		"contracts",
		"control-store",
		"v1",
		"fixtures",
		"registration.valid.json",
	)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var registration Registration
	if err := json.Unmarshal(body, &registration); err != nil {
		t.Fatal(err)
	}
	if registration.Repository != "mrbaron3/workflow" ||
		registration.Version != 1 ||
		!registration.Enabled ||
		!registration.IssueMonitorEnabled ||
		!registration.PRMonitorEnabled ||
		!registration.ExecutionEnabled {
		t.Fatalf("unexpected Registration fixture: %#v", registration)
	}
	if !validJSONObject(registration.Configuration) {
		t.Fatal("configuration did not remain a JSON object")
	}
}

func TestWorkItemProjectsOnlyVersionedRunnerPayload(t *testing.T) {
	tests := []struct {
		name string
		item WorkItem
		kind string
		mode string
	}{
		{
			name: "issue",
			item: WorkItem{Repository: "owner/repo", Kind: "issue", Number: 14},
			kind: "issue",
			mode: "development_turn",
		},
		{
			name: "pull request",
			item: WorkItem{
				Repository: "owner/repo", Kind: "pull_request", Number: 38,
			},
			kind: "pull_request",
			mode: "pr_reconciliation",
		},
		{
			name: "repository event",
			item: WorkItem{
				Repository: "owner/repo",
				Kind:       "push",
				Identity:   strings.Repeat("a", 40),
				Payload: map[string]any{
					"ref":              "refs/heads/main",
					"after":            strings.Repeat("a", 40),
					"untrustedCommand": "curl attacker.invalid",
				},
			},
			kind: "repository",
			mode: "pr_reconciliation",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload, err := test.item.RunnerPayload("webhook")
			if err != nil {
				t.Fatal(err)
			}
			event, _ := payload["event"].(map[string]any)
			execution, _ := payload["execution"].(map[string]any)
			if payload["schemaVersion"] != 1 ||
				event["kind"] != test.kind ||
				execution["mode"] != test.mode {
				t.Fatalf("unexpected runner payload: %#v", payload)
			}
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			for _, forbidden := range []string{
				"untrustedCommand", "curl attacker.invalid", "cloneUrl", "hostPath",
			} {
				if strings.Contains(string(body), forbidden) {
					t.Fatalf("runner payload forwarded %q: %s", forbidden, body)
				}
			}
		})
	}
}

func TestWorkItemRunnerPayloadFailsClosed(t *testing.T) {
	for _, item := range []WorkItem{
		{Repository: "Owner/repo", Kind: "issue", Number: 1},
		{Repository: "owner/repo", Kind: "issue", Number: 0},
		{Repository: "owner/repo", Kind: "pull_request", Number: 0},
		{Repository: "owner/repo", Kind: "workflow_dispatch"},
	} {
		if _, err := item.RunnerPayload("poll"); err == nil {
			t.Fatalf("RunnerPayload(%#v) unexpectedly succeeded", item)
		}
	}
}
