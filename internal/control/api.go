package control

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const maxRequestBody = 10 * 1024 * 1024

type APIStore interface {
	Ping(context.Context) error
	CreateRegistration(
		context.Context,
		CreateRegistration,
		string,
		string,
	) (Registration, bool, error)
	UpdateRegistration(
		context.Context,
		string,
		int64,
		RegistrationPatch,
		string,
		string,
	) (Registration, error)
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
	) (RetryResult, bool, error)
	DeliveryStatus(context.Context, string) (DeliveryStatus, error)
}

type API struct {
	Store         APIStore
	ControlToken  string
	WebhookSecret string
	StaleAfter    time.Duration
	RouterWake    func()
	Log           *slog.Logger
	statusSuccess atomic.Int64
}

func (api *API) Handler() http.Handler {
	return http.HandlerFunc(api.serveHTTP)
}

func (api *API) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	requestContext, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()
	request = request.WithContext(requestContext)
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	if request.URL.Path == "/healthz" {
		api.health(writer, request)
		return
	}
	if request.URL.Path == "/v1/webhooks/github" {
		api.webhook(writer, request)
		return
	}
	if !api.authorized(request) {
		writeError(writer, http.StatusUnauthorized, "unauthorized", "valid operator authorization is required")
		return
	}
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/v1/registrations":
		api.listRegistrations(writer, request)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/registrations":
		api.createRegistration(writer, request)
	case strings.HasPrefix(request.URL.Path, "/v1/registrations/"):
		api.registrationCommand(writer, request)
	case strings.HasPrefix(request.URL.Path, "/v1/deliveries/"):
		api.deliveryCommand(writer, request)
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
	if repository != "" && !repositoryPattern.MatchString(repository) {
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
	if token := request.URL.Query().Get("pageToken"); token != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_page_token", "pageToken is invalid")
			return
		}
		offset, err = strconv.Atoi(string(decoded))
		if err != nil || offset < 0 || offset > len(projections) {
			writeError(writer, http.StatusBadRequest, "invalid_page_token", "pageToken is invalid")
			return
		}
	}
	end := min(offset+limit, len(projections))
	nextToken := ""
	if end < len(projections) {
		nextToken = base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(end)))
	}
	observedAt := time.Now().UTC()
	api.statusSuccess.Store(observedAt.UnixNano())
	writeJSON(writer, http.StatusOK, map[string]any{
		"items":         projections[offset:end],
		"nextPageToken": nextToken,
		"observedAt":    observedAt,
	})
}

func (api *API) createRegistration(writer http.ResponseWriter, request *http.Request) {
	idempotencyKey, ok := requiredHeader(writer, request, "Idempotency-Key")
	if !ok {
		return
	}
	var input CreateRegistration
	if !decodeJSON(writer, request, &input) {
		return
	}
	registration, duplicate, err := api.Store.CreateRegistration(
		request.Context(),
		input,
		idempotencyKey,
		"operator",
	)
	if err != nil {
		api.respondError(writer, err)
		return
	}
	status := http.StatusCreated
	if duplicate {
		status = http.StatusOK
		writer.Header().Set("Idempotent-Replay", "true")
	}
	writer.Header().Set("ETag", quotedVersion(registration.Version))
	writeJSON(writer, status, registration)
}

func (api *API) registrationCommand(writer http.ResponseWriter, request *http.Request) {
	parts := splitPath(request.URL.Path)
	if len(parts) < 3 || parts[0] != "v1" || parts[1] != "registrations" {
		writeError(writer, http.StatusNotFound, "not_found", "route does not exist")
		return
	}
	id := parts[2]
	expectedVersion, ok := expectedVersion(writer, request)
	if !ok {
		return
	}
	switch {
	case request.Method == http.MethodPatch && len(parts) == 3:
		var patch RegistrationPatch
		if !decodeJSON(writer, request, &patch) {
			return
		}
		registration, err := api.Store.UpdateRegistration(
			request.Context(),
			id,
			expectedVersion,
			patch,
			"operator",
			"registration.updated",
		)
		if err != nil {
			api.respondError(writer, err)
			return
		}
		writer.Header().Set("ETag", quotedVersion(registration.Version))
		writeJSON(writer, http.StatusOK, registration)
	case request.Method == http.MethodPost && len(parts) == 4 && parts[3] == "disable":
		disabled := false
		registration, err := api.Store.UpdateRegistration(
			request.Context(),
			id,
			expectedVersion,
			RegistrationPatch{Enabled: &disabled},
			"operator",
			"registration.disabled",
		)
		if err != nil {
			api.respondError(writer, err)
			return
		}
		writer.Header().Set("ETag", quotedVersion(registration.Version))
		writeJSON(writer, http.StatusOK, map[string]any{
			"registration": registration,
			"cancellable":  false,
		})
	default:
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "unsupported registration command")
	}
}

func (api *API) deliveryCommand(writer http.ResponseWriter, request *http.Request) {
	parts := splitPath(request.URL.Path)
	if len(parts) < 3 || parts[0] != "v1" || parts[1] != "deliveries" {
		writeError(writer, http.StatusNotFound, "not_found", "route does not exist")
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
	var body struct {
		ObservedAttempts *int `json:"observedAttempts"`
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
	result, duplicate, err := api.Store.RetryWebhook(
		request.Context(),
		parts[2],
		idempotencyKey,
		"operator",
		*body.ObservedAttempts,
	)
	if err != nil {
		api.respondError(writer, err)
		return
	}
	if duplicate {
		writer.Header().Set("Idempotent-Replay", "true")
	}
	writeJSON(writer, http.StatusAccepted, result)
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
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxRequestBody))
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

func (api *API) authorized(request *http.Request) bool {
	prefix := "Bearer "
	authorization := request.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, prefix) || api.ControlToken == "" {
		return false
	}
	provided := sha256.Sum256([]byte(strings.TrimPrefix(authorization, prefix)))
	expected := sha256.Sum256([]byte(api.ControlToken))
	return hmac.Equal(provided[:], expected[:])
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
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, maxRequestBody))
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
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, code, message string) {
	writeJSON(writer, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
