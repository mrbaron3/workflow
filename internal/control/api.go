package control

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxWebhookBody     = 10 * 1024 * 1024
	maxJSONCommandBody = 64 * 1024
	maxPageSnapshots   = 1024
)

type APIStore interface {
	Ping(context.Context) error
	CreateRegistration(
		context.Context,
		CreateRegistration,
		string,
		string,
	) (Registration, bool, error)
	UpdateRegistrationCommand(
		context.Context,
		string,
		int64,
		RegistrationPatch,
		string,
		string,
		string,
	) (Registration, bool, error)
	Projections(context.Context, time.Duration) ([]RegistrationProjection, error)
	ReceiveWebhook(
		context.Context,
		string,
		string,
		string,
		*string,
		map[string]string,
		map[string]any,
	) (WebhookReceipt, error)
	RetryWebhook(
		context.Context,
		string,
		string,
		string,
		int,
		string,
		int64,
	) (RetryResult, bool, error)
	DeliveryStatus(context.Context, string) (DeliveryStatus, error)
}

type API struct {
	Store           APIStore
	ControlToken    string
	WebhookSecret   string
	StaleAfter      time.Duration
	Mode            OperatingMode
	CanonicalOrigin string
	BootstrapToken  string
	SessionTTL      time.Duration
	RouterWake      func()
	Log             *slog.Logger
	statusSuccess   atomic.Int64
	initOnce        sync.Once
	initErr         error
	origin          *url.URL
	sessions        *browserSessions
	dashboard       http.Handler
	pagesMu         sync.Mutex
	pages           map[string]registrationPageSnapshot
}

type registrationPageSnapshot struct {
	Items      []RegistrationProjection
	Repository string
	Offset     int
	ObservedAt time.Time
	ExpiresAt  time.Time
}

func (api *API) Initialize() error {
	api.initOnce.Do(func() {
		rawOrigin := api.CanonicalOrigin
		if rawOrigin == "" {
			rawOrigin = "http://127.0.0.1:8080"
		}
		api.origin, api.initErr = validateCanonicalOrigin(rawOrigin)
		if api.initErr != nil {
			return
		}
		if api.BootstrapToken != "" &&
			(len(api.BootstrapToken) < 32 || len(api.BootstrapToken) > 512) {
			api.initErr = fmt.Errorf("dashboard bootstrap token must be 32..512 bytes")
			return
		}
		api.sessions = newBrowserSessions(api.BootstrapToken, api.SessionTTL)
		api.dashboard = dashboardHandler()
		api.pages = make(map[string]registrationPageSnapshot)
	})
	return api.initErr
}

func (api *API) Handler() http.Handler {
	_ = api.Initialize()
	return http.HandlerFunc(api.serveHTTP)
}

func (api *API) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	api.securityHeaders(writer)
	if api.initErr != nil {
		writeError(writer, http.StatusServiceUnavailable, "invalid_server_configuration", "dashboard security boundary is invalid")
		return
	}
	requestContext, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()
	request = request.WithContext(requestContext)
	writer.Header().Set("Cache-Control", "no-store")
	if request.URL.Path == "/healthz" {
		api.health(writer, request)
		return
	}
	if request.URL.Path == "/v1/webhooks/github" {
		api.webhook(writer, request)
		return
	}
	if request.URL.Path == "/dashboard/bootstrap" {
		api.bootstrap(writer, request)
		return
	}
	if request.URL.Path == "/" || strings.HasPrefix(request.URL.Path, "/assets/") {
		if _, ok := api.browserAuthorized(writer, request, false); !ok {
			return
		}
		api.dashboard.ServeHTTP(writer, request)
		return
	}
	if request.URL.Path == "/v1/browser-session" {
		api.browserSession(writer, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, "/v1/") && !api.exactHost(request) {
		writeError(writer, http.StatusForbidden, "invalid_host", "request Host does not match the configured Control API origin")
		return
	}
	actorID, ok := api.authorized(writer, request)
	if !ok {
		return
	}
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/v1/registrations":
		api.listRegistrations(writer, request)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/registrations":
		api.createRegistration(writer, request, actorID)
	case strings.HasPrefix(request.URL.Path, "/v1/registrations/"):
		api.registrationCommand(writer, request, actorID)
	case strings.HasPrefix(request.URL.Path, "/v1/deliveries/"):
		api.deliveryCommand(writer, request, actorID)
	default:
		writeError(writer, http.StatusNotFound, "not_found", "route does not exist")
	}
}

func (api *API) health(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "GET is required")
		return
	}
	if err := api.Store.Ping(request.Context()); err != nil {
		api.Log.Error("health check failed closed", "error", err)
		writeError(writer, http.StatusServiceUnavailable, "control_store_unavailable", "control store is unavailable")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok"})
}

