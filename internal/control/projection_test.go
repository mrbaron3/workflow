package control

import "testing"

func TestProjectionAnomalyUsesComponentSpecificHealthyStates(t *testing.T) {
	base := RegistrationProjection{Components: map[string]ComponentProjection{
		ComponentIssueMonitor: {
			Desired: true, Actual: "running", Freshness: "fresh",
		},
		ComponentPRMonitor: {
			Desired: false, Actual: "stopped", Freshness: "fresh",
		},
		ComponentForwarder: {
			Desired: true, Actual: "starting", Freshness: "fresh",
		},
		ComponentExecution: {
			Desired: true, Actual: "running", Freshness: "fresh",
		},
		ComponentQueue: {
			Desired: true, Actual: "queued", Freshness: "fresh",
		},
	}}
	if projectionHasAnomaly(base) {
		t.Fatalf("healthy queued projection was classified as anomalous: %#v", base)
	}
	base.Components[ComponentQueue] = ComponentProjection{
		Desired: true, Actual: "leased", Freshness: "fresh",
	}
	if projectionHasAnomaly(base) {
		t.Fatalf("healthy leased projection was classified as anomalous: %#v", base)
	}
	base.Components[ComponentQueue] = ComponentProjection{
		Desired: true, Actual: "waiting", Freshness: "fresh",
	}
	if !projectionHasAnomaly(base) {
		t.Fatal("queue state from the execution vocabulary was not classified as divergent")
	}
	base.Components[ComponentQueue] = ComponentProjection{
		Desired: true, Actual: "unknown", Freshness: "unknown",
	}
	if !projectionHasAnomaly(base) {
		t.Fatal("unknown evidence was not classified as anomalous")
	}
}
