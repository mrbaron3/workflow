package control

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type fakeAPIStore struct {
	webhooks        int
	creates         int
	projections     []RegistrationProjection
	projectionError error
	retryError      error
	updateError     error
	updated         Registration
	deliveryStatus  DeliveryStatus
	deliveryError   error
}

const (
	testRegistrationID = "11111111-1111-4111-8111-111111111111"
	testDeliveryID     = "22222222-2222-4222-8222-222222222222"
)

func (store *fakeAPIStore) Ping(context.Context) error { return nil }

func (store *fakeAPIStore) CreateRegistration(
	_ context.Context,
	input CreateRegistration,
	_, _ string,
) (Registration, bool, error) {
	store.creates++
	validated, err := input.Validated()
	validated.ID = testRegistrationID
	validated.Version = 1
	return validated, false, err
}

func (store *fakeAPIStore) UpdateRegistrationCommand(
	context.Context,
	string,
	int64,
	RegistrationPatch,
	string,
	string,
	string,
) (Registration, bool, error) {
	return store.updated, false, store.updateError
}

func (store *fakeAPIStore) Projections(
	context.Context,
	time.Duration,
) ([]RegistrationProjection, error) {
	return store.projections, store.projectionError
}

func (store *fakeAPIStore) ReceiveWebhook(
	context.Context,
	string,
	string,
	string,
	*string,
	map[string]string,
	map[string]any,
) (WebhookReceipt, error) {
	store.webhooks++
	return WebhookReceipt{DeliveryID: testDeliveryID, Status: "pending"}, nil
}

func (store *fakeAPIStore) RetryWebhook(
	context.Context,
	string,
	string,
	string,
	int,
	string,
	int64,
) (RetryResult, bool, error) {
	return RetryResult{}, false, store.retryError
}

func (store *fakeAPIStore) DeliveryStatus(
	context.Context,
	string,
) (DeliveryStatus, error) {
	return store.deliveryStatus, store.deliveryError
}