func (api *API) listRegistrations(writer http.ResponseWriter, request *http.Request) {
	repository := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("repository")))
	if repository != "" && !safeRepositoryIdentity(repository) {
		writeError(writer, http.StatusBadRequest, "invalid_repository", "repository must be canonical owner/name")
		return
	}
	projections, err := api.Store.Projections(request.Context(), api.StaleAfter)
	if err != nil {
		if errors.Is(err, ErrStoreUnavailable) {
			api.Log.Error("status projection failed closed", "error", err)
			writer.Header().Set("Retry-After", "2")
			var lastSuccessfulAt *time.Time
			if value := api.statusSuccess.Load(); value > 0 {
				observed := time.Unix(0, value).UTC()
				lastSuccessfulAt = &observed
			}
			writeJSON(writer, http.StatusServiceUnavailable, map[string]any{
				"error": map[string]any{
					"code":              "control_store_unavailable",
					"message":           err.Error(),
					"retryable":         true,
					"retryAfterSeconds": 2,
					"lastSuccessfulAt":  lastSuccessfulAt,
				},
			})
			return
		}
		api.respondError(writer, err)
		return
	}
	mode := api.Mode
	if mode == "" {
		mode = ModeMonitorOnly
	}
	for index := range projections {
		projections[index].Mode = mode
		if mode != ModeMonitorOnly {
			continue
		}
		execution := projections[index].Components[ComponentExecution]
		if execution.Desired &&
			execution.Freshness != "stale" &&
			execution.Actual != "failed" &&
			execution.Actual != "stale" &&
			execution.Actual != "disconnected" {
			now := time.Now().UTC()
			execution.Actual = "paused_by_mode"
			execution.State = execution.Actual
			execution.ObservedAt = &now
			execution.Freshness = "fresh"
			execution.RecoveryState = "blocked"
			execution.Stale = false
			projections[index].Components[ComponentExecution] = execution
		}
		queue := projections[index].Components[ComponentQueue]
		if queue.Desired &&
			queue.Freshness != "stale" &&
			queue.Actual != "failed" &&
			queue.Actual != "stale" &&
			queue.Actual != "disconnected" {
			now := time.Now().UTC()
			queue.Actual = "blocked_by_mode"
			queue.State = queue.Actual
			queue.ObservedAt = &now
			queue.Freshness = "fresh"
			queue.RecoveryState = "blocked"
			queue.Stale = false
			projections[index].Components[ComponentQueue] = queue
		}
	}
	if repository != "" {
		filtered := make([]RegistrationProjection, 0, 1)
		for _, projection := range projections {
			if projection.Registration.Repository == repository {
				filtered = append(filtered, projection)
			}
		}
		projections = filtered
	}
	limit := 50
	if raw := request.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 200 {
			writeError(writer, http.StatusBadRequest, "invalid_limit", "limit must be between 1 and 200")
			return
		}
		limit = parsed
	}
	offset := 0
	observedAt := time.Now().UTC()
	if token := request.URL.Query().Get("pageToken"); token != "" {
		api.pagesMu.Lock()
		snapshot, present := api.pages[token]
		api.pagesMu.Unlock()
		if !present ||
			!snapshot.ExpiresAt.After(time.Now().UTC()) ||
			snapshot.Repository != repository {
			api.Log.Warn("registration continuation rejected", "reason", "invalid_or_expired")
			writeError(writer, http.StatusBadRequest, "invalid_page_token", "pageToken is invalid")
			return
		}
		projections = snapshot.Items
		offset = snapshot.Offset
		observedAt = snapshot.ObservedAt
		if offset < 0 || offset > len(projections) {
			api.Log.Warn("registration continuation rejected", "reason", "invalid_offset")
			writeError(writer, http.StatusBadRequest, "invalid_page_token", "pageToken is invalid")
			return
		}
	}
	end := min(offset+limit, len(projections))
	nextToken := ""
	if end < len(projections) {
		nextToken, err = randomOpaque(24)
		if err != nil {
			api.respondError(writer, err)
			return
		}
		api.pagesMu.Lock()
		now := time.Now().UTC()
		for key, snapshot := range api.pages {
			if !snapshot.ExpiresAt.After(now) {
				delete(api.pages, key)
			}
		}
		if len(api.pages) >= maxPageSnapshots {
			oldestKey := ""
			var oldestExpiry time.Time
			for key, snapshot := range api.pages {
				if oldestKey == "" || snapshot.ExpiresAt.Before(oldestExpiry) {
					oldestKey = key
					oldestExpiry = snapshot.ExpiresAt
				}
			}
			delete(api.pages, oldestKey)
		}
		api.pages[nextToken] = registrationPageSnapshot{
			Items:      projections,
			Repository: repository,
			Offset:     end,
			ObservedAt: observedAt,
			ExpiresAt:  now.Add(2 * time.Minute),
		}
		api.pagesMu.Unlock()
	}
	api.statusSuccess.Store(observedAt.UnixNano())
	writeJSON(writer, http.StatusOK, map[string]any{
		"items":            projections[offset:end],
		"nextPageToken":    nextToken,
		"observedAt":       observedAt,
		"lastSuccessfulAt": observedAt,
		"mode":             mode,
	})
}

