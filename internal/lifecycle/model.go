package lifecycle

import (
	"fmt"
	"strings"
	"time"
)

type Mode string

const (
	ModeOff                     Mode = "OFF"
	ModeMonitorOnly             Mode = "MONITOR_ONLY"
	ModeActive                  Mode = "ACTIVE"
	ModeDraining                Mode = "DRAINING"
	DefaultReconcileMaxAttempts      = 3
	DefaultReconcileRetryBase        = 5 * time.Second
)

func ParseMode(raw string) (Mode, error) {
	switch Mode(strings.ToUpper(strings.TrimSpace(raw))) {
	case ModeOff:
		return ModeOff, nil
	case ModeMonitorOnly:
		return ModeMonitorOnly, nil
	case ModeActive:
		return ModeActive, nil
	case ModeDraining:
		return ModeDraining, nil
	default:
		return "", fmt.Errorf(
			"operating mode must be OFF, MONITOR_ONLY, ACTIVE, or DRAINING",
		)
	}
}

func ValidTransition(from, to Mode) bool {
	if from == to {
		return true
	}
	switch from {
	case ModeOff:
		return to == ModeMonitorOnly
	case ModeMonitorOnly:
		return to == ModeActive || to == ModeOff
	case ModeActive:
		return to == ModeDraining
	case ModeDraining:
		return to == ModeOff || to == ModeMonitorOnly
	default:
		return false
	}
}

type State struct {
	Mode                Mode       `json:"mode"`
	Generation          int64      `json:"generation"`
	TransitionID        *string    `json:"transitionId"`
	TransitionStartedAt *time.Time `json:"transitionStartedAt"`
	DrainDeadlineAt     *time.Time `json:"drainDeadlineAt"`
	DrainTimedOut       bool       `json:"drainTimedOut"`
	LastError           *string    `json:"lastError"`
	UpdatedAt           time.Time  `json:"updatedAt"`
}

type Transition struct {
	ID              string         `json:"id"`
	IdempotencyKey  string         `json:"idempotencyKey"`
	ActorID         string         `json:"actorId"`
	FromMode        Mode           `json:"fromMode"`
	ToMode          Mode           `json:"toMode"`
	Status          string         `json:"status"`
	DrainDeadlineAt *time.Time     `json:"drainDeadlineAt"`
	Error           *string        `json:"error"`
	Details         map[string]any `json:"details"`
	StartedAt       time.Time      `json:"startedAt"`
	FinishedAt      time.Time      `json:"finishedAt"`
	Replayed        bool           `json:"replayed"`
}

type AttemptStatus struct {
	JobID        string     `json:"jobId"`
	AttemptID    string     `json:"attemptId"`
	Attempt      int        `json:"attempt"`
	WorkerID     string     `json:"workerId"`
	Status       string     `json:"status"`
	StartedAt    time.Time  `json:"startedAt"`
	FinishedAt   *time.Time `json:"finishedAt"`
	LeaseExpires *time.Time `json:"leaseExpiresAt"`
	Error        *string    `json:"error"`
}

type Status struct {
	State             State           `json:"state"`
	QueuedJobs        int64           `json:"queuedJobs"`
	ActiveLeases      int64           `json:"activeLeases"`
	InFlightAttempts  int64           `json:"inFlightAttempts"`
	LastJobError      *string         `json:"lastJobError"`
	RecentAttempts    []AttemptStatus `json:"recentAttempts"`
	RecentTransitions []Transition    `json:"recentTransitions"`
	DatabaseTime      time.Time       `json:"databaseTime"`
}
