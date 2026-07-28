package lifecycle

import (
	"testing"
	"time"
)

func TestProductionReconciliationBoundaries(t *testing.T) {
	if DefaultReconcileMaxAttempts != 3 {
		t.Fatalf("max attempts = %d", DefaultReconcileMaxAttempts)
	}
	if DefaultReconcileRetryBase != 5*time.Second {
		t.Fatalf("retry base = %s", DefaultReconcileRetryBase)
	}
}

func TestExplicitLifecycleTransitions(t *testing.T) {
	valid := [][2]Mode{
		{ModeOff, ModeOff},
		{ModeOff, ModeMonitorOnly},
		{ModeMonitorOnly, ModeActive},
		{ModeMonitorOnly, ModeOff},
		{ModeActive, ModeDraining},
		{ModeDraining, ModeMonitorOnly},
		{ModeDraining, ModeOff},
	}
	for _, transition := range valid {
		if !ValidTransition(transition[0], transition[1]) {
			t.Fatalf("%s -> %s must be valid", transition[0], transition[1])
		}
	}
	invalid := [][2]Mode{
		{ModeOff, ModeActive},
		{ModeOff, ModeDraining},
		{ModeMonitorOnly, ModeDraining},
		{ModeActive, ModeOff},
		{ModeActive, ModeMonitorOnly},
		{ModeDraining, ModeActive},
	}
	for _, transition := range invalid {
		if ValidTransition(transition[0], transition[1]) {
			t.Fatalf("%s -> %s must be invalid", transition[0], transition[1])
		}
	}
}

func TestParseMode(t *testing.T) {
	mode, err := ParseMode(" draining ")
	if err != nil || mode != ModeDraining {
		t.Fatalf("ParseMode() = %q, %v", mode, err)
	}
	if _, err := ParseMode("paused"); err == nil {
		t.Fatal("unknown mode was accepted")
	}
}