func (api *API) createRegistration(
	writer http.ResponseWriter,
	request *http.Request,
	actorID string,
) {
	idempotencyKey, ok := requiredHeader(writer, request, "Idempotency-Key")
	if !ok {
		return
	}
	if !validIdempotencyKey(idempotencyKey) {
		writeError(writer, http.StatusBadRequest, "invalid_idempotency_key", "Idempotency-Key has an invalid format")
		return
	}
	var body struct {
		Repository          string `json:"repository"`
		Enabled             *bool  `json:"enabled,omitempty"`
		IssueMonitorEnabled *bool  `json:"issueMonitorEnabled,omitempty"`
		PRMonitorEnabled    *bool  `json:"prMonitorEnabled,omitempty"`
		ExecutionEnabled    *bool  `json:"executionEnabled,omitempty"`
	}
	if !decodeJSON(writer, request, &body) {
		return
	}
	input := CreateRegistration{
		Repository:          body.Repository,
		Enabled:             body.Enabled,
		IssueMonitorEnabled: body.IssueMonitorEnabled,
		PRMonitorEnabled:    body.PRMonitorEnabled,
		ExecutionEnabled:    body.ExecutionEnabled,
	}
	validated, validationErr := input.Validated()
	if validationErr != nil {
		writeCommandError(
			writer,
			http.StatusBadRequest,
			idempotencyKey,
			"rejected",
			"invalid_registration_input",
			strings.ToLower(strings.TrimSpace(body.Repository)),
			nil,
			nil,
			validationErr,
		)
		return
	}
	input.Repository = validated.Repository
	registration, duplicate, err := api.Store.CreateRegistration(
		request.Context(),
		input,
		idempotencyKey,
		actorID,
	)
	if err != nil {
		switch {
		case errors.Is(err, ErrIdempotencyConflict):
			writeCommandError(
				writer, http.StatusConflict, idempotencyKey, "rejected",
				"idempotency_key_reused", input.Repository, nil, nil, err,
			)
			return
		case errors.Is(err, ErrConflict):
			writeCommandError(
				writer, http.StatusConflict, idempotencyKey, "rejected",
				"repository_already_registered", input.Repository, nil, nil, err,
			)
			return
		case errors.Is(err, ErrStoreUnavailable):
			writeCommandError(
				writer, http.StatusServiceUnavailable, idempotencyKey, "indeterminate",
				"control_store_unavailable", input.Repository, nil, nil, err,
			)
			return
		}
		api.respondError(writer, err)
		return
	}
	status := http.StatusCreated
	if duplicate {
		status = http.StatusOK
		writer.Header().Set("Idempotent-Replay", "true")
	}
	writer.Header().Set("ETag", quotedVersion(registration.Version))
	writeJSON(writer, status, RegistrationCommandResponse{
		Outcome: commandOutcome(
			idempotencyKey,
			map[bool]string{true: "duplicate", false: "applied"}[duplicate],
			nil,
			&CommandFence{RegistrationID: registration.ID, RegistrationVersion: registration.Version},
			&CommandFence{RegistrationID: registration.ID, RegistrationVersion: registration.Version},
			registration.UpdatedAt,
		),
		Registration: registration,
	})
}

