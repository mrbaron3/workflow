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
	deliveryStatus  DeliveryStatus
	deliveryError   error
}

func (store *fakeAPIStore) Ping(context.Context) error { return nil }

func (store *fakeAPIStore) CreateRegistration(
	_ context.Context,
	input CreateRegistration,
	_, _ string,
) (Registration, bool, error) {
	store.creates++
	validated, err := input.Validated()
	validated.ID = "registration-1"
	validated.Version = 1
	return validated, false, err
}

func (store *fakeAPIStore) UpdateRegistration(
	context.Context,
	string,
	int64,
	RegistrationPatch,
	string,
	string,
) (Registration, error) {
	return Registration{}, nil
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
	return WebhookReceipt{DeliveryID: "delivery-1", Status: "pending"}, nil
}

func (store *fakeAPIStore) RetryWebhook(
	context.Context,
	string,
	string,
	string,
	int,
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
		receipt.DeliveryID != "delivery-1" {
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
				"/v1/registrations/registration-1",
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

func TestRetryConflictReturnsCurrentStateAndReason(t *testing.T) {
	store := &fakeAPIStore{retryError: &DeliveryRetryConflict{
		Reason: "delivery_not_retryable", State: "processing", RouteAttempts: 2,
	}}
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/deliveries/delivery-1/retry",
		bytes.NewBufferString(`{"observedAttempts":1}`),
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
		ID: "delivery-1", Status: "processed", RouteAttempts: 2,
		RetryAttempts: []DeliveryRetryAttempt{{
			AttemptID: "attempt-1", Status: "accepted",
		}},
	}}
	request := httptest.NewRequest(http.MethodGet, "/v1/deliveries/delivery-1", nil)
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