func TestControlAPIRequiresAuthorizationAndOptimisticContractHeaders(t *testing.T) {
	store := &fakeAPIStore{}
	handler := testAPI(store).Handler()
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/registrations",
		bytes.NewBufferString(`{"repository":"Owner/Repo"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || store.creates != 0 {
		t.Fatalf("unauthorized create status=%d creates=%d", response.Code, store.creates)
	}

	request = httptest.NewRequest(
		http.MethodPost,
		"/v1/registrations",
		bytes.NewBufferString(`{"repository":"Owner/Repo"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer control-token")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || store.creates != 0 {
		t.Fatalf("missing idempotency status=%d creates=%d", response.Code, store.creates)
	}

	request = httptest.NewRequest(
		http.MethodPost,
		"/v1/registrations",
		bytes.NewBufferString(`{"repository":"Owner/Repo"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer control-token")
	request.Header.Set("Idempotency-Key", "registration-create-1")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || store.creates != 1 {
		t.Fatalf("authorized create status=%d creates=%d body=%s", response.Code, store.creates, response.Body)
	}
	if response.Header().Get("ETag") != `"1"` {
		t.Fatalf("ETag = %q", response.Header().Get("ETag"))
	}
	for _, field := range []string{
		`"resourceIdentity":"` + testRegistrationID + `"`,
		`"resultVersionOrAttemptIdentity":"1"`,
		`"recoverability":"none"`,
	} {
		if !bytes.Contains(response.Body.Bytes(), []byte(field)) {
			t.Fatalf("create outcome missing %s: %s", field, response.Body)
		}
	}
}

func TestWebhookPersistsOnlyAfterValidSignatureAndIdentity(t *testing.T) {
	store := &fakeAPIStore{}
	handler := testAPI(store).Handler()
	payload := []byte(
		`{"action":"opened","repository":{"full_name":"owner/repo"},` +
			`"issue":{"number":1,"updated_at":"2026-07-25T00:00:00Z"}}`,
	)
	request := httptest.NewRequest(http.MethodPost, "/v1/webhooks/github", bytes.NewReader(payload))
	request.Header.Set("X-GitHub-Delivery", "delivery-1")
	request.Header.Set("X-GitHub-Event", "issues")
	request.Header.Set("X-Hub-Signature-256", "sha256=invalid")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || store.webhooks != 0 {
		t.Fatalf("invalid signature status=%d persisted=%d", response.Code, store.webhooks)
	}

	request = httptest.NewRequest(http.MethodPost, "/v1/webhooks/github", bytes.NewReader(payload))
	request.Header.Set("X-GitHub-Delivery", "delivery-1")
	request.Header.Set("X-GitHub-Event", "issues")
	request.Header.Set("X-Hub-Signature-256", sign(payload, "webhook-secret"))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || store.webhooks != 1 {
		t.Fatalf("valid signature status=%d persisted=%d body=%s", response.Code, store.webhooks, response.Body)
	}
	var receipt WebhookReceipt
	if err := json.Unmarshal(response.Body.Bytes(), &receipt); err != nil ||
		receipt.DeliveryID != testDeliveryID {
		t.Fatalf("receipt = %#v error=%v", receipt, err)
	}

	trailing := append(append([]byte(nil), payload...), []byte(` {}`)...)
	request = httptest.NewRequest(http.MethodPost, "/v1/webhooks/github", bytes.NewReader(trailing))
	request.Header.Set("X-GitHub-Delivery", "delivery-trailing")
	request.Header.Set("X-GitHub-Event", "issues")
	request.Header.Set("X-Hub-Signature-256", sign(trailing, "webhook-secret"))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || store.webhooks != 1 {
		t.Fatalf("trailing payload status=%d persisted=%d", response.Code, store.webhooks)
	}
}

func TestExpectedVersionRequiresStrongQuotedVersion(t *testing.T) {
	for _, value := range []string{"1", `W/"1"`, `"0"`, `"invalid"`} {
		t.Run(value, func(t *testing.T) {
			request := httptest.NewRequest(
				http.MethodPatch,
				"/v1/registrations/"+testRegistrationID,
				bytes.NewBufferString(`{"enabled":false}`),
			)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Authorization", "Bearer control-token")
			request.Header.Set("If-Match", value)
			response := httptest.NewRecorder()
			testAPI(&fakeAPIStore{}).Handler().ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("If-Match %q status=%d", value, response.Code)
			}
		})
	}
}

func TestVersionConflictReturnsStructuredCurrentFence(t *testing.T) {
	store := &fakeAPIStore{
		updateError: ErrConflict,
		updated: Registration{
			ID:         testRegistrationID,
			Repository: "owner/repo",
			Version:    4,
		},
	}
	request := httptest.NewRequest(
		http.MethodPatch,
		"/v1/registrations/"+testRegistrationID,
		bytes.NewBufferString(`{"enabled":false}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer control-token")
	request.Header.Set("If-Match", `"3"`)
	request.Header.Set("Idempotency-Key", "update-version-conflict")
	response := httptest.NewRecorder()
	testAPI(store).Handler().ServeHTTP(response, request)
	if response.Code != http.StatusConflict ||
		response.Header().Get("ETag") != `"4"` ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"outcome":"version_conflict"`)) ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"registrationVersion":4`)) {
		t.Fatalf("version conflict = %d headers=%v body=%s", response.Code, response.Header(), response.Body)
	}
}

func TestEmptyRegistrationPatchReturnsStructuredRejection(t *testing.T) {
	request := httptest.NewRequest(
		http.MethodPatch,
		"/v1/registrations/"+testRegistrationID,
		bytes.NewBufferString(`{}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer control-token")
	request.Header.Set("If-Match", `"3"`)
	request.Header.Set("Idempotency-Key", "empty-update")
	response := httptest.NewRecorder()
	testAPI(&fakeAPIStore{}).Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"outcome":"rejected"`)) ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"reason":"invalid_registration_patch"`)) ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"resourceIdentity":"`+testRegistrationID+`"`)) {
		t.Fatalf("empty patch = %d: %s", response.Code, response.Body)
	}
}

func TestStatusQueryFiltersAndFailsClosedWithLastSuccessfulTime(t *testing.T) {
	store := &fakeAPIStore{projections: []RegistrationProjection{
		{Registration: Registration{Repository: "owner/one"}},
		{Registration: Registration{Repository: "owner/two"}},
	}}
	api := testAPI(store)
	request := httptest.NewRequest(
		http.MethodGet,
		"/v1/registrations?repository=OWNER/TWO",
		nil,
	)
	request.Header.Set("Authorization", "Bearer control-token")
	response := httptest.NewRecorder()
	api.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status query = %d: %s", response.Code, response.Body)
	}
	var page struct {
		Items []RegistrationProjection `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Registration.Repository != "owner/two" {
		t.Fatalf("filtered items = %#v", page.Items)
	}

	store.projectionError = ErrStoreUnavailable
	response = httptest.NewRecorder()
	api.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable ||
		response.Header().Get("Retry-After") != "2" ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"lastSuccessfulAt":"`)) {
		t.Fatalf("failed status query = %d headers=%v body=%s", response.Code, response.Header(), response.Body)
	}
}