func (api *API) registrationCommand(
	writer http.ResponseWriter,
	request *http.Request,
	actorID string,
) {
	parts := splitPath(request.URL.Path)
	if len(parts) < 3 || parts[0] != "v1" || parts[1] != "registrations" {
		writeError(writer, http.StatusNotFound, "not_found", "route does not exist")
		return
	}
	id := parts[2]
	if !uuidPattern.MatchString(id) {
		writeError(writer, http.StatusBadRequest, "invalid_registration_id", "registrationId must be a canonical UUID")
		return
	}
	expectedVersion, ok := expectedVersion(writer, request)
	if !ok {
		return
	}
	idempotencyKey, ok := requiredHeader(writer, request, "Idempotency-Key")
	if !ok {
		return
	}
	if !validIdempotencyKey(idempotencyKey) {
		writeError(writer, http.StatusBadRequest, "invalid_idempotency_key", "Idempotency-Key has an invalid format")
		return
	}
	switch {
	case request.Method == http.MethodPatch && len(parts) == 3:
		var body struct {
			Enabled             *bool `json:"enabled,omitempty"`
			IssueMonitorEnabled *bool `json:"issueMonitorEnabled,omitempty"`
			PRMonitorEnabled    *bool `json:"prMonitorEnabled,omitempty"`
			ExecutionEnabled    *bool `json:"executionEnabled,omitempty"`
		}
		if !decodeJSON(writer, request, &body) {
			return
		}
		patch := RegistrationPatch{
			Enabled:             body.Enabled,
			IssueMonitorEnabled: body.IssueMonitorEnabled,
			PRMonitorEnabled:    body.PRMonitorEnabled,
			ExecutionEnabled:    body.ExecutionEnabled,
		}
		if err := patch.Validate(); err != nil {
			writeCommandError(
				writer,
				http.StatusBadRequest,
				idempotencyKey,
				"rejected",
				"invalid_registration_patch",
				id,
				&CommandFence{
					RegistrationID:      id,
					RegistrationVersion: expectedVersion,
				},
				nil,
				err,
			)
			return
		}
		registration, duplicate, err := api.Store.UpdateRegistrationCommand(
			request.Context(),
			id,
			expectedVersion,
			patch,
			idempotencyKey,
			actorID,
			"registration.updated",
		)
		if err != nil {
			if api.registrationCommandError(
				writer,
				err,
				duplicate,
				registration,
				id,
				expectedVersion,
				idempotencyKey,
			) {
				return
			}
			api.respondError(writer, err)
			return
		}
		if duplicate {
			writer.Header().Set("Idempotent-Replay", "true")
		}
		writer.Header().Set("ETag", quotedVersion(registration.Version))
		writeJSON(writer, http.StatusOK, RegistrationCommandResponse{
			Outcome: commandOutcome(
				idempotencyKey,
				map[bool]string{true: "duplicate", false: "applied"}[duplicate],
				nil,
				&CommandFence{RegistrationID: id, RegistrationVersion: expectedVersion},
				&CommandFence{RegistrationID: registration.ID, RegistrationVersion: registration.Version},
				registration.UpdatedAt,
			),
			Registration: registration,
		})
	case request.Method == http.MethodPost && len(parts) == 4 && parts[3] == "disable":
		var body struct{}
		if !decodeJSON(writer, request, &body) {
			return
		}
		disabled := false
		registration, duplicate, err := api.Store.UpdateRegistrationCommand(
			request.Context(),
			id,
			expectedVersion,
			RegistrationPatch{Enabled: &disabled},
			idempotencyKey,
			actorID,
			"registration.disabled",
		)
		if err != nil {
			if api.registrationCommandError(
				writer,
				err,
				duplicate,
				registration,
				id,
				expectedVersion,
				idempotencyKey,
			) {
				return
			}
			api.respondError(writer, err)
			return
		}
		if duplicate {
			writer.Header().Set("Idempotent-Replay", "true")
		}
		writer.Header().Set("ETag", quotedVersion(registration.Version))
		writeJSON(writer, http.StatusOK, RegistrationCommandResponse{
			Outcome: commandOutcome(
				idempotencyKey,
				map[bool]string{true: "duplicate", false: "applied"}[duplicate],
				nil,
				&CommandFence{RegistrationID: id, RegistrationVersion: expectedVersion},
				&CommandFence{RegistrationID: registration.ID, RegistrationVersion: registration.Version},
				registration.UpdatedAt,
			),
			Registration: registration,
		})
	default:
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "unsupported registration command")
	}
}

