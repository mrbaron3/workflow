-- CISO-04 isolated runner result/failure and artifact-integrity state.
-- PostgreSQL remains the only durable control-plane source of truth. Repository
-- clones, worktrees, logs, and review evidence stay in the runner-only volume.

ALTER TABLE agentops_control.jobs
  ADD COLUMN result jsonb,
  ADD COLUMN failure jsonb,
  ADD CONSTRAINT jobs_terminal_outcome_shape CHECK (
    (result IS NULL OR (status = 'succeeded' AND failure IS NULL))
    AND (failure IS NULL OR (status IN ('failed', 'rejected') AND result IS NULL))
    AND (status NOT IN ('queued', 'leased', 'cancelled')
         OR (result IS NULL AND failure IS NULL))
  );

ALTER TABLE agentops_control.job_attempts
  ADD COLUMN failure jsonb,
  ADD CONSTRAINT job_attempts_failure_shape CHECK (
    failure IS NULL OR status IN ('failed', 'timed_out', 'cancelled')
  );

ALTER TABLE agentops_control.artifact_links
  ADD CONSTRAINT artifact_links_registration_volume_uri
    CHECK (
      uri ~ '^volume://registrations/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._/-]+$'
      AND uri !~ '/\.\.?(/|$)'
    ),
  ADD CONSTRAINT artifact_links_attempt_identity
    UNIQUE NULLS NOT DISTINCT (job_id, attempt_id, kind, uri);

CREATE INDEX runtime_audit_runner_boundary
  ON agentops_control.runtime_audit (job_id, event_type, occurred_at DESC)
  WHERE event_type LIKE 'runner.boundary.%';

-- Replace the CISO-03 queued-job rejection body so the claim boundary has a
-- durable transactional denial reason even though no worker is allowed to
-- acquire an obsolete row.
CREATE OR REPLACE FUNCTION agentops_control.reject_registration_stale_work()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version <> OLD.version THEN
    INSERT INTO agentops_control.runtime_audit(
      actor_type, actor_id, event_type, registration_id, job_id, details
    )
    SELECT 'runner', 'registration-trigger', 'runner.boundary.claim.denied',
           NEW.id, j.id,
           jsonb_build_object(
             'reason', CASE
               WHEN NOT NEW.enabled THEN 'registration_disabled'
               WHEN NOT NEW.execution_enabled THEN 'registration_execution_disabled'
               ELSE 'registration_version_stale'
             END,
             'registrationVersion', j.registration_version,
             'currentRegistrationVersion', NEW.version,
             'enabled', NEW.enabled,
             'executionEnabled', NEW.execution_enabled
           )
      FROM agentops_control.jobs j
     WHERE j.registration_id = NEW.id
       AND j.status = 'queued';

    UPDATE agentops_control.jobs
       SET status = 'rejected',
           finished_at = clock_timestamp(),
           updated_at = clock_timestamp(),
           last_error = 'registration changed before lease acquisition'
     WHERE registration_id = NEW.id
       AND status = 'queued';
  END IF;
  RETURN NEW;
END;
$$;
