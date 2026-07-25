package control

import (
	"encoding/json"
	"os"
	"path/filepath"
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
