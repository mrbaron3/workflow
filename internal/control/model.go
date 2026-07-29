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
	ComponentExecution    = "execution"
	ComponentQueue        = "queue"
)

var repositoryPattern = regexp.MustCompile(
	`^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_.-]{1,100}$`,
)
var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var uuidPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

var (
	ErrNotFound            = errors.New("not found")
	ErrConflict            = errors.New("conflict")
	ErrRepositoryBusy      = errors.New("repository already has active work")
	ErrStaleRegistration   = errors.New("registration is stale or disabled")
	ErrStoreUnavailable    = errors.New("control store unavailable")
	ErrOperatingMode       = errors.New("operating mode does not permit execution")
	ErrIdempotencyConflict = errors.New("idempotency key was reused for a different request")
	ErrNoChange            = errors.New("registration patch does not change desired state")
)

type RegistrationCommandRejection struct {
	Cause      error
	Reason     string
	RecordedAt time.Time
}

func (rejection *RegistrationCommandRejection) Error() string {
	return rejection.Cause.Error()
}

func (rejection *RegistrationCommandRejection) Unwrap() error {
	return rejection.Cause
}

type Registration struct {
	ID                  string `json:"id"`
	Repository          string `json:"repository"`
	Enabled             bool   `json:"enabled"`
	IssueMonitorEnabled bool   `json:"issueMonitorEnabled"`
	PRMonitorEnabled    bool   `json:"prMonitorEnabled"`
	ExecutionEnabled    bool   `json:"executionEnabled"`
	// Configuration remains an internal, schema-constrained empty object. The
	// Control API never accepts it as command input.
	Configuration json.RawMessage `json:"configuration"`
	Version       int64           `json:"version"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
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
	if !safeRepositoryIdentity(repository) {
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

func safeRepositoryIdentity(repository string) bool {
	if !repositoryPattern.MatchString(repository) {
		return false
	}
	_, name, present := strings.Cut(repository, "/")
	return present && name != "." && name != ".."
}

// ValidRepositoryIdentity exposes the same canonical GitHub owner/name
// contract to process-boundary configuration without duplicating a looser
// regular expression in each binary.
func ValidRepositoryIdentity(repository string) bool {
	return repository == strings.ToLower(strings.TrimSpace(repository)) &&
		safeRepositoryIdentity(repository)
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
		return registration.Enabled
	case ComponentExecution, ComponentQueue:
		return registration.ExecutionEnabled
	default:
		return false
	}
}

type OperatingMode string

const (
	ModeMonitorOnly OperatingMode = "MONITOR_ONLY"
	ModeActive      OperatingMode = "ACTIVE"
	ModeDraining    OperatingMode = "DRAINING"
)

func ParseOperatingMode(raw string) (OperatingMode, error) {
	switch OperatingMode(strings.ToUpper(strings.TrimSpace(raw))) {
	case ModeMonitorOnly:
		return ModeMonitorOnly, nil
	case ModeActive:
		return ModeActive, nil
	case ModeDraining:
		return ModeDraining, nil
	default:
		return "", fmt.Errorf("operating mode must be MONITOR_ONLY, ACTIVE, or DRAINING")
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
	Actual        string     `json:"actual"`
	ObservedAt    *time.Time `json:"observedAt"`
	Freshness     string     `json:"freshness"`
	StaleReason   *string    `json:"staleReason"`
	LastGoodAt    *time.Time `json:"lastGoodAt"`
	LastError     *string    `json:"lastError"`
	RecoveryState string     `json:"recoveryState"`

	// Legacy in-process aliases keep the existing control-plane tests and
	// supervisor helpers source compatible without weakening the API schema.
	State         string     `json:"-"`
	LastHealthyAt *time.Time `json:"-"`
	Stale         bool       `json:"-"`
}

type RegistrationProjection struct {
	Registration                 Registration                   `json:"registration"`
	Mode                         OperatingMode                  `json:"mode"`
	Components                   map[string]ComponentProjection `json:"components"`
	LastPoll                     map[string]*time.Time          `json:"lastPoll"`
	LastDelivery                 *time.Time                     `json:"lastDelivery"`
	QueueDepth                   int64                          `json:"queueDepth"`
	ActiveJobID                  *string                        `json:"activeJobId"`
	ActiveJobState               *string                        `json:"activeJobState"`
	ActiveJobRegistrationVersion *int64                         `json:"activeJobRegistrationVersion"`
	LastJobFailure               *JobFailureProjection          `json:"lastJobFailure"`
	RecentDeliveryFailures       []DeliveryFailureProjection    `json:"recentDeliveryFailures"`
}

type CommandFence struct {
	RegistrationID      string `json:"registrationId"`
	RegistrationVersion int64  `json:"registrationVersion"`
	RouteAttempts       *int   `json:"routeAttempts,omitempty"`
}

type CommandOutcome struct {
	CommandID                      string        `json:"commandId"`
	CommandIdentityDigest          string        `json:"commandIdentityDigest"`
	ResourceIdentity               string        `json:"resourceIdentity"`
	Outcome                        string        `json:"outcome"`
	Reason                         *string       `json:"reason"`
	ObservedFence                  *CommandFence `json:"observedFence"`
	CurrentFence                   *CommandFence `json:"currentFence"`
	ResultVersionOrAttemptIdentity *string       `json:"resultVersionOrAttemptIdentity"`
	Recoverability                 string        `json:"recoverability"`
	RecordedAt                     time.Time     `json:"recordedAt"`
	Cancellable                    bool          `json:"cancellable"`
}

type RegistrationCommandResponse struct {
	Outcome      CommandOutcome `json:"outcome"`
	Registration Registration   `json:"registration"`
}

type RetryCommandResponse struct {
	Outcome CommandOutcome `json:"outcome"`
	Retry   RetryResult    `json:"retry"`
}

type JobFailureProjection struct {
	ID                  string    `json:"id"`
	RegistrationVersion int64     `json:"registrationVersion"`
	JobType             string    `json:"jobType"`
	Status              string    `json:"status"`
	LastError           *string   `json:"lastError"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

type DeliveryFailureProjection struct {
	ID                  string    `json:"id"`
	DeliveryKey         string    `json:"deliveryKey"`
	Event               string    `json:"event"`
	Action              *string   `json:"action"`
	Status              string    `json:"status"`
	IgnoredReason       *string   `json:"ignoredReason"`
	LastError           *string   `json:"lastError"`
	RouteAttempts       int       `json:"routeAttempts"`
	RegistrationVersion *int64    `json:"registrationVersion"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

type WorkItem struct {
	Repository string         `json:"repository"`
	Kind       string         `json:"kind"`
	Number     int64          `json:"number"`
	Identity   string         `json:"identity,omitempty"`
	UpdatedAt  time.Time      `json:"updatedAt"`
	Payload    map[string]any `json:"-"`
}

func (item WorkItem) IdempotencyKey() string {
	if item.Identity != "" {
		key := fmt.Sprintf(
			"github:%s:%s:%s",
			strings.ToLower(item.Repository),
			item.Kind,
			item.Identity,
		)
		if !item.UpdatedAt.IsZero() {
			key += ":" + item.UpdatedAt.UTC().Format(time.RFC3339Nano)
		}
		return key
	}
	return fmt.Sprintf(
		"github:%s:%s:%d:%s",
		strings.ToLower(item.Repository),
		item.Kind,
		item.Number,
		item.UpdatedAt.UTC().Format(time.RFC3339Nano),
	)
}

func (item WorkItem) CanonicalPayload() map[string]any {
	payload := make(map[string]any, len(item.Payload)+5)
	for key, value := range item.Payload {
		payload[key] = value
	}
	payload["repository"] = strings.ToLower(item.Repository)
	payload["entityKind"] = item.Kind
	if item.Number > 0 {
		payload["number"] = item.Number
	}
	if item.Identity != "" {
		payload["identity"] = item.Identity
	}
	if !item.UpdatedAt.IsZero() {
		payload["updatedAt"] = item.UpdatedAt.UTC().Format(time.RFC3339Nano)
	}
	return payload
}

// TriagePayload projects an Issue observation into the only payload accepted
// by the capability-limited triage runner. It intentionally carries no Issue
// body, labels, repository path, command, credential, or mutation request; the
// triage runner re-reads current GitHub state through typed operations.
func (item WorkItem) TriagePayload() (map[string]any, error) {
	canonicalRepository := strings.ToLower(strings.TrimSpace(item.Repository))
	repository := strings.Split(canonicalRepository, "/")
	if len(repository) != 2 || canonicalRepository != item.Repository ||
		!safeRepositoryIdentity(canonicalRepository) {
		return nil, fmt.Errorf("triage work repository must be canonical owner/name")
	}
	if item.Kind != "issue" || item.Number < 1 || item.UpdatedAt.IsZero() {
		return nil, fmt.Errorf("triage work requires a positive Issue observation")
	}
	return map[string]any{
		"schemaVersion": 1,
		"repository": map[string]any{
			"owner": repository[0],
			"name":  repository[1],
		},
		"issue": map[string]any{
			"number":            item.Number,
			"observedUpdatedAt": item.UpdatedAt.UTC().Format(time.RFC3339Nano),
		},
	}, nil
}

// QueuedJob selects the capability boundary from the observed entity kind.
// Every Issue is triaged first. Only the triage runner's explicit ready-label
// promotion can create an agentops.runner development_turn for that Issue.
func (item WorkItem) QueuedJob(sourceKind string) (string, map[string]any, error) {
	if item.Kind == "issue" {
		payload, err := item.TriagePayload()
		return "agentops.triage", payload, err
	}
	payload, err := item.RunnerPayload(sourceKind)
	return "agentops.runner", payload, err
}

// RunnerPayload projects control-plane observations into the only executable
// job contract. It never forwards the webhook body, a command, clone URL,
// credential, host path, or arbitrary environment to the runner.
func (item WorkItem) RunnerPayload(sourceKind string) (map[string]any, error) {
	canonicalRepository := strings.ToLower(strings.TrimSpace(item.Repository))
	repository := strings.Split(canonicalRepository, "/")
	if len(repository) != 2 || canonicalRepository != item.Repository ||
		!safeRepositoryIdentity(canonicalRepository) {
		return nil, fmt.Errorf("runner work repository must be canonical owner/name")
	}
	event := map[string]any{}
	mode := "pr_reconciliation"
	switch item.Kind {
	case "issue":
		if item.Number < 1 {
			return nil, fmt.Errorf("runner issue number must be positive")
		}
		mode = "development_turn"
		event = map[string]any{
			"kind": "issue", "number": item.Number, "action": "recovery",
		}
	case "pull_request":
		if item.Number < 1 {
			return nil, fmt.Errorf("runner pull request number must be positive")
		}
		event = map[string]any{
			"kind": "pull_request", "number": item.Number, "action": "recovery",
		}
	case "push", "check_run", "check_suite":
		identity := item.Identity
		if identity == "" {
			identity = item.IdempotencyKey()
		}
		event = map[string]any{
			"kind": "repository", "trigger": item.Kind, "identity": identity,
		}
		if ref, ok := item.Payload["ref"].(string); ok && ref != "" {
			event["ref"] = ref
		}
		if after, ok := item.Payload["after"].(string); ok && after != "" {
			event["after"] = after
		}
	default:
		return nil, fmt.Errorf("unsupported executable work item kind %q", item.Kind)
	}
	_ = sourceKind // Source identity remains in the outer durable job envelope.
	return map[string]any{
		"schemaVersion": 1,
		"repository": map[string]any{
			"owner": repository[0],
			"name":  repository[1],
		},
		"event": event,
		"target": map[string]any{
			"baseRef": "refs/heads/main",
		},
		"execution": map[string]any{
			"mode":           mode,
			"requiredChecks": []string{},
			"mergeMethod":    "squash",
			"readyLabel":     "ready",
			"claimedLabel":   "agent-claimed",
		},
		"artifacts": []any{},
	}, nil
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
	AttemptID   string    `json:"attemptId"`
	DeliveryID  string    `json:"deliveryId"`
	State       string    `json:"state"`
	Cancellable bool      `json:"cancellable"`
	RecordedAt  time.Time `json:"recordedAt"`
}

type DeliveryStatus struct {
	ID                  string                 `json:"id"`
	DeliveryKey         string                 `json:"deliveryKey"`
	Repository          string                 `json:"repository"`
	Event               string                 `json:"event"`
	Action              *string                `json:"action"`
	Status              string                 `json:"status"`
	IgnoredReason       *string                `json:"ignoredReason"`
	LastError           *string                `json:"lastError"`
	RouteAttempts       int                    `json:"routeAttempts"`
	RegistrationID      *string                `json:"registrationId"`
	RegistrationVersion *int64                 `json:"registrationVersion"`
	ReceivedAt          time.Time              `json:"receivedAt"`
	UpdatedAt           time.Time              `json:"updatedAt"`
	RetryAttempts       []DeliveryRetryAttempt `json:"retryAttempts"`
}

type DeliveryRetryAttempt struct {
	AttemptID             string    `json:"attemptId"`
	Status                string    `json:"status"`
	Reason                *string   `json:"reason"`
	ObservedRouteAttempts int       `json:"observedRouteAttempts"`
	CreatedAt             time.Time `json:"createdAt"`
}

type DeliveryRetryConflict struct {
	Reason              string    `json:"reason"`
	State               string    `json:"state"`
	RouteAttempts       int       `json:"routeAttempts"`
	AttemptID           string    `json:"attemptId"`
	RegistrationID      string    `json:"registrationId"`
	RegistrationVersion int64     `json:"registrationVersion"`
	RecordedAt          time.Time `json:"recordedAt"`
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
