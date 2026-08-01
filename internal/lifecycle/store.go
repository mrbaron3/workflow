package lifecycle

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

var ErrStaleReplay = errors.New("lifecycle transition replay is stale")
var ErrIdempotencyConflict = errors.New("lifecycle idempotency key conflicts with the original request")

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse lifecycle database URL: %w", err)
	}
	config.ConnConfig.ConnectTimeout = 3 * time.Second
	config.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("connect lifecycle store: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect lifecycle store: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (store *Store) Close() {
	store.pool.Close()
}

func (store *Store) State(ctx context.Context) (State, error) {
	return scanState(store.pool.QueryRow(ctx, `
		SELECT mode, generation, transition_id, transition_started_at,
		       drain_deadline_at, drain_timed_out, last_error, updated_at
		  FROM agentops_control.lifecycle_state
		 WHERE singleton
	`))
}

func (store *Store) Transition(
	ctx context.Context,
	actorID, idempotencyKey string,
	to Mode,
	drainDeadline *time.Time,
	details map[string]any,
) (Transition, State, error) {
	actorID = strings.TrimSpace(actorID)
	idempotencyKey = strings.TrimSpace(idempotencyKey)
	if actorID == "" {
		return Transition{}, State{}, fmt.Errorf("actor ID is required")
	}
	if idempotencyKey == "" || len(idempotencyKey) > 256 {
		return Transition{}, State{}, fmt.Errorf("idempotency key must be 1..256 bytes")
	}
	if _, err := ParseMode(string(to)); err != nil {
		return Transition{}, State{}, err
	}
	if to != ModeDraining {
		drainDeadline = nil
	} else if drainDeadline != nil {
		normalized := drainDeadline.UTC().Round(time.Microsecond)
		drainDeadline = &normalized
	}
	if details == nil {
		details = map[string]any{}
	}
	detailJSON, err := json.Marshal(details)
	if err != nil {
		return Transition{}, State{}, fmt.Errorf("encode transition details: %w", err)
	}
	transaction, err := store.pool.Begin(ctx)
	if err != nil {
		return Transition{}, State{}, err
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()

	state, err := scanState(transaction.QueryRow(ctx, `
		SELECT mode, generation, transition_id, transition_started_at,
		       drain_deadline_at, drain_timed_out, last_error, updated_at
		  FROM agentops_control.lifecycle_state
		 WHERE singleton
		 FOR UPDATE
	`))
	if err != nil {
		return Transition{}, State{}, err
	}
	existing, err := transitionByKey(ctx, transaction, idempotencyKey)
	if err == nil {
		if !sameTransitionRequest(
			existing,
			actorID,
			to,
			drainDeadline,
			detailJSON,
		) {
			return Transition{}, State{}, fmt.Errorf(
				"%w: key %q was already used for a different actor, target, deadline, or details",
				ErrIdempotencyConflict,
				idempotencyKey,
			)
		}
		existing.Replayed = true
		if existing.Status == "rejected" {
			if existing.Error != nil {
				return existing, state, fmt.Errorf("%s", *existing.Error)
			}
			return existing, state, fmt.Errorf("rejected lifecycle transition replay")
		}
		if state.TransitionID == nil || *state.TransitionID != existing.ID {
			return existing, state, fmt.Errorf(
				"%w: key %q belongs to an earlier lifecycle generation",
				ErrStaleReplay,
				idempotencyKey,
			)
		}
		return existing, state, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Transition{}, State{}, err
	}
	id, err := randomID()
	if err != nil {
		return Transition{}, State{}, err
	}
	now := time.Now().UTC()
	status := "applied"
	var transitionError *string
	if state.Mode == to {
		status = "idempotent"
	}
	if !ValidTransition(state.Mode, to) {
		status = "rejected"
		message := fmt.Sprintf("invalid lifecycle transition %s -> %s", state.Mode, to)
		transitionError = &message
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO agentops_control.lifecycle_transitions(
		  id, idempotency_key, actor_id, from_mode, to_mode, status,
		  drain_deadline_at, error, details, started_at, finished_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
	`, id, idempotencyKey, actorID, state.Mode, to, status, drainDeadline,
		transitionError, detailJSON, now); err != nil {
		return Transition{}, State{}, err
	}
	if status != "rejected" {
		generationIncrement := 1
		if status == "idempotent" {
			generationIncrement = 0
		}
		if _, err := transaction.Exec(ctx, `
			UPDATE agentops_control.lifecycle_state
			   SET mode = $1,
			       generation = generation + $2,
			       transition_id = $3,
			       transition_started_at = $4,
			       drain_deadline_at = $5,
			       drain_timed_out = false,
			       last_error = NULL,
			       updated_at = clock_timestamp()
			 WHERE singleton
		`, to, generationIncrement, id, now, drainDeadline); err != nil {
			return Transition{}, State{}, err
		}
	}
	event := "lifecycle.transition." + status
	if _, err := transaction.Exec(ctx, `
		INSERT INTO agentops_control.runtime_audit(
		  actor_type, actor_id, event_type, details
		) VALUES ('lifecycle', $1, $2, $3)
	`, actorID, event, map[string]any{
		"transitionId": id,
		"fromMode":     state.Mode,
		"toMode":       to,
		"status":       status,
		"error":        transitionError,
	}); err != nil {
		return Transition{}, State{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return Transition{}, State{}, err
	}
	result := Transition{
		ID: id, IdempotencyKey: idempotencyKey, ActorID: actorID,
		FromMode: state.Mode, ToMode: to, Status: status,
		DrainDeadlineAt: drainDeadline, Error: transitionError,
		Details: details, StartedAt: now, FinishedAt: now,
	}
	current, currentErr := store.State(ctx)
	if currentErr != nil {
		return result, State{}, currentErr
	}
	if status == "rejected" {
		return result, current, fmt.Errorf("%s", *transitionError)
	}
	return result, current, nil
}

func sameTransitionRequest(
	existing Transition,
	actorID string,
	to Mode,
	drainDeadline *time.Time,
	detailJSON []byte,
) bool {
	if existing.ActorID != actorID || existing.ToMode != to {
		return false
	}
	switch {
	case existing.DrainDeadlineAt == nil && drainDeadline != nil,
		existing.DrainDeadlineAt != nil && drainDeadline == nil:
		return false
	case existing.DrainDeadlineAt != nil &&
		!existing.DrainDeadlineAt.Equal(*drainDeadline):
		return false
	}
	existingJSON, err := json.Marshal(existing.Details)
	if err != nil {
		return false
	}
	return string(existingJSON) == string(detailJSON)
}

func (store *Store) ReconcileExpiredRunnerWork(
	ctx context.Context,
	maxAttempts int,
	retryBase time.Duration,
) (int64, error) {
	if maxAttempts < 1 {
		return 0, fmt.Errorf("max attempts must be positive")
	}
	if retryBase < 0 {
		return 0, fmt.Errorf("retry base must be non-negative")
	}
	transaction, err := store.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	rows, err := transaction.Query(ctx, `
		SELECT l.id, l.job_id, l.attempt_id, a.attempt_number,
		       r.enabled, r.execution_enabled,
		       r.version = j.registration_version
		  FROM agentops_control.job_leases l
		  JOIN agentops_control.job_attempts a ON a.id = l.attempt_id
		  JOIN agentops_control.jobs j ON j.id = l.job_id
		  JOIN agentops_control.repository_registrations r
		    ON r.id = j.registration_id
		 WHERE l.status = 'active'
		   AND l.expires_at <= clock_timestamp()
		   AND j.job_type = 'agentops.runner'
		 ORDER BY l.expires_at
		 FOR UPDATE OF l, a, j, r SKIP LOCKED
	`)
	if err != nil {
		return 0, err
	}
	type expiredLease struct {
		leaseID, jobID, attemptID            string
		attempt                              int
		enabled, executionEnabled, versionOK bool
	}
	var expired []expiredLease
	for rows.Next() {
		var item expiredLease
		if err := rows.Scan(
			&item.leaseID,
			&item.jobID,
			&item.attemptID,
			&item.attempt,
			&item.enabled,
			&item.executionEnabled,
			&item.versionOK,
		); err != nil {
			rows.Close()
			return 0, err
		}
		expired = append(expired, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	for _, item := range expired {
		retryable := item.enabled &&
			item.executionEnabled &&
			item.versionOK &&
			item.attempt < maxAttempts
		jobStatus := "rejected"
		lastError := "lease expired after registration changed"
		if item.enabled && item.executionEnabled && item.versionOK {
			jobStatus = "failed"
			lastError = "lease expired and max attempts exhausted"
			if retryable {
				jobStatus = "queued"
				lastError = "lease expired"
			}
		}
		if _, err := transaction.Exec(ctx, `
			UPDATE agentops_control.job_leases
			   SET status = 'expired', released_at = clock_timestamp()
			 WHERE id = $1
		`, item.leaseID); err != nil {
			return 0, err
		}
		if _, err := transaction.Exec(ctx, `
			UPDATE agentops_control.job_attempts
			   SET status = 'timed_out',
			       finished_at = clock_timestamp(),
			       error = 'lease expired',
			       failure = jsonb_build_object(
			         'schemaVersion', 1,
			         'status', 'failed',
			         'code', 'lease_lost',
			         'message', 'lease expired',
			         'retryable', $2::boolean,
			         'boundary', NULL,
			         'observedAt', to_char(
			           clock_timestamp() AT TIME ZONE 'UTC',
			           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
			         )
			       )
			 WHERE id = $1 AND status = 'running'
		`, item.attemptID, retryable); err != nil {
			return 0, err
		}
		retryDelay := retryBase * time.Duration(
			1<<min(item.attempt-1, 10),
		)
		if retryDelay > time.Hour {
			retryDelay = time.Hour
		}
		if _, err := transaction.Exec(ctx, `
			UPDATE agentops_control.jobs
			   SET status = $2,
			       available_at = CASE
			         WHEN $2 = 'queued'
			         THEN clock_timestamp() + ($3 * interval '1 millisecond')
			         ELSE available_at
			       END,
			       finished_at = CASE
			         WHEN $2 = 'queued' THEN NULL
			         ELSE clock_timestamp()
			       END,
			       updated_at = clock_timestamp(),
			       last_error = $4,
			       failure = CASE
			         WHEN $2 = 'queued' THEN NULL
			         WHEN $2 = 'failed' THEN jsonb_build_object(
			           'schemaVersion', 1,
			           'status', 'failed',
			           'code', 'lease_lost',
			           'message', 'lease expired and max attempts exhausted',
			           'retryable', false,
			           'boundary', NULL,
			           'observedAt', to_char(
			             clock_timestamp() AT TIME ZONE 'UTC',
			             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
			           )
			         )
			         ELSE jsonb_build_object(
			           'schemaVersion', 1,
			           'status', 'failed',
			           'code', 'registration_stale',
			           'message', 'lease expired after registration changed',
			           'retryable', false,
			           'boundary', 'claim',
			           'observedAt', to_char(
			             clock_timestamp() AT TIME ZONE 'UTC',
			             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
			           )
			         )
			       END
			 WHERE id = $1 AND status = 'leased'
		`, item.jobID, jobStatus, retryDelay.Milliseconds(), lastError); err != nil {
			return 0, err
		}
		if _, err := transaction.Exec(ctx, `
			INSERT INTO agentops_control.runtime_audit(
			  actor_type, actor_id, event_type, job_id, details
			) VALUES (
			  'lifecycle', 'agentopsctl-recovery',
			  'lifecycle.recovery.lease_expired', $1, $2
			)
		`, item.jobID, map[string]any{
			"attemptNumber": item.attempt,
			"maxAttempts":   maxAttempts,
			"retryDelayMs":  retryDelay.Milliseconds(),
			"outcome":       jobStatus,
		}); err != nil {
			return 0, err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return 0, err
	}
	return int64(len(expired)), nil
}

func (store *Store) RecordFailure(
	ctx context.Context,
	actorID, operation, message string,
	drainTimedOut bool,
	details map[string]any,
) error {
	actorID = strings.TrimSpace(actorID)
	operation = strings.TrimSpace(operation)
	message = strings.TrimSpace(message)
	if actorID == "" || operation == "" || message == "" {
		return fmt.Errorf("actor, operation, and failure message are required")
	}
	transaction, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	if _, err := transaction.Exec(ctx, `
		UPDATE agentops_control.lifecycle_state
		   SET last_error = $1,
		       drain_timed_out = drain_timed_out OR $2,
		       updated_at = clock_timestamp()
		 WHERE singleton
	`, message, drainTimedOut); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO agentops_control.runtime_audit(
		  actor_type, actor_id, event_type, details
		) VALUES ('lifecycle', $1, 'lifecycle.operation.failed', $2)
	`, actorID, map[string]any{
		"operation":     operation,
		"message":       message,
		"drainTimedOut": drainTimedOut,
		"details":       details,
	}); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}

func (store *Store) Status(ctx context.Context) (Status, error) {
	transaction, err := store.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return Status{}, err
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	state, err := scanState(transaction.QueryRow(ctx, `
		SELECT mode, generation, transition_id, transition_started_at,
		       drain_deadline_at, drain_timed_out, last_error, updated_at
		  FROM agentops_control.lifecycle_state WHERE singleton
	`))
	if err != nil {
		return Status{}, err
	}
	var result Status
	result.State = state
	if err := transaction.QueryRow(ctx, `
		SELECT clock_timestamp(),
		       count(DISTINCT j.id) FILTER (WHERE j.status = 'queued'),
		       count(DISTINCT l.id) FILTER (
		         WHERE l.status = 'active' AND l.expires_at > clock_timestamp()
		       ),
		       count(DISTINCT a.id) FILTER (WHERE a.status = 'running'),
		       (
		         SELECT last_error FROM agentops_control.jobs
		          WHERE last_error IS NOT NULL
		          ORDER BY updated_at DESC, id DESC LIMIT 1
		       )
		  FROM agentops_control.jobs j
		  LEFT JOIN agentops_control.job_leases l ON l.job_id = j.id
		  LEFT JOIN agentops_control.job_attempts a ON a.job_id = j.id
	`).Scan(
		&result.DatabaseTime,
		&result.QueuedJobs,
		&result.ActiveLeases,
		&result.InFlightAttempts,
		&result.LastJobError,
	); err != nil {
		return Status{}, err
	}
	attemptRows, err := transaction.Query(ctx, `
		SELECT a.job_id, a.id, a.attempt_number, a.worker_id, a.status,
		       a.started_at, a.finished_at, l.expires_at, a.error
		  FROM agentops_control.job_attempts a
		  LEFT JOIN agentops_control.job_leases l ON l.attempt_id = a.id
		 ORDER BY a.started_at DESC, a.id DESC
		 LIMIT 20
	`)
	if err != nil {
		return Status{}, err
	}
	for attemptRows.Next() {
		var attempt AttemptStatus
		if err := attemptRows.Scan(
			&attempt.JobID, &attempt.AttemptID, &attempt.Attempt,
			&attempt.WorkerID, &attempt.Status, &attempt.StartedAt,
			&attempt.FinishedAt, &attempt.LeaseExpires, &attempt.Error,
		); err != nil {
			attemptRows.Close()
			return Status{}, err
		}
		result.RecentAttempts = append(result.RecentAttempts, attempt)
	}
	if err := attemptRows.Err(); err != nil {
		attemptRows.Close()
		return Status{}, err
	}
	attemptRows.Close()
	transitionRows, err := transaction.Query(ctx, `
		SELECT id, idempotency_key, actor_id, from_mode, to_mode, status,
		       drain_deadline_at, error, details, started_at, finished_at
		  FROM agentops_control.lifecycle_transitions
		 ORDER BY started_at DESC, id DESC
		 LIMIT 20
	`)
	if err != nil {
		return Status{}, err
	}
	for transitionRows.Next() {
		transition, err := scanTransition(transitionRows)
		if err != nil {
			transitionRows.Close()
			return Status{}, err
		}
		result.RecentTransitions = append(result.RecentTransitions, transition)
	}
	if err := transitionRows.Err(); err != nil {
		transitionRows.Close()
		return Status{}, err
	}
	transitionRows.Close()
	if err := transaction.Commit(ctx); err != nil {
		return Status{}, err
	}
	return result, nil
}

func BootstrapRoles(
	ctx context.Context,
	databaseURL, controlPassword, triagePassword, runnerPassword string,
) error {
	if len(controlPassword) < 32 || len(triagePassword) < 32 ||
		len(runnerPassword) < 32 {
		return fmt.Errorf(
			"control, triage, and runner database passwords must be at least 32 bytes",
		)
	}
	if controlPassword == triagePassword ||
		controlPassword == runnerPassword ||
		triagePassword == runnerPassword {
		return fmt.Errorf(
			"control, triage, and runner database passwords must be distinct",
		)
	}
	store, err := Open(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer store.Close()
	controlLiteral := quoteLiteral(controlPassword)
	triageLiteral := quoteLiteral(triagePassword)
	runnerLiteral := quoteLiteral(runnerPassword)
	statements := []string{
		`DO $$ BEGIN
		   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_control_app') THEN
		     CREATE ROLE agentops_control_app LOGIN;
		   END IF;
		 END $$`,
		`ALTER ROLE agentops_control_app PASSWORD ` + controlLiteral,
		`DO $$ BEGIN
		   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage') THEN
		     CREATE ROLE agentops_triage LOGIN;
		   END IF;
		 END $$`,
		`ALTER ROLE agentops_triage PASSWORD ` + triageLiteral,
		`DO $$ BEGIN
		   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
		     CREATE ROLE agentops_runner LOGIN;
		   END IF;
		 END $$`,
		`ALTER ROLE agentops_runner PASSWORD ` + runnerLiteral,
		`GRANT CONNECT ON DATABASE agentops TO agentops_control_app`,
		`GRANT USAGE ON SCHEMA agentops_control TO agentops_control_app`,
		`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agentops_control
		   TO agentops_control_app`,
		`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agentops_control
		   TO agentops_control_app`,
		`GRANT CONNECT ON DATABASE agentops TO agentops_triage`,
		`GRANT USAGE ON SCHEMA agentops_control TO agentops_triage`,
		`GRANT SELECT ON agentops_control.schema_migrations,
		   agentops_control.repository_registrations,
		   agentops_control.lifecycle_state TO agentops_triage`,
		`GRANT UPDATE(updated_at) ON agentops_control.lifecycle_state
		   TO agentops_triage`,
		`GRANT UPDATE(updated_at) ON agentops_control.repository_registrations
		   TO agentops_triage`,
		`GRANT SELECT, UPDATE ON agentops_control.jobs TO agentops_triage`,
		`GRANT SELECT, INSERT, UPDATE ON agentops_control.job_attempts,
		   agentops_control.job_leases TO agentops_triage`,
		`GRANT SELECT ON agentops_control.monitor_broker_requests
		   TO agentops_triage`,
		`REVOKE UPDATE ON agentops_control.monitor_broker_requests
		   FROM agentops_triage`,
		`GRANT EXECUTE ON FUNCTION
		   agentops_control.claim_monitor_broker_request(text, text[], uuid, integer)
		   TO agentops_triage`,
		`GRANT EXECUTE ON FUNCTION
		   agentops_control.complete_monitor_broker_request(uuid, uuid, text, jsonb)
		   TO agentops_triage`,
		`GRANT EXECUTE ON FUNCTION
		   agentops_control.fail_monitor_broker_request(uuid, uuid, text, text, text)
		   TO agentops_triage`,
		`GRANT EXECUTE ON FUNCTION
		   agentops_control.promote_triage_job(uuid, text, jsonb, text, text)
		   TO agentops_triage`,
		`GRANT EXECUTE ON FUNCTION
		   agentops_control.promote_triage_release(uuid, text, jsonb, text, text, jsonb)
		   TO agentops_triage`,
		`GRANT SELECT, INSERT ON agentops_control.runtime_audit TO agentops_triage`,
		`GRANT USAGE, SELECT ON SEQUENCE agentops_control.runtime_audit_id_seq
		   TO agentops_triage`,
		`GRANT CONNECT ON DATABASE agentops TO agentops_runner`,
		`GRANT USAGE ON SCHEMA agentops_control TO agentops_runner`,
		`GRANT SELECT ON agentops_control.schema_migrations,
		   agentops_control.repository_registrations,
		   agentops_control.lifecycle_state TO agentops_runner`,
		`GRANT UPDATE(updated_at) ON agentops_control.lifecycle_state
		   TO agentops_runner`,
		`GRANT UPDATE(updated_at) ON agentops_control.repository_registrations
		   TO agentops_runner`,
		`GRANT SELECT, UPDATE ON agentops_control.jobs TO agentops_runner`,
		`GRANT SELECT ON agentops_control.releases TO agentops_runner`,
		`GRANT SELECT ON agentops_control.release_heads,
		   agentops_control.release_receipt_outbox,
		   agentops_control.release_artifacts TO agentops_runner`,
		`GRANT EXECUTE ON FUNCTION
		   agentops_control.record_release_receipt(jsonb),
		   agentops_control.authorize_release_merge(jsonb),
		   agentops_control.complete_release_merge(jsonb),
		   agentops_control.record_release_artifact(text, jsonb),
		   agentops_control.lock_release_completion_state(uuid, uuid)
		   TO agentops_runner`,
		`GRANT SELECT, INSERT, UPDATE ON agentops_control.job_attempts,
		   agentops_control.job_leases, agentops_control.artifact_links
		   TO agentops_runner`,
		`REVOKE ALL ON agentops_control.monitor_broker_requests
		   FROM agentops_runner`,
		`REVOKE EXECUTE ON FUNCTION
		   agentops_control.claim_monitor_broker_request(text, text[], uuid, integer)
		   FROM agentops_runner`,
		`REVOKE EXECUTE ON FUNCTION
		   agentops_control.complete_monitor_broker_request(uuid, uuid, text, jsonb)
		   FROM agentops_runner`,
		`REVOKE EXECUTE ON FUNCTION
		   agentops_control.fail_monitor_broker_request(uuid, uuid, text, text, text)
		   FROM agentops_runner`,
		`REVOKE EXECUTE ON FUNCTION
		   agentops_control.promote_triage_job(uuid, text, jsonb, text, text)
		   FROM agentops_runner`,
		`REVOKE EXECUTE ON FUNCTION
		   agentops_control.promote_triage_release(uuid, text, jsonb, text, text, jsonb)
		   FROM agentops_runner`,
		`GRANT SELECT, INSERT ON agentops_control.runtime_audit TO agentops_runner`,
		`GRANT USAGE, SELECT ON SEQUENCE agentops_control.runtime_audit_id_seq
		   TO agentops_runner`,
	}
	transaction, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	for _, statement := range statements {
		if _, err := transaction.Exec(ctx, statement); err != nil {
			return fmt.Errorf("bootstrap database roles: %w", err)
		}
	}
	return transaction.Commit(ctx)
}

// RotatePostgresAdmin changes the persistent postgres login only while the
// durable lifecycle is fenced in DRAINING with no in-flight execution. The
// caller supplies the next secret through a private environment boundary; it
// is never returned, logged, or persisted.
func RotatePostgresAdmin(
	ctx context.Context,
	databaseURL, nextPassword, requestID string,
) error {
	if len(nextPassword) < 32 {
		return fmt.Errorf("next PostgreSQL administrator password must be at least 32 bytes")
	}
	requestID = strings.TrimSpace(requestID)
	if requestID == "" || len(requestID) > 256 {
		return fmt.Errorf("rotation request ID must be 1..256 bytes")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil || parsed.User == nil || parsed.User.Username() != "postgres" {
		return fmt.Errorf("PostgreSQL administrator rotation requires the postgres login")
	}
	currentPassword, present := parsed.User.Password()
	if !present || currentPassword == nextPassword {
		return fmt.Errorf("current and next PostgreSQL administrator credentials must differ")
	}
	if err := func() error {
		store, err := Open(ctx, databaseURL)
		if err != nil {
			return err
		}
		defer store.Close()
		transaction, err := store.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer func() { _ = transaction.Rollback(context.Background()) }()
		var mode string
		var activeLeases, runningAttempts int64
		if err := transaction.QueryRow(ctx, `
			SELECT mode,
			       (SELECT count(*) FROM agentops_control.job_leases
			         WHERE status = 'active' AND expires_at > clock_timestamp()),
			       (SELECT count(*) FROM agentops_control.job_attempts
			         WHERE status = 'running')
			  FROM agentops_control.lifecycle_state
			 WHERE singleton
			 FOR UPDATE
		`).Scan(&mode, &activeLeases, &runningAttempts); err != nil {
			return err
		}
		if mode != string(ModeDraining) || activeLeases != 0 || runningAttempts != 0 {
			return fmt.Errorf(
				"PostgreSQL administrator rotation requires DRAINING with zero active leases and attempts",
			)
		}
		if _, err := transaction.Exec(
			ctx,
			`ALTER ROLE postgres PASSWORD `+quoteLiteral(nextPassword),
		); err != nil {
			return fmt.Errorf("rotate PostgreSQL administrator credential")
		}
		if _, err := transaction.Exec(ctx, `
			INSERT INTO agentops_control.runtime_audit(
			  actor_type, actor_id, event_type, details
			) VALUES (
			  'lifecycle', 'agentopsctl',
			  'credential.postgres_admin.rotation_committed',
			  jsonb_build_object('requestId', $1::text)
			)
		`, requestID); err != nil {
			return fmt.Errorf("audit PostgreSQL administrator rotation")
		}
		if err := transaction.Commit(ctx); err != nil {
			return fmt.Errorf("commit PostgreSQL administrator rotation")
		}
		return nil
	}(); err != nil {
		return err
	}

	nextURL := *parsed
	nextURL.User = url.UserPassword("postgres", nextPassword)
	nextStore, err := Open(ctx, nextURL.String())
	if err != nil {
		return fmt.Errorf("verify next PostgreSQL administrator credential")
	}
	nextStore.Close()
	if oldStore, oldErr := Open(ctx, databaseURL); oldErr == nil {
		oldStore.Close()
		return fmt.Errorf("old PostgreSQL administrator credential still authenticates")
	}
	return nil
}

func quoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func scanState(row pgx.Row) (State, error) {
	var state State
	var mode string
	if err := row.Scan(
		&mode, &state.Generation, &state.TransitionID,
		&state.TransitionStartedAt, &state.DrainDeadlineAt,
		&state.DrainTimedOut, &state.LastError, &state.UpdatedAt,
	); err != nil {
		return State{}, err
	}
	parsed, err := ParseMode(mode)
	if err != nil {
		return State{}, err
	}
	state.Mode = parsed
	return state, nil
}

func transitionByKey(
	ctx context.Context,
	queryer interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	},
	key string,
) (Transition, error) {
	return scanTransition(queryer.QueryRow(ctx, `
		SELECT id, idempotency_key, actor_id, from_mode, to_mode, status,
		       drain_deadline_at, error, details, started_at, finished_at
		  FROM agentops_control.lifecycle_transitions
		 WHERE idempotency_key = $1
	`, key))
}

type scanner interface {
	Scan(...any) error
}

func scanTransition(row scanner) (Transition, error) {
	var transition Transition
	var from, to string
	var details []byte
	if err := row.Scan(
		&transition.ID, &transition.IdempotencyKey, &transition.ActorID,
		&from, &to, &transition.Status, &transition.DrainDeadlineAt,
		&transition.Error, &details, &transition.StartedAt,
		&transition.FinishedAt,
	); err != nil {
		return Transition{}, err
	}
	var err error
	transition.FromMode, err = ParseMode(from)
	if err != nil {
		return Transition{}, err
	}
	transition.ToMode, err = ParseMode(to)
	if err != nil {
		return Transition{}, err
	}
	if err := json.Unmarshal(details, &transition.Details); err != nil {
		return Transition{}, err
	}
	return transition, nil
}

func randomID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	text := hex.EncodeToString(value)
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		text[0:8], text[8:12], text[12:16], text[16:20], text[20:32]), nil
}
