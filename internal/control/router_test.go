package control

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeRouterStore struct {
	registration Registration
	lookupError  error
	finished     []string
	enqueued     []WorkItem
	bindError    error
	enqueueError error
}

func (store *fakeRouterStore) ClaimWebhook(context.Context, time.Duration) (*ClaimedDelivery, error) {
	return nil, nil
}

func (store *fakeRouterStore) RegistrationByRepository(
	context.Context,
	string,
) (Registration, error) {
	return store.registration, store.lookupError
}

func (store *fakeRouterStore) BindWebhook(
	context.Context,
	ClaimedDelivery,
	Registration,
) error {
	return store.bindError
}

func (store *fakeRouterStore) EnqueueWork(
	_ context.Context,
	_ Registration,
	_, _ string,
	item WorkItem,
) (string, bool, error) {
	store.enqueued = append(store.enqueued, item)
	return "job-1", false, store.enqueueError
}

func (store *fakeRouterStore) FinishWebhook(
	_ context.Context,
	_ ClaimedDelivery,
	status, reason string,
) error {
	store.finished = append(store.finished, status+":"+reason)
	return nil
}

func (store *fakeRouterStore) RecoverInterruptedWebhooks(context.Context) (int64, error) {
	return 0, nil
}

func TestRouterFailsClosedForUnknownDisabledAndStaleRegistration(t *testing.T) {
	base := ClaimedDelivery{
		ID: "delivery-1", Repository: "owner/repo", Event: "issues",
		Payload: issuePayload(1, "2026-07-25T00:00:00Z"),
	}
	tests := []struct {
		name         string
		store        fakeRouterStore
		claim        ClaimedDelivery
		wantFinished string
	}{
		{
			name:         "unregistered",
			store:        fakeRouterStore{lookupError: ErrNotFound},
			claim:        base,
			wantFinished: "ignored:unregistered_repository",
		},
		{
			name: "disabled",
			store: fakeRouterStore{registration: Registration{
				ID: "registration-1", Repository: "owner/repo", Version: 1,
			}},
			claim:        base,
			wantFinished: "ignored:disabled_repository",
		},
		{
			name: "stale",
			store: fakeRouterStore{registration: Registration{
				ID: "registration-1", Repository: "owner/repo", Enabled: true,
				IssueMonitorEnabled: true, ExecutionEnabled: true, Version: 2,
			}},
			claim: func() ClaimedDelivery {
				claim := base
				version := int64(1)
				claim.RegistrationVersion = &version
				return claim
			}(),
			wantFinished: "ignored:stale_registration_version",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := Router{Store: &test.store}
			if err := router.route(context.Background(), test.claim); err != nil {
				t.Fatal(err)
			}
			if len(test.store.enqueued) != 0 {
				t.Fatal("fail-closed delivery created a job")
			}
			if len(test.store.finished) != 1 || test.store.finished[0] != test.wantFinished {
				t.Fatalf("finished = %#v", test.store.finished)
			}
		})
	}
}

func TestWebhookAndPollUseSameJobIdentity(t *testing.T) {
	claim := ClaimedDelivery{
		ID: "delivery-1", DeliveryKey: "github-delivery",
		Repository: "owner/repo", Event: "pull_request",
		Payload: map[string]any{
			"pull_request": map[string]any{
				"number":     42.0,
				"updated_at": "2026-07-25T00:00:00Z",
			},
		},
	}
	webhook, ok := workItemFromWebhook(claim)
	if !ok {
		t.Fatal("workItemFromWebhook() rejected valid PR")
	}
	poll := WorkItem{
		Repository: "owner/repo", Kind: "pull_request", Number: 42,
		UpdatedAt: time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC),
	}
	if webhook.IdempotencyKey() != poll.IdempotencyKey() {
		t.Fatalf("webhook key %q != poll key %q", webhook.IdempotencyKey(), poll.IdempotencyKey())
	}
	if !jsonEqual(webhook.CanonicalPayload(), poll.CanonicalPayload()) {
		t.Fatal("webhook and poll payloads did not converge")
	}
}

func TestRouterLeavesFailedWorkForDurableRetry(t *testing.T) {
	store := &fakeRouterStore{
		registration: Registration{
			ID: "registration-1", Repository: "owner/repo", Enabled: true,
			IssueMonitorEnabled: true, ExecutionEnabled: true, Version: 1,
		},
		enqueueError: errors.New("single-flight busy"),
	}
	router := Router{Store: store}
	claim := ClaimedDelivery{
		ID: "delivery-1", DeliveryKey: "delivery-key", Token: "token",
		Repository: "owner/repo", Event: "issues",
		Payload: issuePayload(1, "2026-07-25T00:00:00Z"),
	}
	if err := router.route(context.Background(), claim); err == nil {
		t.Fatal("route() unexpectedly hid enqueue error")
	}
}

func issuePayload(number float64, updatedAt string) map[string]any {
	return map[string]any{
		"issue": map[string]any{"number": number, "updated_at": updatedAt},
	}
}