func (api *API) deliveryCommand(
	writer http.ResponseWriter,
	request *http.Request,
	actorID string,
) {
	parts := splitPath(request.URL.Path)
	if len(parts) < 3 || parts[0] != "v1" || parts[1] != "deliveries" {
		writeError(writer, http.StatusNotFound, "not_found", "route does not exist")
		return
	}
	if !uuidPattern.MatchString(parts[2]) {
		writeError(writer, http.StatusBadRequest, "invalid_delivery_id", "deliveryId must be a canonical UUID")
		return
	}
	if request.Method == http.MethodGet && len(parts) == 3 {
		status, err := api.Store.DeliveryStatus(request.Context(), parts[2])
		if err != nil {
			api.respondError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, status)
		return
	}
	if request.Method != http.MethodPost || len(parts) != 4 || parts[3] != "retry" {
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "POST retry is required")
		return
	}
	idempotencyKey, ok := requiredHeader(writer, request, "Idempotency-Key")
	if !ok {
		return
	}
	if !validIdempotencyKey(idempotencyKey) {
		writeError(writer, http.StatusBadRequest, "invalid_idempotency_key", "Idempotency-Key has an invalid format")
		return
	}
	var body struct {
		ObservedAttempts            *int   `json:"observedAttempts"`
		ExpectedRegistrationID      string `json:"expectedRegistrationId"`
		ExpectedRegistrationVersion *int64 `json:"expectedRegistrationVersion"`
	}
	if !decodeJSON(writer, request, &body) {
		return
	}
	if body.ObservedAttempts == nil || *body.ObservedAttempts < 0 {
		writeError(
			writer,
			http.StatusBadRequest,
			"invalid_observed_attempts",
			"observedAttempts must be a non-negative integer",
		)
		return
	}
	if body.ExpectedRegistrationID == "" ||
		body.ExpectedRegistrationVersion == nil ||
		*body.ExpectedRegistrationVersion < 1 {
		writeError(
			writer,
			http.StatusBadRequest,
			"invalid_registration_fence",
			"expectedRegistrationId and a positive expectedRegistrationVersion are required",
		)
		return
	}
	result, duplicate, err := api.Store.RetryWebhook(
		request.Context(),
		parts[2],
		idempotencyKey,
		actorID,
		*body.ObservedAttempts,
		body.ExpectedRegistrationID,
		*body.ExpectedRegistrationVersion,
	)
	if err != nil {
		var conflict *DeliveryRetryConflict
		if errors.As(err, &conflict) {
			reason := conflict.Reason
			attempts := conflict.RouteAttempts
			outcomeValue := "rejected"
			if duplicate {
				outcomeValue = "duplicate"
				writer.Header().Set("Idempotent-Replay", "true")
			}
			currentRegistrationID := conflict.RegistrationID
			currentRegistrationVersion := conflict.RegistrationVersion
			if currentRegistrationID == "" || currentRegistrationVersion < 1 {
				currentRegistrationID = body.ExpectedRegistrationID
				currentRegistrationVersion = *body.ExpectedRegistrationVersion
			}
			outcome := commandOutcome(
				idempotencyKey,
				outcomeValue,
				&reason,
				&CommandFence{
					RegistrationID:      body.ExpectedRegistrationID,
					RegistrationVersion: *body.ExpectedRegistrationVersion,
					RouteAttempts:       body.ObservedAttempts,
				},
				&CommandFence{
					RegistrationID:      currentRegistrationID,
					RegistrationVersion: currentRegistrationVersion,
					RouteAttempts:       &attempts,
				},
				conflict.RecordedAt,
			)
			outcome.ResourceIdentity = parts[2]
			if conflict.AttemptID != "" {
				outcome.ResultVersionOrAttemptIdentity = &conflict.AttemptID
			}
			writeJSON(writer, http.StatusConflict, map[string]any{
				"outcome": outcome,
				"error": map[string]any{
					"code":          conflict.Reason,
					"message":       conflict.Error(),
					"state":         conflict.State,
					"routeAttempts": conflict.RouteAttempts,
					"attemptId":     conflict.AttemptID,
				},
			})
			return
		}
		switch {
		case errors.Is(err, ErrIdempotencyConflict):
			writeCommandError(
				writer,
				http.StatusConflict,
				idempotencyKey,
				"rejected",
				"idempotency_key_reused",
				parts[2],
				&CommandFence{
					RegistrationID:      body.ExpectedRegistrationID,
					RegistrationVersion: *body.ExpectedRegistrationVersion,
					RouteAttempts:       body.ObservedAttempts,
				},
				nil,
				err,
			)
			return
		case errors.Is(err, ErrNotFound):
			writeCommandError(
				writer,
				http.StatusNotFound,
				idempotencyKey,
				"rejected",
				"delivery_not_found",
				parts[2],
				&CommandFence{
					RegistrationID:      body.ExpectedRegistrationID,
					RegistrationVersion: *body.ExpectedRegistrationVersion,
					RouteAttempts:       body.ObservedAttempts,
				},
				nil,
				err,
			)
			return
		case errors.Is(err, ErrStoreUnavailable):
			writeCommandError(
				writer,
				http.StatusServiceUnavailable,
				idempotencyKey,
				"indeterminate",
				"control_store_unavailable",
				parts[2],
				&CommandFence{
					RegistrationID:      body.ExpectedRegistrationID,
					RegistrationVersion: *body.ExpectedRegistrationVersion,
					RouteAttempts:       body.ObservedAttempts,
				},
				nil,
				err,
			)
			return
		}
		api.respondError(writer, err)
		return
	}
	if duplicate {
		writer.Header().Set("Idempotent-Replay", "true")
	}
	attempts := *body.ObservedAttempts
	outcome := commandOutcome(
		idempotencyKey,
		map[bool]string{true: "duplicate", false: "applied"}[duplicate],
		nil,
		&CommandFence{
			RegistrationID:      body.ExpectedRegistrationID,
			RegistrationVersion: *body.ExpectedRegistrationVersion,
			RouteAttempts:       &attempts,
		},
		&CommandFence{
			RegistrationID:      body.ExpectedRegistrationID,
			RegistrationVersion: *body.ExpectedRegistrationVersion,
			RouteAttempts:       &attempts,
		},
		result.RecordedAt,
	)
	outcome.ResourceIdentity = parts[2]
	outcome.ResultVersionOrAttemptIdentity = &result.AttemptID
	writeJSON(writer, http.StatusAccepted, RetryCommandResponse{
		Outcome: outcome,
		Retry:   result,
	})
	api.RouterWake()
}

func (api *API) webhook(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "POST is required")
		return
	}
	if api.WebhookSecret == "" {
		writeError(
			writer,
			http.StatusServiceUnavailable,
			"webhook_ingress_disabled",
			"public webhook ingress requires a configured secret",
		)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxWebhookBody))
	if err != nil {
		writeError(writer, http.StatusRequestEntityTooLarge, "payload_too_large", "webhook body is too large")
		return
	}
	signature := request.Header.Get("X-Hub-Signature-256")
	if !validSignature(body, signature, api.WebhookSecret) {
		writeError(writer, http.StatusUnauthorized, "invalid_signature", "GitHub webhook signature is invalid")
		return
	}
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_payload", "webhook body must be a JSON object")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(writer, http.StatusBadRequest, "invalid_payload", "webhook body must contain exactly one JSON value")
		return
	}
	repository, err := webhookRepository(payload)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	deliveryKey, ok := requiredHeader(writer, request, "X-GitHub-Delivery")
	if !ok {
		return
	}
	event, ok := requiredHeader(writer, request, "X-GitHub-Event")
	if !ok {
		return
	}
	headers := make(map[string]string)
	for name, values := range request.Header {
		if len(values) > 0 {
			headers[name] = values[0]
		}
	}
	receipt, err := api.Store.ReceiveWebhook(
		request.Context(),
		deliveryKey,
		repository,
		event,
		actionFromPayload(payload),
		headers,
		payload,
	)
	if err != nil {
		api.respondError(writer, err)
		return
	}
	writeJSON(writer, http.StatusAccepted, receipt)
	api.RouterWake()
}

