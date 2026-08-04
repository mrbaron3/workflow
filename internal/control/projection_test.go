package control

import (
	"testing"
	"time"
)

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

func TestCanonicalDevelopmentProgressTerminalFailureOverridesStaleRunningEvent(t *testing.T) {
	now := time.Date(2026, 8, 4, 3, 0, 0, 0, time.UTC)
	lastError := "provider process exited before recording a terminal progress event"
	event := DevelopmentProgressEvent{
		Phase:        "generation",
		Step:         "generator session attempt 1/3",
		State:        "running",
		NextGate:     textPointer("generated revision"),
		OccurredAt:   now.Add(-20 * time.Minute),
		JobStatus:    "failed",
		JobLastError: &lastError,
	}

	projected := canonicalDevelopmentProgress(event, now)
	if projected.KanbanLane != "failed" || projected.Phase != "failed" ||
		projected.State != "failed" || projected.Step != "runner job failed" ||
		projected.Blocker == nil || *projected.Blocker != lastError ||
		projected.HumanAction == nil || !projected.Terminal {
		t.Fatalf("terminal projection = %#v", projected)
	}
}

func TestCanonicalDevelopmentProgressMergedReleaseOverridesReviewWait(t *testing.T) {
	now := time.Date(2026, 8, 4, 3, 0, 0, 0, time.UTC)
	status := "merged"
	head := "0123456789012345678901234567890123456789"
	event := DevelopmentProgressEvent{
		Phase:            "review",
		Step:             "perspective review panel",
		State:            "running",
		OccurredAt:       now.Add(-time.Hour),
		JobStatus:        "succeeded",
		ReleaseStatus:    &status,
		ReleaseFinalHead: &head,
	}

	projected := canonicalDevelopmentProgress(event, now)
	if projected.KanbanLane != "released" || projected.Phase != "completed" ||
		projected.State != "succeeded" || projected.HeadSHA == nil ||
		*projected.HeadSHA != head || !projected.Terminal {
		t.Fatalf("release projection = %#v", projected)
	}
}

func TestCanonicalDevelopmentProgressExpiredLeaseBecomesBoundedRecoveryWait(t *testing.T) {
	now := time.Date(2026, 8, 4, 3, 0, 0, 0, time.UTC)
	expired := now.Add(-time.Second)
	event := DevelopmentProgressEvent{
		Phase:          "planning",
		Step:           "planning session",
		State:          "running",
		OccurredAt:     now.Add(-10 * time.Minute),
		JobStatus:      "leased",
		LeaseExpiresAt: &expired,
	}

	projected := canonicalDevelopmentProgress(event, now)
	if projected.KanbanLane != "gate-wait" || projected.State != "waiting" ||
		projected.Step != "expired lease recovery pending" ||
		projected.HumanAction != nil || projected.Terminal {
		t.Fatalf("lease recovery projection = %#v", projected)
	}
}

func TestCanonicalDevelopmentProgressProjectsPreEventJobsFromDurableOwnership(t *testing.T) {
	now := time.Date(2026, 8, 4, 3, 0, 0, 0, time.UTC)
	ready := canonicalDevelopmentProgress(DevelopmentProgressEvent{
		JobType: "agentops.triage", JobStatus: "queued", EventKey: "job:queued",
		OccurredAt: now.Add(-time.Minute),
	}, now)
	if ready.KanbanLane != "ready" || ready.State != "pending" ||
		ready.Step != "ready Issue queued for intake" {
		t.Fatalf("queued triage projection = %#v", ready)
	}

	expires := now.Add(time.Minute)
	claimed := canonicalDevelopmentProgress(DevelopmentProgressEvent{
		JobType: "agentops.runner", JobStatus: "leased", EventKey: "job:leased",
		AttemptNumber: 1, LeaseExpiresAt: &expires, OccurredAt: now.Add(-time.Minute),
	}, now)
	if claimed.KanbanLane != "intake-planning" || claimed.State != "running" ||
		claimed.Step != "claimed work starting" {
		t.Fatalf("live pre-event lease projection = %#v", claimed)
	}
}

func TestCanonicalDevelopmentProgressMeasuresGateWaitWithFakeClock(t *testing.T) {
	entered := time.Date(2026, 8, 4, 3, 0, 0, 0, time.UTC)
	event := DevelopmentProgressEvent{
		Phase:      "merge",
		Step:       "GitHub merge gates",
		State:      "waiting",
		OccurredAt: entered,
		JobStatus:  "succeeded",
	}

	projected := canonicalDevelopmentProgress(event, entered.Add(95*time.Second))
	if projected.KanbanLane != "gate-wait" || projected.GateEnteredAt == nil ||
		!projected.GateEnteredAt.Equal(entered) || projected.GateWaitSeconds != 95 {
		t.Fatalf("gate wait projection = %#v", projected)
	}
}

func TestCanonicalDevelopmentProgressProjectsOneShotGateEscalation(t *testing.T) {
	entered := time.Date(2026, 8, 4, 1, 0, 0, 0, time.UTC)
	now := entered.Add(91 * time.Minute)
	escalationID := int64(7)
	reason := "review gate exceeded its 3600 second SLA"
	action := "inspect perspective evidence and push a corrected current head"
	head := "0123456789012345678901234567890123456789"
	gate := "review"
	round := 2
	event := DevelopmentProgressEvent{
		Phase:                 "review",
		Step:                  "perspective review panel",
		State:                 "running",
		OccurredAt:            entered,
		JobStatus:             "leased",
		GateKey:               &gate,
		ReviewRound:           &round,
		EscalationID:          &escalationID,
		EscalationReason:      &reason,
		EscalationHumanAction: &action,
		EscalationGateEntered: &entered,
		EscalationTargetSHA:   &head,
		EscalationEvidence:    []byte(`{"timeoutSeconds":3600}`),
	}

	projected := canonicalDevelopmentProgress(event, now)
	if projected.KanbanLane != "human-escalated" || projected.State != "blocked" ||
		projected.Blocker == nil || *projected.Blocker != reason ||
		projected.HumanAction == nil || *projected.HumanAction != action ||
		projected.HeadSHA == nil || *projected.HeadSHA != head ||
		projected.ReviewOutcome == nil || *projected.ReviewOutcome != "escalated" ||
		projected.GateWaitSeconds != int64((91*time.Minute)/time.Second) ||
		projected.Terminal {
		t.Fatalf("escalation projection = %#v", projected)
	}
}
