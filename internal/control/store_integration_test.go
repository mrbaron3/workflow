package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
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
	var jobType string
	var runnerPayload map[string]any
	if err := store.pool.QueryRow(ctx,
		`SELECT job_type, payload FROM agentops_control.jobs WHERE id = $1`,
		jobID,
	).Scan(&jobType, &runnerPayload); err != nil {
		t.Fatal(err)
	}
	event, _ := runnerPayload["event"].(map[string]any)
	execution, _ := runnerPayload["execution"].(map[string]any)
	if jobType != "agentops.runner" ||
		runnerPayload["schemaVersion"] != float64(1) ||
		event["kind"] != "issue" ||
		event["number"] != float64(13) ||
		execution["mode"] != "development_turn" {
		t.Fatalf("runner contract projection = %s %#v", jobType, runnerPayload)
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
	monitorDisabled := false
	raceRegistration, duplicate, err := store.CreateRegistration(
		ctx,
		CreateRegistration{
			Repository:          "owner/race",
			IssueMonitorEnabled: &monitorDisabled,
			PRMonitorEnabled:    &monitorDisabled,
		},
		"create-race-registration",
		"operator",
	)
	if err != nil || duplicate {
		t.Fatalf("race registration = %#v, %v, %v", raceRegistration, duplicate, err)
	}
	raceItem := issueItem
	raceItem.Repository = raceRegistration.Repository
	raceItem.Number = 77
	type enqueueResult struct {
		id        string
		duplicate bool
		err       error
	}
	start := make(chan struct{})
	results := make(chan enqueueResult, 2)
	var enqueueGroup sync.WaitGroup
	for _, sourceKind := range []string{"webhook", "poll"} {
		enqueueGroup.Add(1)
		go func(kind string) {
			defer enqueueGroup.Done()
			<-start
			id, duplicate, err := store.EnqueueWork(
				ctx,
				raceRegistration,
				kind,
				kind+"-source",
				raceItem,
			)
			results <- enqueueResult{id: id, duplicate: duplicate, err: err}
		}(sourceKind)
	}
	close(start)
	enqueueGroup.Wait()
	close(results)
	var raceResults []enqueueResult
	for result := range results {
		raceResults = append(raceResults, result)
	}
	if len(raceResults) != 2 || raceResults[0].err != nil || raceResults[1].err != nil ||
		raceResults[0].id != raceResults[1].id ||
		raceResults[0].duplicate == raceResults[1].duplicate {
		t.Fatalf("concurrent webhook/poll convergence = %#v", raceResults)
	}
	requeueRegistration, duplicate, err := store.CreateRegistration(
		ctx,
		CreateRegistration{
			Repository:          "owner/requeue",
			IssueMonitorEnabled: &monitorDisabled,
			PRMonitorEnabled:    &monitorDisabled,
		},
		"create-requeue-registration",
		"operator",
	)
	if err != nil || duplicate {
		t.Fatalf("requeue registration = %#v, %v, %v", requeueRegistration, duplicate, err)
	}
	requeueItem := issueItem
	requeueItem.Repository = requeueRegistration.Repository
	requeueItem.Number = 88
	requeueJobID, duplicate, err := store.EnqueueWork(
		ctx,
		requeueRegistration,
		"webhook",
		"requeue-source",
		requeueItem,
	)
	if err != nil || duplicate {
		t.Fatalf("initial requeue job = %s, %v, %v", requeueJobID, duplicate, err)
	}
	requeueRegistration, err = store.UpdateRegistration(
		ctx,
		requeueRegistration.ID,
		requeueRegistration.Version,
		RegistrationPatch{Configuration: json.RawMessage(`{}`)},
		"operator",
		"registration.updated",
	)
	if err != nil {
		t.Fatal(err)
	}
	recoveredJobID, duplicate, err := store.EnqueueWork(
		ctx,
		requeueRegistration,
		"poll",
		requeueItem.IdempotencyKey(),
		requeueItem,
	)
	if err != nil || duplicate || recoveredJobID != requeueJobID {
		t.Fatalf(
			"registration-change requeue = %s, %v, %v",
			recoveredJobID,
			duplicate,
			err,
		)
	}
	var recoveredVersion int64
	var recoveredStatus string
	var requeueAudits int
	if err := store.pool.QueryRow(ctx,
		`SELECT registration_version, status
		   FROM agentops_control.jobs WHERE id = $1`,
		requeueJobID,
	).Scan(&recoveredVersion, &recoveredStatus); err != nil {
		t.Fatal(err)
	}
	if err := store.pool.QueryRow(ctx,
		`SELECT count(*) FROM agentops_control.runtime_audit
		  WHERE job_id = $1
		    AND event_type = 'job.requeued_after_registration_change'`,
		requeueJobID,
	).Scan(&requeueAudits); err != nil {
		t.Fatal(err)
	}
	if recoveredVersion != requeueRegistration.Version ||
		recoveredStatus != "queued" || requeueAudits != 1 {
		t.Fatalf(
			"recovered version=%d status=%s audits=%d",
			recoveredVersion,
			recoveredStatus,
			requeueAudits,
		)
	}
	otherItem := issueItem
	otherItem.Number = 14
	if _, _, err := store.EnqueueWork(
		ctx,
		created,
		"poll",
		otherItem.IdempotencyKey(),
		otherItem,
	); !errors.Is(err, ErrRepositoryBusy) {
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
	projections, err := store.Projections(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	var createdProjection *RegistrationProjection
	for index := range projections {
		if projections[index].Registration.ID == created.ID {
			createdProjection = &projections[index]
			break
		}
	}
	if createdProjection == nil ||
		len(createdProjection.RecentDeliveryFailures) != 1 ||
		createdProjection.RecentDeliveryFailures[0].ID != failedReceipt.DeliveryID ||
		createdProjection.RecentDeliveryFailures[0].LastError == nil {
		t.Fatalf("failed delivery projection = %#v", createdProjection)
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
	deliveryStatus, err := store.DeliveryStatus(ctx, failedReceipt.DeliveryID)
	if err != nil ||
		deliveryStatus.Status != "pending" ||
		len(deliveryStatus.RetryAttempts) != 1 ||
		deliveryStatus.RetryAttempts[0].AttemptID != retry.AttemptID ||
		deliveryStatus.RetryAttempts[0].Status != "accepted" {
		t.Fatalf("DeliveryStatus() = %#v, %v", deliveryStatus, err)
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
	_, replay, err = store.RetryWebhook(
		ctx,
		failedReceipt.DeliveryID,
		"retry-rejected",
		"operator",
		failedClaim.RouteAttempts,
	)
	var retryConflict *DeliveryRetryConflict
	if replay || !errors.As(err, &retryConflict) || retryConflict.AttemptID == "" ||
		retryConflict.Reason != "delivery_not_retryable" {
		t.Fatalf("rejected retry = replay=%v conflict=%#v err=%v", replay, retryConflict, err)
	}
	rejectedAttemptID := retryConflict.AttemptID
	_, replay, err = store.RetryWebhook(
		ctx,
		failedReceipt.DeliveryID,
		"retry-rejected",
		"operator",
		failedClaim.RouteAttempts,
	)
	if !replay || !errors.As(err, &retryConflict) ||
		retryConflict.AttemptID != rejectedAttemptID {
		t.Fatalf("rejected retry replay = replay=%v conflict=%#v err=%v", replay, retryConflict, err)
	}
	var rejectedAttempts, rejectedAudits int
	if err := store.pool.QueryRow(ctx,
		`SELECT count(*)
		   FROM agentops_control.delivery_retry_attempts
		  WHERE delivery_id = $1 AND status = 'rejected'`,
		failedReceipt.DeliveryID,
	).Scan(&rejectedAttempts); err != nil {
		t.Fatal(err)
	}
	if err := store.pool.QueryRow(ctx,
		`SELECT count(*)
		   FROM agentops_control.runtime_audit
		  WHERE event_type = 'webhook.retry.rejected'
		    AND details->>'attemptId' = $1`,
		rejectedAttemptID,
	).Scan(&rejectedAudits); err != nil {
		t.Fatal(err)
	}
	if rejectedAttempts != 1 || rejectedAudits != 1 {
		t.Fatalf("rejected attempts=%d audits=%d", rejectedAttempts, rejectedAudits)
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
	projections, err = store.Projections(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for index := range projections {
		if projections[index].Registration.ID == created.ID {
			createdProjection = &projections[index]
			break
		}
	}
	if createdProjection == nil || createdProjection.LastJobFailure == nil ||
		createdProjection.LastJobFailure.ID != jobID ||
		createdProjection.LastJobFailure.Status != "rejected" {
		t.Fatalf("job failure projection = %#v", createdProjection)
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
		"0003_isolated_runner.sql",
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