func (api *API) authorized(
	writer http.ResponseWriter,
	request *http.Request,
) (string, bool) {
	if session, present, expired := api.sessions.get(request); present {
		if !api.exactHost(request) {
			api.logBrowserRejection(request, "invalid_host")
			writeError(writer, http.StatusForbidden, "invalid_host", "request Host does not match the loopback dashboard origin")
			return "", false
		}
		unsafe := request.Method != http.MethodGet && request.Method != http.MethodHead
		if unsafe {
			provided := sha256.Sum256([]byte(request.Header.Get("X-CSRF-Token")))
			expected := sha256.Sum256([]byte(session.CSRF))
			if request.Header.Get("Origin") != api.origin.String() {
				api.logBrowserRejection(request, "invalid_origin")
				writeError(writer, http.StatusForbidden, "invalid_origin", "unsafe browser requests require the exact dashboard Origin")
				return "", false
			}
			if request.Header.Get("Sec-Fetch-Site") != "same-origin" {
				api.logBrowserRejection(request, "invalid_fetch_site")
				writeError(writer, http.StatusForbidden, "invalid_fetch_site", "unsafe browser requests must be same-origin")
				return "", false
			}
			if !hmac.Equal(provided[:], expected[:]) {
				api.logBrowserRejection(request, "invalid_csrf")
				writeError(writer, http.StatusForbidden, "invalid_csrf", "the browser CSRF proof is invalid")
				return "", false
			}
		}
		digest := sha256.Sum256([]byte(session.ID))
		return "browser-session:" + hex.EncodeToString(digest[:8]), true
	} else if expired {
		api.rotateBootstrap("session_expired")
	}
	if request.Header.Get("Origin") != "" {
		api.rejectOperatorAuthorization(writer, request)
		return "", false
	}
	prefix := "Bearer "
	authorization := request.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, prefix) || api.ControlToken == "" {
		api.rejectOperatorAuthorization(writer, request)
		return "", false
	}
	provided := sha256.Sum256([]byte(strings.TrimPrefix(authorization, prefix)))
	expected := sha256.Sum256([]byte(api.ControlToken))
	if !hmac.Equal(provided[:], expected[:]) {
		api.rejectOperatorAuthorization(writer, request)
		return "", false
	}
	return "operator-token", true
}

func (api *API) rejectOperatorAuthorization(
	writer http.ResponseWriter,
	request *http.Request,
) {
	api.Log.Warn(
		"operator authorization rejected",
		"method", request.Method,
		"path", request.URL.Path,
	)
	writeError(writer, http.StatusUnauthorized, "unauthorized", "valid operator authorization is required")
}

func (api *API) securityHeaders(writer http.ResponseWriter) {
	header := writer.Header()
	header.Set("Cache-Control", "no-store")
	header.Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'")
	header.Set("Cross-Origin-Opener-Policy", "same-origin")
	header.Set("Cross-Origin-Resource-Policy", "same-origin")
	header.Set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()")
	header.Set("Referrer-Policy", "no-referrer")
	if api.origin != nil && api.origin.Scheme == "https" {
		header.Set("Strict-Transport-Security", "max-age=31536000")
	}
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
}

func (api *API) exactHost(request *http.Request) bool {
	if api.CanonicalOrigin == "" {
		return true
	}
	return request.Host == api.origin.Host
}

func (api *API) browserAuthorized(
	writer http.ResponseWriter,
	request *http.Request,
	unsafe bool,
) (browserSession, bool) {
	if !api.exactHost(request) {
		api.logBrowserRejection(request, "invalid_host")
		writeError(writer, http.StatusForbidden, "invalid_host", "request Host does not match the loopback dashboard origin")
		return browserSession{}, false
	}
	session, present, expired := api.sessions.get(request)
	if !present {
		if expired {
			api.rotateBootstrap("session_expired")
		}
		api.logBrowserRejection(request, "browser_session_required")
		writeError(writer, http.StatusUnauthorized, "browser_session_required", "an authenticated loopback browser session is required")
		return browserSession{}, false
	}
	if !unsafe {
		return session, true
	}
	if request.Header.Get("Origin") != api.origin.String() {
		api.logBrowserRejection(request, "invalid_origin")
		writeError(writer, http.StatusForbidden, "invalid_origin", "unsafe browser requests require the exact dashboard Origin")
		return browserSession{}, false
	}
	if request.Header.Get("Sec-Fetch-Site") != "same-origin" {
		api.logBrowserRejection(request, "invalid_fetch_site")
		writeError(writer, http.StatusForbidden, "invalid_fetch_site", "unsafe browser requests must be same-origin")
		return browserSession{}, false
	}
	provided := sha256.Sum256([]byte(request.Header.Get("X-CSRF-Token")))
	expected := sha256.Sum256([]byte(session.CSRF))
	if !hmac.Equal(provided[:], expected[:]) {
		api.logBrowserRejection(request, "invalid_csrf")
		writeError(writer, http.StatusForbidden, "invalid_csrf", "the browser CSRF proof is invalid")
		return browserSession{}, false
	}
	return session, true
}

