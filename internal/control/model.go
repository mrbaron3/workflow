package control

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	ComponentIssueMonitor = "issue_monitor"
	ComponentPRMonitor    = "pr_monitor"
	ComponentForwarder    = "forwarder"
)

var repositoryPattern = regexp.MustCompile(`^[a-z0-9_.-]+/[a-z0-9_.-]+$`)

var (
	ErrNotFound            = errors.New("not found")
	ErrConflict            = errors.New("conflict")
	ErrStaleRegistration   = errors.New("registration is stale or disabled")
	ErrStoreUnavailable    = errors.New("control store unavailable")
	ErrIdempotencyConflict = errors.New("idempotency key was reused for a different request")
)

type Registration struct {
	ID                  string          `json:"id"`
	Repository          string          `json:"repository"`
	Enabled             bool            `json:"enabled"`
	IssueMonitorEnabled bool            `json:"issueMonitorEnabled"`
	PRMonitorEnabled    bool            `json:"prMonitorEnabled"`
	ExecutionEnabled    bool            `json:"executionEnabled"`
	Configuration       json.RawMessage `json:"configuration"`
	Version             int64           `json:"version"`
	CreatedAt           time.Time       `json:"createdAt"`
	UpdatedAt           time.Time       `json:"updatedAt"`
}

type CreateRegistration struct {
	Repository          string          `json:"repository"`
	Enabled             *bool           `json:"enabled,omitempty"`
	IssueMonitorEnabled *bool           `json:"issueMonitorEnabled,omitempty"`
	PRMonitorEnabled    *bool           `json:"prMonitorEnabled,omitempty"`
	ExecutionEnabled    *bool           `json:"executionEnabled,omitempty"`
	Configuration       json.RawMessage `json:"configuration,omitempty"`
}

type RegistrationPatch struct {
	Enabled             *bool           `json:"enabled,omitempty"`
	IssueMonitorEnabled *bool           `json:"issueMonitorEnabled,omitempty"`
	PRMonitorEnabled    *bool           `json:"prMonitorEnabled,omitempty"`
	ExecutionEnabled    *bool           `json:"executionEnabled,omitempty"`
	Configuration       json.RawMessage `json:"configuration,omitempty"`
}

func (input CreateRegistration) Validated() (Registration, error) {
	repository := strings.ToLower(strings.TrimSpace(input.Repository))
	if !repositoryPattern.MatchString(repository) {
		return Registration{}, fmt.Errorf("repository must be canonical owner/name")
	}
	enabled, issue, pr, execution := true, true, true, true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	if input.IssueMonitorEnabled != nil {
		issue = *input.IssueMonitorEnabled
	}
	if input.PRMonitorEnabled != nil {
		pr = *input.PRMonitorEnabled
	}
	if input.ExecutionEnabled != nil {
		execution = *input.ExecutionEnabled
	}
	configuration := input.Configuration
	if len(configuration) == 0 {
		configuration = json.RawMessage(`{}`)
	}
	if !validJSONObject(configuration) {
		return Registration{}, fmt.Errorf("configuration must be a JSON object")
	}
	return Registration{
		Repository: repository, Enabled: enabled,
		IssueMonitorEnabled: issue, PRMonitorEnabled: pr,
		ExecutionEnabled: execution, Configuration: configuration,
	}, nil
}

func (patch RegistrationPatch) Validate() error {
	if patch.Enabled == nil && patch.IssueMonitorEnabled == nil &&
		patch.PRMonitorEnabled == nil && patch.ExecutionEnabled == nil &&
		len(patch.Configuration) == 0 {
		return fmt.Errorf("registration patch is empty")
	}
	if len(patch.Configuration) > 0 && !validJSONObject(patch.Configuration) {
		return fmt.Errorf("configuration must be a JSON object")
	}
	return nil
}

func validJSONObject(raw json.RawMessage) bool {
	var value map[string]json.RawMessage
	return json.Unmarshal(raw, &value) == nil && value != nil && len(value) == 0
}

func (registration Registration) Desired(component string) bool {
	if !registration.Enabled {
		return false
	}
	switch component {
	case ComponentIssueMonitor:
		return registration.IssueMonitorEnabled
	case ComponentPRMonitor:
		return registration.PRMonitorEnabled
	case ComponentForwarder:
		return registration.IssueMonitorEnabled || registration.PRMonitorEnabled
	default:
		return false
	}
}

type ActualState struct {
	Component           string     `json:"component"`
	RegistrationVersion int64      `json:"registrationVersion"`
	State               string     `json:"state"`
	SupervisorID        string     `json:"supervisorId"`
	ObservedAt          time.Time  `json:"observedAt"`
	LastHealthyAt       *time.Time `json:"lastHealthyAt"`
	LastError           *string    `json:"lastError"`
}

type ComponentProjection struct {
	Desired       bool       `json:"desired"`
	State         string     `json:"state"`
	ObservedAt    *time.Time `json:"observedAt"`
	LastHealthyAt *time.Time `json:"lastHealthyAt"`
	LastError     *string    `json:"lastError"`
	Stale         bool       `json:"stale"`
}

type RegistrationProjection struct {
	Registration Registration                   `json:"registration"`
	Components   map[string]ComponentProjection `json:"components"`
	LastPoll     map[string]*time.Time          `json:"lastPoll"`
	LastDelivery *time.Time                     `json:"lastDelivery"`
	QueueDepth   int64                          `json:"queueDepth"`
	ActiveJobID  *string                        `json:"activeJobId"`
}

type WorkItem struct {
	Repository string         `json:"repository"`
	Kind       string         `json:"kind"`
	Number     int64          `json:"number"`
	UpdatedAt  time.Time      `json:"updatedAt"`
	Payload    map[string]any `json:"-"`
}

func (item WorkItem) IdempotencyKey() string {
	return fmt.Sprintf(
		"github:%s:%s:%d:%s",
		strings.ToLower(item.Repository),
		item.Kind,
		item.Number,
		item.UpdatedAt.UTC().Format(time.RFC3339Nano),
	)
}

func (item WorkItem) CanonicalPayload() map[string]any {
	return map[string]any{
		"repository": strings.ToLower(item.Repository),
		"entityKind": item.Kind,
		"number":     item.Number,
		"updatedAt":  item.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

type WebhookReceipt struct {
	DeliveryID string `json:"deliveryId"`
	Duplicate  bool   `json:"duplicate"`
	Status     string `json:"status"`
}

type ClaimedDelivery struct {
	ID                  string
	DeliveryKey         string
	Repository          string
	Event               string
	Action              *string
	Payload             map[string]any
	Token               string
	RouteAttempts       int
	RegistrationID      *string
	RegistrationVersion *int64
}

type RetryResult struct {
	AttemptID   string `json:"attemptId"`
	DeliveryID  string `json:"deliveryId"`
	State       string `json:"state"`
	Cancellable bool   `json:"cancellable"`
}

type DeliveryRetryConflict struct {
	Reason        string `json:"reason"`
	State         string `json:"state"`
	RouteAttempts int    `json:"routeAttempts"`
}

func (conflict *DeliveryRetryConflict) Error() string {
	return fmt.Sprintf(
		"delivery retry rejected: %s (state=%s, routeAttempts=%d)",
		conflict.Reason,
		conflict.State,
		conflict.RouteAttempts,
	)
}

func (conflict *DeliveryRetryConflict) Unwrap() error {
	switch conflict.Reason {
	case "registration_disabled", "registration_missing", "registration_stale":
		return ErrStaleRegistration
	default:
		return ErrConflict
	}
}
