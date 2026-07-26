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
	lifecyclestore "github.com/mrbaron3/workflow/internal/lifecycle"
)

func TestPostgresLifecycleTransitionIntegration(t *testing.T) {
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
	store, err := lifecyclestore.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	deadline := time.Now().UTC().Add(time.Minute).Round(time.Microsecond)
	details := map[string]any{"test": true}
	type transitionResult struct {
		transition lifecyclestore.Transition
		state      lifecyclestore.State
		err        error
	}
	results := make([]transitionResult, 2)
	var wait sync.WaitGroup
	for index := range results {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index].transition, results[index].state, results[index].err =
				store.Transition(
					ctx,
					"integration",
					"active-to-draining",
					lifecyclestore.ModeDraining,
					&deadline,
					details,
				)
		}(index)
	}
	wait.Wait()
	transition := results[0].transition
	if transition.Replayed {
		transition = results[1].transition
	}
	for index, result := range results {
		if result.err != nil ||
			result.transition.ID != transition.ID ||
			result.state.Mode != lifecyclestore.ModeDraining {
			t.Fatalf("concurrent transition[%d]=%#v state=%#v err=%v",
				index, result.transition, result.state, result.err)
		}
	}
	if results[0].transition.Replayed == results[1].transition.Replayed ||
		transition.Status != "applied" {
		t.Fatalf("same-key callers did not converge: %#v", results)
	}
	replay, replayState, err := store.Transition(
		ctx,
		"integration",
		"active-to-draining",
		lifecyclestore.ModeDraining,
		&deadline,
		details,
	)
	if err != nil || !replay.Replayed || replay.ID != transition.ID ||
		replayState.DrainDeadlineAt == nil ||
		!replayState.DrainDeadlineAt.Equal(deadline) {
		t.Fatalf("transition replay=%#v state=%#v err=%v", replay, replayState, err)
	}
	conflictingDeadline := deadline.Add(time.Second)
	for name, candidate := range map[string]struct {
		actor    string
		deadline *time.Time
		details  map[string]any
	}{
		"actor":    {"other-actor", &deadline, details},
		"deadline": {"integration", &conflictingDeadline, details},
		"details":  {"integration", &deadline, map[string]any{"test": false}},
	} {
		if _, _, err := store.Transition(
			ctx,
			candidate.actor,
			"active-to-draining",
			lifecyclestore.ModeDraining,
			candidate.deadline,
			candidate.details,
		); !errors.Is(err, lifecyclestore.ErrIdempotencyConflict) {
			t.Fatalf("%s idempotency conflict = %v", name, err)
		}
	}
	if _, current, err := store.Transition(
		ctx,
		"integration",
		"invalid-draining-active",
		lifecyclestore.ModeActive,
		nil,
		nil,
	); err == nil || current.Mode != lifecyclestore.ModeDraining {
		t.Fatalf("invalid transition state=%#v err=%v", current, err)
	}
	if _, _, err := store.Transition(
		ctx,
		"integration",
		"draining-monitor",
		lifecyclestore.ModeMonitorOnly,
		nil,
		nil,
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Transition(
		ctx,
		"integration",
		"active-to-draining",
		lifecyclestore.ModeDraining,
		&deadline,
		details,
	); !errors.Is(err, lifecyclestore.ErrStaleReplay) {
		t.Fatalf("old transition replay was not rejected as stale: %v", err)
	}
	if _, _, err := store.Transition(
		ctx,
		"integration",
		"monitor-active",
		lifecyclestore.ModeActive,
		nil,
		nil,
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Transition(
		ctx,
		"integration",
		"invalid-draining-active",
		lifecyclestore.ModeActive,
		nil,
		nil,
	); err == nil {
		t.Fatal("rejected transition replay unexpectedly succeeded")
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO agentops_control.repository_registrations(id, repository)
		VALUES ('10000000-0000-4000-8000-000000000001', 'owner/recovery');
		INSERT INTO agentops_control.jobs(
		  id, registration_id, registration_version, source_kind, source_key,
		  idempotency_key, job_type, payload, status
		) VALUES (
		  '20000000-0000-4000-8000-000000000001',
		  '10000000-0000-4000-8000-000000000001',
		  1, 'recovery', 'expired-attempt', 'expired-attempt',
		  'agentops.runner', '{}', 'leased'
		);
		INSERT INTO agentops_control.job_attempts(
		  id, job_id, attempt_number, worker_id, status
		) VALUES (
		  '30000000-0000-4000-8000-000000000001',
		  '20000000-0000-4000-8000-000000000001',
		  1, 'crashed-runner', 'running'
		);
		INSERT INTO agentops_control.job_leases(
		  id, job_id, attempt_id, lease_token, worker_id, status,
		  acquired_at, heartbeat_at, expires_at
		) VALUES (
		  '40000000-0000-4000-8000-000000000001',
		  '20000000-0000-4000-8000-000000000001',
		  '30000000-0000-4000-8000-000000000001',
		  '50000000-0000-4000-8000-000000000001',
		  'crashed-runner', 'active',
		  clock_timestamp() - interval '2 minutes',
		  clock_timestamp() - interval '2 minutes',
		  clock_timestamp() - interval '1 minute'
		)
	`); err != nil {
		t.Fatal(err)
	}
	reconciled, err := store.ReconcileExpiredRunnerWork(
		ctx,
		3,
		5*time.Second,
	)
	if err != nil || reconciled != 1 {
		t.Fatalf("expired recovery reconciled=%d err=%v", reconciled, err)
	}
	var jobStatus, attemptStatus, leaseStatus string
	if err := pool.QueryRow(ctx, `
		SELECT j.status, a.status, l.status
		  FROM agentops_control.jobs j
		  JOIN agentops_control.job_attempts a ON a.job_id = j.id
		  JOIN agentops_control.job_leases l ON l.attempt_id = a.id
		 WHERE j.id = '20000000-0000-4000-8000-000000000001'
	`).Scan(&jobStatus, &attemptStatus, &leaseStatus); err != nil {
		t.Fatal(err)
	}
	if jobStatus != "queued" ||
		attemptStatus != "timed_out" ||
		leaseStatus != "expired" {
		t.Fatalf(
			"recovered states job=%s attempt=%s lease=%s",
			jobStatus,
			attemptStatus,
			leaseStatus,
		)
	}
	if err := store.RecordFailure(
		ctx,
		"integration",
		"drain",
		"deadline reached",
		true,
		nil,
	); err != nil {
		t.Fatal(err)
	}
	status, err := store.Status(ctx)
	if err != nil || !status.State.DrainTimedOut ||
		status.State.LastError == nil || len(status.RecentTransitions) < 4 {
		t.Fatalf("lifecycle status=%#v err=%v", status, err)
	}
}

func TestPostgresDirectInsertLifecycleFenceIntegration(t *testing.T) {
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
	store, err := lifecyclestore.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := pool.Exec(ctx, `
		INSERT INTO agentops_control.repository_registrations(id, repository)
		VALUES ('11000000-0000-4000-8000-000000000001', 'owner/fence')
	`); err != nil {
		t.Fatal(err)
	}
	insertTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = insertTx.Rollback(context.Background()) }()
	if _, err := insertTx.Exec(ctx, `
		INSERT INTO agentops_control.jobs(
		  id, registration_id, registration_version, source_kind, source_key,
		  idempotency_key, job_type, payload, status
		) VALUES (
		  '21000000-0000-4000-8000-000000000001',
		  '11000000-0000-4000-8000-000000000001',
		  1, 'manual', 'before-drain', 'before-drain',
		  'agentops.runner', '{}', 'queued'
		)
	`); err != nil {
		t.Fatal(err)
	}
	drainDone := make(chan error, 1)
	deadline := time.Now().UTC().Add(time.Minute).Round(time.Microsecond)
	go func() {
		_, _, transitionErr := store.Transition(
			ctx,
			"integration",
			"direct-insert-drain",
			lifecyclestore.ModeDraining,
			&deadline,
			map[string]any{"test": "direct-insert-fence"},
		)
		drainDone <- transitionErr
	}()
	select {
	case err := <-drainDone:
		t.Fatalf("drain crossed the uncommitted insert fence: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	if err := insertTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-drainDone; err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO agentops_control.jobs(
		  id, registration_id, registration_version, source_kind, source_key,
		  idempotency_key, job_type, payload, status
		) VALUES (
		  '21000000-0000-4000-8000-000000000002',
		  '11000000-0000-4000-8000-000000000001',
		  1, 'manual', 'after-drain', 'after-drain',
		  'agentops.runner', '{}', 'queued'
		)
	`); err == nil {
		t.Fatal("direct insert committed after DRAINING")
	}

	if _, _, err := store.Transition(
		ctx,
		"integration",
		"fence-draining-monitor",
		lifecyclestore.ModeMonitorOnly,
		nil,
		map[string]any{"test": "direct-insert-fence"},
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Transition(
		ctx,
		"integration",
		"fence-monitor-active",
		lifecyclestore.ModeActive,
		nil,
		map[string]any{"test": "direct-insert-fence"},
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE agentops_control.jobs
		   SET status = 'succeeded', finished_at = clock_timestamp(),
		       updated_at = clock_timestamp()
		 WHERE id = '21000000-0000-4000-8000-000000000001'
	`); err != nil {
		t.Fatal(err)
	}
	drainTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = drainTx.Rollback(context.Background()) }()
	if _, err := drainTx.Exec(ctx, `
		UPDATE agentops_control.lifecycle_state
		   SET mode = 'DRAINING', generation = generation + 1,
		       updated_at = clock_timestamp()
		 WHERE singleton
	`); err != nil {
		t.Fatal(err)
	}
	insertDone := make(chan error, 1)
	go func() {
		_, insertErr := pool.Exec(ctx, `
			INSERT INTO agentops_control.jobs(
			  id, registration_id, registration_version, source_kind, source_key,
			  idempotency_key, job_type, payload, status
			) VALUES (
			  '21000000-0000-4000-8000-000000000003',
			  '11000000-0000-4000-8000-000000000001',
			  1, 'manual', 'racing-drain', 'racing-drain',
			  'agentops.runner', '{}', 'queued'
			)
		`)
		insertDone <- insertErr
	}()
	select {
	case err := <-insertDone:
		t.Fatalf("insert crossed the uncommitted drain fence: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	if err := drainTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-insertDone; err == nil {
		t.Fatal("racing direct insert committed after drain")
	}
}

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
	existing, duplicate, err := store.CreateRegistration(
		ctx,
		CreateRegistration{Repository: "owner/repo"},
		"create-existing-registration",
		"operator",
	)
	if !errors.Is(err, ErrConflict) || duplicate ||
		existing.ID != created.ID || existing.Version != created.Version {
		t.Fatalf("existing registration conflict = %#v, %v, %v", existing, duplicate, err)
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
	prEnabled := false
	commandUpdated, replay, err := store.UpdateRegistrationCommand(
		ctx,
		created.ID,
		created.Version,
		RegistrationPatch{PRMonitorEnabled: &prEnabled},
		"update-command-1",
		"operator",
		"registration.updated",
	)
	if err != nil || replay || commandUpdated.Version != created.Version+1 {
		t.Fatalf("UpdateRegistrationCommand() = %#v, %v, %v", commandUpdated, replay, err)
	}
	var auditedPrevious, auditedCurrent bool
	var auditedOutcome string
	if err := store.pool.QueryRow(ctx,
		`SELECT
		   (details->'changedFields'->'prMonitorEnabled'->>'previous')::boolean,
		   (details->'changedFields'->'prMonitorEnabled'->>'current')::boolean,
		   details->>'outcome'
		 FROM agentops_control.runtime_audit
		WHERE event_type = 'registration.updated'
		  AND details->>'commandIdentityDigest' IS NOT NULL
		ORDER BY occurred_at DESC
		LIMIT 1`,
	).Scan(&auditedPrevious, &auditedCurrent, &auditedOutcome); err != nil {
		t.Fatal(err)
	}
	if !auditedPrevious || auditedCurrent || auditedOutcome != "applied" {
		t.Fatalf(
			"update audit previous=%v current=%v outcome=%s",
			auditedPrevious,
			auditedCurrent,
			auditedOutcome,
		)
	}
	commandReplay, replay, err := store.UpdateRegistrationCommand(
		ctx,
		created.ID,
		created.Version,
		RegistrationPatch{PRMonitorEnabled: &prEnabled},
		"update-command-1",
		"operator",
		"registration.updated",
	)
	if err != nil || !replay || commandReplay.Version != commandUpdated.Version {
		t.Fatalf("update command replay = %#v, %v, %v", commandReplay, replay, err)
	}
	differentPREnabled := true
	if _, _, err := store.UpdateRegistrationCommand(
		ctx,
		created.ID,
		created.Version,
		RegistrationPatch{PRMonitorEnabled: &differentPREnabled},
		"update-command-1",
		"operator",
		"registration.updated",
	); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("update command identity conflict = %v", err)
	}
	_, replay, err = store.UpdateRegistrationCommand(
		ctx,
		created.ID,
		created.Version,
		RegistrationPatch{PRMonitorEnabled: &differentPREnabled},
		"update-command-rejected",
		"operator",
		"registration.updated",
	)
	var rejectedCommand *RegistrationCommandRejection
	if replay || !errors.As(err, &rejectedCommand) ||
		rejectedCommand.Reason != "registration_version_mismatch" ||
		rejectedCommand.RecordedAt.IsZero() {
		t.Fatalf("rejected update = replay=%v rejection=%#v err=%v", replay, rejectedCommand, err)
	}
	updateRejectedRecordedAt := rejectedCommand.RecordedAt
	_, replay, err = store.UpdateRegistrationCommand(
		ctx,
		created.ID,
		created.Version,
		RegistrationPatch{PRMonitorEnabled: &differentPREnabled},
		"update-command-rejected",
		"operator",
		"registration.updated",
	)
	if !replay || !errors.As(err, &rejectedCommand) ||
		!rejectedCommand.RecordedAt.Equal(updateRejectedRecordedAt) {
		t.Fatalf("rejected update replay = replay=%v rejection=%#v err=%v", replay, rejectedCommand, err)
	}
	enabled := false
	if _, _, err := store.UpdateRegistrationCommand(
		ctx,
		created.ID,
		created.Version,
		RegistrationPatch{Enabled: &enabled},
		"update-command-rejected",
		"operator",
		"registration.updated",
	); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("rejected update identity reuse = %v", err)
	}
	_, replay, err = store.UpdateRegistrationCommand(
		ctx,
		commandUpdated.ID,
		commandUpdated.Version,
		RegistrationPatch{PRMonitorEnabled: &prEnabled},
		"update-command-no-change",
		"operator",
		"registration.updated",
	)
	if replay || !errors.As(err, &rejectedCommand) ||
		rejectedCommand.Reason != "registration_patch_has_no_change" {
		t.Fatalf("no-change update = replay=%v rejection=%#v err=%v", replay, rejectedCommand, err)
	}
	_, replay, err = store.UpdateRegistrationCommand(
		ctx,
		commandUpdated.ID,
		commandUpdated.Version,
		RegistrationPatch{PRMonitorEnabled: &prEnabled},
		"update-command-no-change",
		"operator",
		"registration.updated",
	)
	if !replay || !errors.As(err, &rejectedCommand) ||
		rejectedCommand.Reason != "registration_patch_has_no_change" {
		t.Fatalf("no-change replay = replay=%v rejection=%#v err=%v", replay, rejectedCommand, err)
	}
	created = commandUpdated
	disabledDesired := false
	noEvidence, duplicate, err := store.CreateRegistration(
		ctx,
		CreateRegistration{
			Repository:          "owner/no-evidence",
			Enabled:             &disabledDesired,
			IssueMonitorEnabled: &disabledDesired,
			PRMonitorEnabled:    &disabledDesired,
			ExecutionEnabled:    &disabledDesired,
		},
		"create-no-evidence-registration",
		"operator",
	)
	if err != nil || duplicate {
		t.Fatalf("no-evidence registration = %#v, %v, %v", noEvidence, duplicate, err)
	}
	noEvidenceProjections, err := store.Projections(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	foundNoEvidence := false
	for _, projection := range noEvidenceProjections {
		if projection.Registration.ID != noEvidence.ID {
			continue
		}
		foundNoEvidence = true
		for _, componentName := range []string{
			ComponentIssueMonitor,
			ComponentPRMonitor,
			ComponentForwarder,
			ComponentExecution,
		} {
			component := projection.Components[componentName]
			if component.Actual != "unknown" ||
				component.Freshness != "unknown" ||
				component.ObservedAt != nil ||
				component.LastGoodAt != nil {
				t.Fatalf("missing %s evidence was fabricated: %#v", componentName, component)
			}
		}
	}
	if !foundNoEvidence {
		t.Fatal("no-evidence registration was absent from projections")
	}
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
	router := &Router{Store: store, Mode: ModeActive}
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
	if createdProjection.Components[ComponentExecution].Actual != "waiting" ||
		createdProjection.Components[ComponentQueue].Actual != "queued" ||
		createdProjection.ActiveJobState == nil ||
		*createdProjection.ActiveJobState != "queued" ||
		createdProjection.ActiveJobRegistrationVersion == nil ||
		*createdProjection.ActiveJobRegistrationVersion != created.Version {
		t.Fatalf("active work projection = %#v", createdProjection)
	}
	attemptID, _ := randomUUID()
	leaseID, _ := randomUUID()
	leaseToken, _ := randomUUID()
	if _, err := store.pool.Exec(ctx,
		`UPDATE agentops_control.jobs
		    SET status = 'leased', updated_at = clock_timestamp() - interval '2 minutes'
		  WHERE id = $1`,
		jobID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.pool.Exec(ctx,
		`INSERT INTO agentops_control.job_attempts(
		   id, job_id, attempt_number, worker_id, status, started_at
		 ) VALUES ($1, $2, 1, 'heartbeat-worker', 'running', clock_timestamp() - interval '2 minutes')`,
		attemptID,
		jobID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.pool.Exec(ctx,
		`INSERT INTO agentops_control.job_leases(
		   id, job_id, attempt_id, lease_token, worker_id,
		   acquired_at, heartbeat_at, expires_at
		 ) VALUES (
		   $1, $2, $3, $4, 'heartbeat-worker',
		   clock_timestamp() - interval '2 minutes',
		   clock_timestamp(),
		   clock_timestamp() + interval '1 minute'
		 )`,
		leaseID,
		jobID,
		attemptID,
		leaseToken,
	); err != nil {
		t.Fatal(err)
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
	executionProjection := createdProjection.Components[ComponentExecution]
	queueProjection := createdProjection.Components[ComponentQueue]
	if executionProjection.Actual != "running" ||
		executionProjection.Freshness != "fresh" ||
		queueProjection.Actual != "leased" ||
		queueProjection.Freshness != "fresh" ||
		executionProjection.ObservedAt == nil ||
		time.Since(*executionProjection.ObservedAt) > 10*time.Second {
		t.Fatalf(
			"lease heartbeat projection execution=%#v queue=%#v",
			executionProjection,
			queueProjection,
		)
	}
	if _, err := store.pool.Exec(ctx,
		`UPDATE agentops_control.job_leases
		    SET status = 'released', released_at = clock_timestamp()
		  WHERE id = $1`,
		leaseID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.pool.Exec(ctx,
		`DELETE FROM agentops_control.job_attempts WHERE id = $1`,
		attemptID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.pool.Exec(ctx,
		`UPDATE agentops_control.jobs
		    SET status = 'queued', updated_at = clock_timestamp()
		  WHERE id = $1`,
		jobID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.pool.Exec(ctx,
		`UPDATE agentops_control.repository_registrations
		    SET execution_enabled = false
		  WHERE id = $1`,
		created.ID,
	); err != nil {
		t.Fatal(err)
	}
	_, replay, err = store.RetryWebhook(
		ctx,
		failedReceipt.DeliveryID,
		"retry-execution-disabled",
		"operator",
		failedClaim.RouteAttempts,
		created.ID,
		created.Version,
	)
	var executionDisabledConflict *DeliveryRetryConflict
	if replay || !errors.As(err, &executionDisabledConflict) ||
		executionDisabledConflict.Reason != "execution_disabled" ||
		executionDisabledConflict.AttemptID == "" {
		t.Fatalf("execution-disabled retry = replay=%v conflict=%#v err=%v", replay, executionDisabledConflict, err)
	}
	executionDisabledAttemptID := executionDisabledConflict.AttemptID
	_, replay, err = store.RetryWebhook(
		ctx,
		failedReceipt.DeliveryID,
		"retry-execution-disabled",
		"operator",
		failedClaim.RouteAttempts,
		created.ID,
		created.Version,
	)
	if !replay || !errors.As(err, &executionDisabledConflict) ||
		executionDisabledConflict.AttemptID != executionDisabledAttemptID {
		t.Fatalf("execution-disabled retry replay = replay=%v conflict=%#v err=%v", replay, executionDisabledConflict, err)
	}
	if _, err := store.pool.Exec(ctx,
		`UPDATE agentops_control.repository_registrations
		    SET execution_enabled = true
		  WHERE id = $1`,
		created.ID,
	); err != nil {
		t.Fatal(err)
	}
	retry, replay, err := store.RetryWebhook(
		ctx,
		failedReceipt.DeliveryID,
		"retry-key",
		"operator",
		failedClaim.RouteAttempts,
		created.ID,
		created.Version,
	)
	if err != nil || replay || retry.State != "pending" || retry.Cancellable ||
		retry.RecordedAt.IsZero() {
		t.Fatalf("RetryWebhook() = %#v, %v, %v", retry, replay, err)
	}
	deliveryStatus, err := store.DeliveryStatus(ctx, failedReceipt.DeliveryID)
	acceptedRetryPresent := false
	for _, attempt := range deliveryStatus.RetryAttempts {
		if attempt.AttemptID == retry.AttemptID &&
			attempt.Status == "accepted" &&
			attempt.ObservedRouteAttempts == failedClaim.RouteAttempts {
			acceptedRetryPresent = true
		}
	}
	if err != nil ||
		deliveryStatus.Status != "pending" ||
		!acceptedRetryPresent {
		t.Fatalf("DeliveryStatus() = %#v, %v", deliveryStatus, err)
	}
	retryReplay, replay, err := store.RetryWebhook(
		ctx,
		failedReceipt.DeliveryID,
		"retry-key",
		"operator",
		failedClaim.RouteAttempts,
		created.ID,
		created.Version,
	)
	if err != nil || !replay || retryReplay.AttemptID != retry.AttemptID ||
		!retryReplay.RecordedAt.Equal(retry.RecordedAt) {
		t.Fatalf("retry replay = %#v, %v, %v", retryReplay, replay, err)
	}
	if _, _, err := store.RetryWebhook(
		ctx,
		unknownReceipt.DeliveryID,
		"retry-key",
		"operator",
		0,
		created.ID,
		created.Version,
	); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("cross-delivery idempotency key reuse = %v", err)
	}
	_, replay, err = store.RetryWebhook(
		ctx,
		failedReceipt.DeliveryID,
		"retry-rejected",
		"operator",
		failedClaim.RouteAttempts,
		created.ID,
		created.Version,
	)
	var retryConflict *DeliveryRetryConflict
	if replay || !errors.As(err, &retryConflict) || retryConflict.AttemptID == "" ||
		retryConflict.Reason != "delivery_not_retryable" {
		t.Fatalf("rejected retry = replay=%v conflict=%#v err=%v", replay, retryConflict, err)
	}
	rejectedAttemptID := retryConflict.AttemptID
	rejectedRecordedAt := retryConflict.RecordedAt
	_, replay, err = store.RetryWebhook(
		ctx,
		failedReceipt.DeliveryID,
		"retry-rejected",
		"operator",
		failedClaim.RouteAttempts,
		created.ID,
		created.Version,
	)
	if !replay || !errors.As(err, &retryConflict) ||
		retryConflict.AttemptID != rejectedAttemptID ||
		!retryConflict.RecordedAt.Equal(rejectedRecordedAt) {
		t.Fatalf("rejected retry replay = replay=%v conflict=%#v err=%v", replay, retryConflict, err)
	}
	var rejectedAttempts, rejectedAudits int
	if err := store.pool.QueryRow(ctx,
		`SELECT count(*)
		   FROM agentops_control.delivery_retry_attempts
		  WHERE delivery_id = $1 AND status = 'rejected' AND id = $2`,
		failedReceipt.DeliveryID,
		rejectedAttemptID,
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
	if createdProjection.Components[ComponentExecution].Actual != "stale" ||
		createdProjection.Components[ComponentExecution].Freshness != "stale" ||
		createdProjection.Components[ComponentExecution].RecoveryState != "blocked" {
		t.Fatalf("stale execution projection = %#v", createdProjection.Components[ComponentExecution])
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
		"0004_agentops_lifecycle.sql",
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
	if _, err := pool.Exec(ctx, `
		UPDATE agentops_control.lifecycle_state
		   SET mode = 'ACTIVE', generation = generation + 1,
		       updated_at = clock_timestamp()
		 WHERE singleton
	`); err != nil {
		t.Fatal(err)
	}
}

func stringPointer(value string) *string {
	return &value
}