func (api *API) logBrowserRejection(request *http.Request, reason string) {
	api.Log.Warn(
		"browser operator boundary rejected request",
		"method", request.Method,
		"path", request.URL.Path,
		"reason", reason,
	)
}

func (api *API) bootstrap(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "GET is required")
		return
	}
	if !api.exactHost(request) || !requestIsLoopback(request) {
		writeError(writer, http.StatusForbidden, "loopback_required", "bootstrap is available only through the exact loopback dashboard origin")
		return
	}
	token := request.URL.Query().Get("token")
	if token == "" || len(token) > 512 || api.BootstrapToken == "" {
		writeError(writer, http.StatusUnauthorized, "invalid_bootstrap", "bootstrap token is invalid or unavailable")
		return
	}
	session, err := api.sessions.bootstrap(token)
	if err != nil {
		writeError(writer, http.StatusUnauthorized, "invalid_bootstrap", err.Error())
		return
	}
	setSessionCookie(writer, api.origin, session)
	writer.Header().Set("Location", "/")
	writer.WriteHeader(http.StatusSeeOther)
}

func (api *API) browserSession(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		session, ok := api.browserAuthorized(writer, request, false)
		if !ok {
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{
			"authenticated": true,
			"csrfToken":     session.CSRF,
			"expiresAt":     session.ExpiresAt,
			"origin":        api.origin.String(),
		})
	case http.MethodDelete:
		session, ok := api.browserAuthorized(writer, request, true)
		if !ok {
			return
		}
		api.sessions.delete(session.ID)
		api.rotateBootstrap("operator_logout")
		expireSessionCookie(writer, api.origin)
		writeJSON(writer, http.StatusOK, map[string]any{"signedOut": true})
	default:
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "GET or DELETE is required")
	}
}

func (api *API) rotateBootstrap(reason string) {
	token, err := api.sessions.rotateBootstrap()
	if err != nil {
		api.Log.Error("dashboard bootstrap rotation failed", "reason", reason, "error", err)
		return
	}
	api.Log.Info(
		"new one-time dashboard bootstrap generated",
		"reason", reason,
		"dashboardBootstrapUrl",
		api.origin.String()+"/dashboard/bootstrap?token="+url.QueryEscape(token),
	)
}

func commandOutcome(
	key, outcome string,
	reason *string,
	observed, current *CommandFence,
	recordedAt time.Time,
) CommandOutcome {
	if recordedAt.IsZero() {
		recordedAt = time.Now().UTC()
	}
	digest := sha256.Sum256([]byte(key))
	commandID := hex.EncodeToString(digest[:16])
	resourceIdentity := ""
	var resultIdentity *string
	if observed != nil {
		resourceIdentity = observed.RegistrationID
	}
	if current != nil {
		resourceIdentity = current.RegistrationID
		value := strconv.FormatInt(current.RegistrationVersion, 10)
		resultIdentity = &value
	}
	recoverability := "none"
	switch outcome {
	case "version_conflict":
		recoverability = "refresh_and_retry_with_current_version"
	case "rejected":
		recoverability = "correct_request_or_refresh_authoritative_state"
	case "indeterminate":
		recoverability = "query_authoritative_state_or_retry_same_identity"
	}
	return CommandOutcome{
		CommandID:                      commandID,
		CommandIdentityDigest:          "sha256:" + hex.EncodeToString(digest[:]),
		ResourceIdentity:               resourceIdentity,
		Outcome:                        outcome,
		Reason:                         reason,
		ObservedFence:                  observed,
		CurrentFence:                   current,
		ResultVersionOrAttemptIdentity: resultIdentity,
		Recoverability:                 recoverability,
		RecordedAt:                     recordedAt,
		Cancellable:                    false,
	}
}

