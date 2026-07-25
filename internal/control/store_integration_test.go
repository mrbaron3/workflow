package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresRegistrationControlIntegration(t *testing.T) {
	databaseURL := os.Getenv("AGENTOPS_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AGENTOPS_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	resetAndMigrate(t, ctx, pool, root)
	store, err := OpenStore(ctx, databaseURL, root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	created, duplicate, err := store.CreateRegistration(
		ctx,
		CreateRegistration{Repository: "Owner/Repo"},
		"create-registration",
		"operator",
	)
	if err != nil || duplicate {
		t.Fatalf("CreateRegistration() = %#v, %v, %v", created, duplicate, err)
	}
	replayed, duplicate, err := store.CreateRegistration(
		ctx,
		CreateRegistration{Repository: "Owner/Repo"},
		"create-registration",
		"operator",
	)
	if err != nil || !duplicate || replayed.ID != created.ID {
		t.Fatalf("idempotent replay = %#v, %v, %v", replayed, duplicate, err)
	}
	if _, _, err := store.CreateRegistration(
		ctx,
		CreateRegistration{Repository: "owner/other"},
		"create-registration",
		"operator",
	); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("idempotency conflict error = %v", err)
	}
	if key := advisoryRequestKey("a:b", "c"); key == advisoryRequestKey("a", "b:c") {
		t.Fatal("advisory request key framing is ambiguous")
	}
	configured, err := store.UpdateRegistration(
		ctx,
		created.ID,
		created.Version,
		RegistrationPatch{Configuration: json.RawMessage(`{}`)},
		"operator",
		"registration.updated",
	)
	if err != nil || configured.Version != created.Version+1 {
		t.Fatalf("configuration update = %#v, %v", configured, err)
	}
	created = configured
	if err := store.UpsertActualState(
		ctx,
		created,
		ComponentIssueMonitor,
		"running",
		"current-supervisor",
		nil,
	); err != nil {
		t.Fatal(err)
	}
	staleRegistration := created
	staleRegistration.Version--
	if err := store.UpsertActualState(
		ctx,
		staleRegistration,
		ComponentIssueMonitor,
		"stopped",
		"stale-supervisor",
		nil,
	); err != nil {
		t.Fatal(err)
	}
	var actualVersion int64
	var actualState string
	if err := store.pool.QueryRow(ctx,
		`SELECT registration_version, state
		   FROM agentops_control.monitor_actual_states
		  WHERE registration_id = $1 AND component = $2`,
		created.ID,
		ComponentIssueMonitor,
	).Scan(&actualVersion, &actualState); err != nil {
		t.Fatal(err)
	}
	if actualVersion != created.Version || actualState != "running" {
		t.Fatalf("stale actual state overwrote current version: version=%d state=%s", actualVersion, actualState)
	}

	issueItem := WorkItem{
		Repository: created.Repository,
		Kind:       "issue",
		Number:     13,
		UpdatedAt:  time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC),
	}
	jobID, duplicate, err := store.EnqueueWork(
		ctx,
		created,
		"webhook",
		"delivery-source",
		issueItem,
	)
	if err != nil || duplicate {
		t.Fatalf("EnqueueWork() = %s, %v, %v", jobID, duplicate, err)
	}
	pollJobID, duplicate, err := store.EnqueueWork(
		ctx,
		created,
		"poll",
		issueItem.IdempotencyKey(),
		issueItem,
	)
	if err != nil || !duplicate || pollJobID != jobID {
		t.Fatalf("webhook/poll convergence = %s, %v, %v", pollJobID, duplicate, err)
	}
	otherItem := issueItem
	otherItem.Number = 14
	if _, _, err := store.EnqueueWork(
		ctx,
		created,
		"poll",
		otherItem.IdempotencyKey(),
		otherItem,
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("single-flight error = %v", err)
	}

	payload := map[string]any{
		"action":     "opened",
		"repository": map[string]any{"full_name": created.Repository},
		"issue": map[string]any{
			"number":     13,
			"updated_at": "2026-07-25T00:00:00Z",
		},
	}
	receipt, err := store.ReceiveWebhook(
		ctx,
		"github-delivery-1",
		created.Repository,
		"issues",
		stringPointer("opened"),
		map[string]string{
			"Authorization":       "Bearer secret",
			"X-GitHub-Delivery":   "github-delivery-1",
			"X-Hub-Signature-256": "sha256=secret",
		},
		payload,
	)
	if err != nil {
		t.Fatal(err)
	}
	replayedReceipt, err := store.ReceiveWebhook(
		ctx,
		"github-delivery-1",
		created.Repository,
		"issues",
		stringPointer("opened"),
		map[string]string{},
		payload,
	)
	if err != nil || !replayedReceipt.Duplicate || replayedReceipt.DeliveryID != receipt.DeliveryID {
		t.Fatalf("delivery replay = %#v, %v", replayedReceipt, err)
	}
	conflictingPayload := map[string]any{
		"repository": map[string]any{"full_name": created.Repository},
		"issue":      map[string]any{"number": 99},
	}
	if _, err := store.ReceiveWebhook(
		ctx,
		"github-delivery-1",
		created.Repository,
		"issues",
		nil,
		map[string]string{},
		conflictingPayload,
	); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("delivery conflict error = %v", err)
	}
	var storedHeaders map[string]string
	if err := store.pool.QueryRow(ctx,
		`SELECT headers FROM agentops_control.webhook_deliveries WHERE id = $1`,
		receipt.DeliveryID,
	).Scan(&storedHeaders); err != nil {
		t.Fatal(err)
	}
	if len(storedHeaders) != 1 || storedHeaders["x-github-delivery"] != "github-delivery-1" {
		t.Fatalf("durable headers = %#v", storedHeaders)
	}

	unknownReceipt, err := store.ReceiveWebhook(
		ctx,
		"unknown-delivery",
		"unknown/repository",
		"issues",
		nil,
		map[string]string{},
		map[string]any{
			"repository": map[string]any{"full_name": "unknown/repository"},
			"issue": map[string]any{
				"number":     1,
				"updated_at": "2026-07-25T00:00:00Z",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimWebhook(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if claim == nil {
		t.Fatal("expected a pending delivery")
	}
	// The first claim can be the registered delivery. Process claims until the unknown one is ignored.
	router := &Router{Store: store}
	for claim != nil {
		if err := router.route(ctx, *claim); err != nil {
			_ = store.FinishWebhook(ctx, *claim, "failed", err.Error())
		}
		claim, err = store.ClaimWebhook(ctx, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
	}
	var unknownStatus, ignoredReason string
	if err := store.pool.QueryRow(ctx,
		`SELECT status, ignored_reason
		   FROM agentops_control.webhook_deliveries
		  WHERE id = $1`,
		unknownReceipt.DeliveryID,
	).Scan(&unknownStatus, &ignoredReason); err != nil {
		t.Fatal(err)
	}
	if unknownStatus != "ignored" || ignoredReason != "unregistered_repository" {
		t.Fatalf("unknown delivery status=%s reason=%s", unknownStatus, ignoredReason)
	}

	failedReceipt, err := store.ReceiveWebhook(
		ctx,
		"failed-delivery",
		created.Repository,
		"issues",
		nil,
		map[string]string{},
		payload,
	)
	if err != nil {
		t.Fatal(err)
	}
	failedClaim, err := store.ClaimWebhook(ctx, time.Minute)
	if err != nil || failedClaim == nil {
		t.Fatalf("ClaimWebhook() = %#v, %v", failedClaim, err)
	}
	if err := store.BindWebhook(ctx, *failedClaim, created); err != nil {
		t.Fatal(err)
	}
	if err := store.FinishWebhook(ctx, *failedClaim, "failed", "transient"); err != nil {
		t.Fatal(err)
	}
	retry, replay, err := store.RetryWebhook(
		ctx,
		failedReceipt.DeliveryID,
		"retry-key",
		"operator",
		failedClaim.RouteAttempts,
	)
	if err != nil || replay || retry.State != "pending" || retry.Cancellable {
		t.Fatalf("RetryWebhook() = %#v, %v, %v", retry, replay, err)
	}
	retryReplay, replay, err := store.RetryWebhook(
		ctx,
		failedReceipt.DeliveryID,
		"retry-key",
		"operator",
		failedClaim.RouteAttempts,
	)
	if err != nil || !replay || retryReplay.AttemptID != retry.AttemptID {
		t.Fatalf("retry replay = %#v, %v, %v", retryReplay, replay, err)
	}

	disabled := false
	updated, err := store.UpdateRegistration(
		ctx,
		created.ID,
		created.Version,
		RegistrationPatch{Enabled: &disabled},
		"operator",
		"registration.disabled",
	)
	if err != nil || updated.Enabled || updated.Version != created.Version+1 {
		t.Fatalf("UpdateRegistration() = %#v, %v", updated, err)
	}
	var staleJobStatus string
	if err := store.pool.QueryRow(ctx,
		`SELECT status FROM agentops_control.jobs WHERE id = $1`,
		jobID,
	).Scan(&staleJobStatus); err != nil {
		t.Fatal(err)
	}
	if staleJobStatus != "rejected" {
		t.Fatalf("stale queued job status = %s", staleJobStatus)
	}
	if _, _, err := store.EnqueueWork(
		ctx,
		created,
		"poll",
		"disabled-work",
		otherItem,
	); !errors.Is(err, ErrStaleRegistration) {
		t.Fatalf("disabled enqueue error = %v", err)
	}
}

func resetAndMigrate(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	root string,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, "DROP SCHEMA IF EXISTS agentops_control CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "CREATE SCHEMA agentops_control"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		CREATE TABLE agentops_control.schema_migrations (
		  version integer PRIMARY KEY CHECK (version > 0),
		  name text NOT NULL UNIQUE,
		  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
		  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
		)
	`); err != nil {
		t.Fatal(err)
	}
	for version, name := range []string{
		"0001_control_store.sql",
		"0002_registration_control.sql",
	} {
		path := filepath.Join(root, "db", "control-store", "migrations", name)
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(body)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
		digest := sha256.Sum256(body)
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO agentops_control.schema_migrations(version, name, checksum)
			 VALUES ($1, $2, $3)`,
			version+1,
			name,
			hex.EncodeToString(digest[:]),
		); err != nil {
			t.Fatal(err)
		}
	}
}

func stringPointer(value string) *string {
	return &value
}