func TestMonitorOnlyModeDoesNotMaskStaleExecutionEvidence(t *testing.T) {
	store := &fakeAPIStore{projections: []RegistrationProjection{{
		Registration: Registration{
			Repository:       "owner/stale",
			ExecutionEnabled: true,
			Enabled:          true,
		},
		Components: map[string]ComponentProjection{
			ComponentExecution: {
				Desired: true, Actual: "stale", Freshness: "stale",
				RecoveryState: "blocked",
			},
			ComponentQueue: {
				Desired: true, Actual: "failed", Freshness: "fresh",
				RecoveryState: "scheduled",
			},
		},
	}}}
	request := httptest.NewRequest(http.MethodGet, "/v1/registrations", nil)
	request.Header.Set("Authorization", "Bearer control-token")
	response := httptest.NewRecorder()
	testAPI(store).Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"actual":"stale"`)) ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"actual":"failed"`)) {
		t.Fatalf("MONITOR_ONLY masked anomaly = %d: %s", response.Code, response.Body)
	}
}

func TestOpaqueContinuationRemainsBoundToFirstSnapshot(t *testing.T) {
	store := &fakeAPIStore{projections: []RegistrationProjection{
		{Registration: Registration{Repository: "owner/one"}},
		{Registration: Registration{Repository: "owner/two"}},
	}}
	api := testAPI(store)
	request := httptest.NewRequest(http.MethodGet, "/v1/registrations?limit=1", nil)
	request.Header.Set("Authorization", "Bearer control-token")
	response := httptest.NewRecorder()
	api.Handler().ServeHTTP(response, request)
	var first struct {
		Items         []RegistrationProjection `json:"items"`
		NextPageToken string                   `json:"nextPageToken"`
		ObservedAt    time.Time                `json:"observedAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &first); err != nil ||
		len(first.Items) != 1 ||
		first.NextPageToken == "" {
		t.Fatalf("first page = %#v error=%v body=%s", first, err, response.Body)
	}

	store.projections = []RegistrationProjection{
		{Registration: Registration{Repository: "owner/one"}},
		{Registration: Registration{Repository: "owner/replaced"}},
	}
	request = httptest.NewRequest(
		http.MethodGet,
		"/v1/registrations?limit=1&pageToken="+first.NextPageToken,
		nil,
	)
	request.Header.Set("Authorization", "Bearer control-token")
	response = httptest.NewRecorder()
	api.Handler().ServeHTTP(response, request)
	var second struct {
		Items      []RegistrationProjection `json:"items"`
		ObservedAt time.Time                `json:"observedAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &second); err != nil ||
		len(second.Items) != 1 ||
		second.Items[0].Registration.Repository != "owner/two" ||
		!second.ObservedAt.Equal(first.ObservedAt) {
		t.Fatalf("second page escaped snapshot = %#v error=%v body=%s", second, err, response.Body)
	}
}

func TestRetryConflictReturnsCurrentStateAndReason(t *testing.T) {
	store := &fakeAPIStore{retryError: &DeliveryRetryConflict{
		Reason: "delivery_not_retryable", State: "processing", RouteAttempts: 2,
	}}
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/deliveries/"+testDeliveryID+"/retry",
		bytes.NewBufferString(
			`{"observedAttempts":1,"expectedRegistrationId":"`+testRegistrationID+`",`+
				`"expectedRegistrationVersion":1}`,
		),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer control-token")
	request.Header.Set("Idempotency-Key", "retry-1")
	response := httptest.NewRecorder()
	testAPI(store).Handler().ServeHTTP(response, request)
	if response.Code != http.StatusConflict ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"state":"processing"`)) ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"routeAttempts":2`)) {
		t.Fatalf("retry conflict = %d: %s", response.Code, response.Body)
	}
}

func TestDeliveryStatusQueryReturnsCurrentDurableState(t *testing.T) {
	store := &fakeAPIStore{deliveryStatus: DeliveryStatus{
		ID: testDeliveryID, Status: "processed", RouteAttempts: 2,
		RetryAttempts: []DeliveryRetryAttempt{{
			AttemptID: "attempt-1", Status: "accepted",
		}},
	}}
	request := httptest.NewRequest(http.MethodGet, "/v1/deliveries/"+testDeliveryID, nil)
	request.Header.Set("Authorization", "Bearer control-token")
	response := httptest.NewRecorder()
	testAPI(store).Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"status":"processed"`)) ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"attemptId":"attempt-1"`)) {
		t.Fatalf("delivery status = %d: %s", response.Code, response.Body)
	}
}

func testAPI(store APIStore) *API {
	return &API{
		Store:         store,
		ControlToken:  "control-token",
		WebhookSecret: "webhook-secret",
		StaleAfter:    time.Minute,
		RouterWake:    func() {},
		Log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func sign(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}