func (api *API) registrationCommandError(
	writer http.ResponseWriter,
	err error,
	duplicate bool,
	current Registration,
	registrationID string,
	expectedVersion int64,
	idempotencyKey string,
) bool {
	outcome := ""
	reason := ""
	status := http.StatusConflict
	switch {
	case errors.Is(err, ErrConflict):
		outcome = "version_conflict"
		reason = "registration_version_mismatch"
	case errors.Is(err, ErrNotFound):
		outcome = "rejected"
		reason = "registration_not_found"
		status = http.StatusNotFound
	case errors.Is(err, ErrIdempotencyConflict):
		outcome = "rejected"
		reason = "idempotency_key_reused"
	case errors.Is(err, ErrNoChange):
		outcome = "rejected"
		reason = "registration_patch_has_no_change"
		status = http.StatusBadRequest
	case errors.Is(err, ErrStoreUnavailable):
		outcome = "indeterminate"
		reason = "control_store_unavailable"
		status = http.StatusServiceUnavailable
	default:
		return false
	}
	var currentFence *CommandFence
	if current.ID != "" {
		currentFence = &CommandFence{
			RegistrationID:      current.ID,
			RegistrationVersion: current.Version,
		}
		writer.Header().Set("ETag", quotedVersion(current.Version))
	}
	recordedAt := time.Now().UTC()
	var rejection *RegistrationCommandRejection
	if errors.As(err, &rejection) {
		recordedAt = rejection.RecordedAt
	}
	if duplicate {
		writer.Header().Set("Idempotent-Replay", "true")
	}
	writeJSON(writer, status, map[string]any{
		"outcome": commandOutcome(
			idempotencyKey,
			outcome,
			&reason,
			&CommandFence{
				RegistrationID:      registrationID,
				RegistrationVersion: expectedVersion,
			},
			currentFence,
			recordedAt,
		),
		"error": map[string]any{
			"code":    reason,
			"message": err.Error(),
		},
	})
	return true
}

func writeCommandError(
	writer http.ResponseWriter,
	status int,
	idempotencyKey, outcomeValue, reason, resourceIdentity string,
	observed, current *CommandFence,
	err error,
) {
	outcome := commandOutcome(
		idempotencyKey,
		outcomeValue,
		&reason,
		observed,
		current,
		time.Now().UTC(),
	)
	outcome.ResourceIdentity = resourceIdentity
	writeJSON(writer, status, map[string]any{
		"outcome": outcome,
		"error": map[string]any{
			"code":    reason,
			"message": err.Error(),
		},
	})
}

func validIdempotencyKey(value string) bool {
	return idempotencyKeyPattern.MatchString(value)
}

func (api *API) respondError(writer http.ResponseWriter, err error) {
	var retryConflict *DeliveryRetryConflict
	switch {
	case errors.As(err, &retryConflict):
		writeJSON(writer, http.StatusConflict, map[string]any{
			"error": map[string]any{
				"code":          retryConflict.Reason,
				"message":       retryConflict.Error(),
				"state":         retryConflict.State,
				"routeAttempts": retryConflict.RouteAttempts,
				"attemptId":     retryConflict.AttemptID,
			},
		})
	case errors.Is(err, ErrNotFound):
		writeError(writer, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, ErrIdempotencyConflict):
		writeError(writer, http.StatusConflict, "idempotency_conflict", err.Error())
	case errors.Is(err, ErrStaleRegistration):
		writeError(writer, http.StatusConflict, "stale_registration", err.Error())
	case errors.Is(err, ErrConflict):
		writeError(writer, http.StatusConflict, "conflict", err.Error())
	case errors.Is(err, ErrStoreUnavailable):
		api.Log.Error("control store request failed closed", "error", err)
		writeError(writer, http.StatusServiceUnavailable, "control_store_unavailable", err.Error())
	default:
		writeError(writer, http.StatusBadRequest, "invalid_request", err.Error())
	}
}

func decodeJSON(writer http.ResponseWriter, request *http.Request, destination any) bool {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(writer, http.StatusUnsupportedMediaType, "unsupported_media_type", "application/json is required")
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, maxJSONCommandBody))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(destination); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_json", err.Error())
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(writer, http.StatusBadRequest, "invalid_json", "body must contain exactly one JSON value")
		return false
	}
	return true
}

func expectedVersion(writer http.ResponseWriter, request *http.Request) (int64, bool) {
	header, ok := requiredHeader(writer, request, "If-Match")
	if !ok {
		return 0, false
	}
	if len(header) < 3 || header[0] != '"' || header[len(header)-1] != '"' {
		writeError(writer, http.StatusBadRequest, "invalid_if_match", "If-Match must be a quoted positive Registration version")
		return 0, false
	}
	raw := header[1 : len(header)-1]
	version, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || version < 1 {
		writeError(writer, http.StatusBadRequest, "invalid_if_match", "If-Match must be a quoted positive Registration version")
		return 0, false
	}
	return version, true
}

func requiredHeader(writer http.ResponseWriter, request *http.Request, name string) (string, bool) {
	value := strings.TrimSpace(request.Header.Get(name))
	if value == "" {
		writeError(
			writer,
			http.StatusBadRequest,
			"missing_header",
			fmt.Sprintf("%s is required", name),
		)
		return "", false
	}
	if len(value) > 512 {
		writeError(writer, http.StatusBadRequest, "invalid_header", name+" is too long")
		return "", false
	}
	return value, true
}

func validSignature(body []byte, signature, secret string) bool {
	const prefix = "sha256="
	if !strings.HasPrefix(signature, prefix) {
		return false
	}
	provided, err := hex.DecodeString(strings.TrimPrefix(signature, prefix))
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return hmac.Equal(provided, mac.Sum(nil))
}

func splitPath(path string) []string {
	return strings.Split(strings.Trim(path, "/"), "/")
}

func quotedVersion(version int64) string {
	return fmt.Sprintf(`"%d"`, version)
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, code, message string) {
	writeJSON(writer, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
