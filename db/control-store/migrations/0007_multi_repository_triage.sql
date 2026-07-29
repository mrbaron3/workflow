-- Registration-bound multi-repository monitoring and Issue-first triage.
-- The monitor credential can service only an explicit canonical repository
-- set. Issue observations enter agentops.triage and can reach the development
-- runner only through the ready-label promotion capability below.

ALTER TABLE agentops_control.repository_registrations
  ADD CONSTRAINT repository_registrations_canonical_github_identity
  CHECK (
    repository ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_.-]{1,100}$'
    AND split_part(repository, '/', 2) NOT IN ('.', '..')
  );

-- The TypeScript workers share generic lease code, so table grants alone are
-- insufficient role separation. Row policies make the database enforce the
-- job-type capability even if a compromised worker omits or forges its client
-- side filter. The table owner/migration role bypasses RLS; the control
-- application retains explicit all-row access.
ALTER TABLE agentops_control.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY jobs_worker_role_scope
  ON agentops_control.jobs
  FOR ALL
  USING (
    current_user = 'agentops_control_app'
    OR (current_user = 'agentops_triage' AND job_type = 'agentops.triage')
    OR (current_user = 'agentops_runner' AND job_type = 'agentops.runner')
  )
  WITH CHECK (
    current_user = 'agentops_control_app'
    OR (current_user = 'agentops_triage' AND job_type = 'agentops.triage')
    OR (current_user = 'agentops_runner' AND job_type = 'agentops.runner')
  );

ALTER TABLE agentops_control.job_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_attempts_worker_role_scope
  ON agentops_control.job_attempts
  FOR ALL
  USING (
    current_user = 'agentops_control_app'
    OR EXISTS (
      SELECT 1
        FROM agentops_control.jobs scoped_job
       WHERE scoped_job.id = job_attempts.job_id
    )
  )
  WITH CHECK (
    current_user = 'agentops_control_app'
    OR EXISTS (
      SELECT 1
        FROM agentops_control.jobs scoped_job
       WHERE scoped_job.id = job_attempts.job_id
    )
  );

ALTER TABLE agentops_control.job_leases ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_leases_worker_role_scope
  ON agentops_control.job_leases
  FOR ALL
  USING (
    current_user = 'agentops_control_app'
    OR EXISTS (
      SELECT 1
        FROM agentops_control.jobs scoped_job
       WHERE scoped_job.id = job_leases.job_id
    )
  )
  WITH CHECK (
    current_user = 'agentops_control_app'
    OR EXISTS (
      SELECT 1
        FROM agentops_control.jobs scoped_job
       WHERE scoped_job.id = job_leases.job_id
    )
  );

ALTER TABLE agentops_control.artifact_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY artifact_links_worker_role_scope
  ON agentops_control.artifact_links
  FOR ALL
  USING (
    current_user = 'agentops_control_app'
    OR EXISTS (
      SELECT 1
        FROM agentops_control.jobs scoped_job
       WHERE scoped_job.id = artifact_links.job_id
    )
  )
  WITH CHECK (
    current_user = 'agentops_control_app'
    OR EXISTS (
      SELECT 1
        FROM agentops_control.jobs scoped_job
       WHERE scoped_job.id = artifact_links.job_id
    )
  );

DROP FUNCTION agentops_control.claim_monitor_broker_request(
  text, text, uuid, integer
);

CREATE FUNCTION agentops_control.claim_monitor_broker_request(
  p_worker_id text,
  p_allowed_repositories text[],
  p_lease_token uuid,
  p_lease_ms integer
) RETURNS TABLE (
  id uuid,
  registration_id uuid,
  registration_version bigint,
  repository text,
  monitor_kind text,
  cursor jsonb,
  lease_token uuid
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = ''
     OR length(p_worker_id) > 256
     OR p_allowed_repositories IS NULL
     OR cardinality(p_allowed_repositories) < 1
     OR cardinality(p_allowed_repositories) > 64
     OR EXISTS (
       SELECT 1
         FROM unnest(p_allowed_repositories) AS allowed(value)
        WHERE allowed.value <> lower(allowed.value)
           OR allowed.value !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_.-]{1,100}$'
           OR split_part(allowed.value, '/', 2) IN ('.', '..')
     )
     OR cardinality(p_allowed_repositories) <> (
       SELECT count(DISTINCT allowed.value)
         FROM unnest(p_allowed_repositories) AS allowed(value)
     )
     OR p_lease_token IS NULL
     OR p_lease_ms IS NULL OR p_lease_ms < 5000 OR p_lease_ms > 60000 THEN
    RAISE EXCEPTION 'invalid monitor broker claim';
  END IF;

  WITH rejected AS (
    UPDATE agentops_control.monitor_broker_requests request
       SET status = 'failed', worker_id = NULL, lease_token = NULL,
           lease_expires_at = NULL, response = NULL,
           error_code = 'stale_registration',
           error_message = 'registration is stale, disabled, or outside the broker allowlist',
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE request.id IN (
       SELECT candidate.id
         FROM agentops_control.monitor_broker_requests candidate
        WHERE candidate.status IN ('pending', 'leased')
          AND (candidate.status = 'pending'
            OR candidate.lease_expires_at <= clock_timestamp())
          AND (
            NOT (candidate.repository = ANY(p_allowed_repositories))
            OR NOT EXISTS (
              SELECT 1
                FROM agentops_control.repository_registrations registration
               WHERE registration.id = candidate.registration_id
                 AND registration.version = candidate.registration_version
                 AND registration.repository = candidate.repository
                 AND registration.enabled
                 AND (
                   (candidate.monitor_kind = 'issue'
                     AND registration.issue_monitor_enabled)
                   OR
                   (candidate.monitor_kind = 'pull_request'
                     AND registration.pr_monitor_enabled)
                 )
            )
          )
        FOR UPDATE SKIP LOCKED
     )
    RETURNING request.id, request.registration_id
  )
  INSERT INTO agentops_control.runtime_audit(
    actor_type, actor_id, event_type, registration_id, details
  )
  SELECT 'triage', p_worker_id, 'monitor.broker.denied',
         rejected.registration_id,
         jsonb_build_object('requestId', rejected.id,
                            'reason', 'stale_registration')
    FROM rejected;

  RETURN QUERY
  WITH candidate AS (
    SELECT request.id
      FROM agentops_control.monitor_broker_requests request
      JOIN agentops_control.repository_registrations registration
        ON registration.id = request.registration_id
       AND registration.version = request.registration_version
       AND registration.repository = request.repository
     WHERE request.repository = ANY(p_allowed_repositories)
       AND registration.enabled
       AND (
         (request.monitor_kind = 'issue' AND registration.issue_monitor_enabled)
         OR
         (request.monitor_kind = 'pull_request' AND registration.pr_monitor_enabled)
       )
       AND (
         request.status = 'pending'
         OR (request.status = 'leased'
           AND request.lease_expires_at <= clock_timestamp())
       )
     ORDER BY request.created_at, request.id
     FOR UPDATE OF request SKIP LOCKED
     LIMIT 1
  )
  UPDATE agentops_control.monitor_broker_requests request
     SET status = 'leased', worker_id = p_worker_id,
         lease_token = p_lease_token,
         lease_expires_at =
           clock_timestamp() + (p_lease_ms * interval '1 millisecond'),
         response = NULL, error_code = NULL, error_message = NULL,
         completed_at = NULL, updated_at = clock_timestamp()
    FROM candidate
   WHERE request.id = candidate.id
  RETURNING request.id, request.registration_id,
            request.registration_version, request.repository,
            request.monitor_kind, request.cursor, request.lease_token;
END
$$;

REVOKE ALL ON FUNCTION
  agentops_control.claim_monitor_broker_request(text, text[], uuid, integer)
  FROM PUBLIC;

-- Atomically finish a triage lease and enqueue the exact development payload.
-- No command, ref, check, merge policy, clone URL, path, or environment crosses
-- this capability. The human-controlled exact `ready` label is verified by the
-- triage process immediately before invoking it.
CREATE FUNCTION agentops_control.promote_triage_job(
  p_lease_token uuid,
  p_worker_id text,
  p_result jsonb,
  p_ready_label text,
  p_claimed_label text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  current_job_id uuid;
  current_attempt_id uuid;
  current_attempt_number integer;
  current_registration_id uuid;
  current_registration_version bigint;
  current_repository text;
  current_payload jsonb;
  issue_number bigint;
  promoted_job_id uuid := gen_random_uuid();
  promoted_payload jsonb;
  final_result jsonb;
BEGIN
  IF p_lease_token IS NULL
     OR p_worker_id IS NULL OR btrim(p_worker_id) = ''
     OR length(p_worker_id) > 256
     OR p_result IS NULL OR jsonb_typeof(p_result) <> 'object'
     OR p_ready_label IS NULL
     OR p_ready_label !~ '^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,49}$'
     OR p_claimed_label IS NULL
     OR p_claimed_label !~ '^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,49}$'
     OR p_ready_label = p_claimed_label THEN
    RAISE EXCEPTION 'invalid triage promotion request';
  END IF;

  PERFORM 1
    FROM agentops_control.lifecycle_state lifecycle
   WHERE lifecycle.singleton AND lifecycle.mode = 'ACTIVE'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'triage promotion requires ACTIVE lifecycle';
  END IF;

  SELECT job.id, attempt.id, attempt.attempt_number,
         job.registration_id, job.registration_version,
         registration.repository, job.payload
    INTO current_job_id, current_attempt_id, current_attempt_number,
         current_registration_id, current_registration_version,
         current_repository, current_payload
    FROM agentops_control.job_leases lease
    JOIN agentops_control.job_attempts attempt
      ON attempt.id = lease.attempt_id
    JOIN agentops_control.jobs job
      ON job.id = lease.job_id
    JOIN agentops_control.repository_registrations registration
      ON registration.id = job.registration_id
   WHERE lease.lease_token = p_lease_token
     AND lease.worker_id = p_worker_id
     AND lease.status = 'active'
     AND lease.expires_at > clock_timestamp()
     AND attempt.status = 'running'
     AND job.status = 'leased'
     AND job.job_type = 'agentops.triage'
     AND registration.enabled
     AND registration.execution_enabled
     AND registration.version = job.registration_version
   FOR UPDATE OF lease, attempt, job, registration;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'triage promotion lease is stale or lost';
  END IF;

  IF jsonb_typeof(current_payload) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(current_payload)) <> 3
     OR current_payload - ARRAY['schemaVersion', 'repository', 'issue'] <> '{}'::jsonb
     OR current_payload->>'schemaVersion' <> '1'
     OR jsonb_typeof(current_payload->'repository') <> 'object'
     OR (
       SELECT count(*) FROM jsonb_object_keys(current_payload->'repository')
     ) <> 2
     OR (current_payload->'repository') - ARRAY['owner', 'name'] <> '{}'::jsonb
     OR concat(
          current_payload->'repository'->>'owner',
          '/',
          current_payload->'repository'->>'name'
        ) <> current_repository
     OR jsonb_typeof(current_payload->'issue') <> 'object'
     OR (
       SELECT count(*) FROM jsonb_object_keys(current_payload->'issue')
     ) <> 2
     OR (current_payload->'issue') - ARRAY['number', 'observedUpdatedAt'] <> '{}'::jsonb
     OR jsonb_typeof(current_payload->'issue'->'number') <> 'number'
     OR (current_payload->'issue'->>'number')::numeric <= 0
     OR (current_payload->'issue'->>'number')::numeric > 2147483647
     OR mod((current_payload->'issue'->>'number')::numeric, 1) <> 0 THEN
    RAISE EXCEPTION 'triage promotion payload is invalid';
  END IF;
  issue_number := (current_payload->'issue'->>'number')::bigint;

  IF (SELECT count(*) FROM jsonb_object_keys(p_result)) <> 13
     OR p_result - ARRAY[
       'schemaVersion', 'status', 'jobId', 'attemptNumber', 'repository',
       'issueNumber', 'outcome', 'sourceDigest', 'decision', 'commentUrl',
       'appliedLabels', 'promotedJobId', 'completedAt'
     ] <> '{}'::jsonb
     OR p_result->>'schemaVersion' <> '1'
     OR p_result->>'status' <> 'succeeded'
     OR p_result->>'jobId' <> current_job_id::text
     OR (p_result->>'attemptNumber')::integer <> current_attempt_number
     OR p_result->>'repository' <> current_repository
     OR (p_result->>'issueNumber')::bigint <> issue_number
     OR p_result->>'outcome' <> 'promoted'
     OR p_result->'sourceDigest' <> 'null'::jsonb
     OR p_result->'decision' <> 'null'::jsonb
     OR p_result->'commentUrl' <> 'null'::jsonb
     OR jsonb_typeof(p_result->'appliedLabels') <> 'array'
     OR p_result->'appliedLabels' <> '[]'::jsonb
     OR p_result->'promotedJobId' <> 'null'::jsonb
     OR jsonb_typeof(p_result->'completedAt') <> 'string'
     OR NOT pg_input_is_valid(
          p_result->>'completedAt',
          'timestamp with time zone'
        ) THEN
    RAISE EXCEPTION 'triage promotion result is invalid';
  END IF;

  promoted_payload := jsonb_build_object(
    'schemaVersion', 1,
    'repository', current_payload->'repository',
    'event', jsonb_build_object(
      'kind', 'issue',
      'number', issue_number,
      'action', 'recovery'
    ),
    'target', jsonb_build_object('baseRef', 'refs/heads/main'),
    'execution', jsonb_build_object(
      'mode', 'development_turn',
      'requiredChecks', '[]'::jsonb,
      'mergeMethod', 'squash',
      'readyLabel', p_ready_label,
      'claimedLabel', p_claimed_label
    ),
    'artifacts', '[]'::jsonb
  );
  final_result := jsonb_set(
    p_result,
    '{promotedJobId}',
    to_jsonb(promoted_job_id::text)
  );

  UPDATE agentops_control.job_leases
     SET status = 'completed', released_at = clock_timestamp()
   WHERE lease_token = p_lease_token;
  UPDATE agentops_control.job_attempts
     SET status = 'succeeded', finished_at = clock_timestamp(), error = NULL
   WHERE id = current_attempt_id;
  UPDATE agentops_control.jobs
     SET status = 'succeeded', result = final_result, failure = NULL,
         finished_at = clock_timestamp(), last_error = NULL,
         updated_at = clock_timestamp()
   WHERE id = current_job_id;

  INSERT INTO agentops_control.jobs(
    id, registration_id, registration_version, source_kind, source_key,
    idempotency_key, job_type, payload
  ) VALUES (
    promoted_job_id,
    current_registration_id,
    current_registration_version,
    'recovery',
    'triage-promotion:' || current_job_id::text,
    'triage-promotion:' || current_job_id::text,
    'agentops.runner',
    promoted_payload
  );

  UPDATE agentops_control.repository_registrations
     SET updated_at = clock_timestamp()
   WHERE id = current_registration_id;
  UPDATE agentops_control.lifecycle_state
     SET updated_at = clock_timestamp()
   WHERE singleton;
  INSERT INTO agentops_control.runtime_audit(
    actor_type, actor_id, event_type, registration_id, job_id, details
  ) VALUES (
    'triage', p_worker_id, 'triage.ready.promoted',
    current_registration_id, current_job_id,
    jsonb_build_object(
      'registrationVersion', current_registration_version,
      'repository', current_repository,
      'issueNumber', issue_number,
      'promotedJobId', promoted_job_id
    )
  );
  RETURN promoted_job_id;
END
$$;

REVOKE ALL ON FUNCTION
  agentops_control.promote_triage_job(uuid, text, jsonb, text, text)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    EXECUTE
      'REVOKE ALL ON agentops_control.monitor_broker_requests FROM agentops_runner';
    EXECUTE
      'REVOKE EXECUTE ON FUNCTION agentops_control.claim_monitor_broker_request(text, text[], uuid, integer) FROM agentops_runner';
    EXECUTE
      'REVOKE EXECUTE ON FUNCTION agentops_control.complete_monitor_broker_request(uuid, uuid, text, jsonb) FROM agentops_runner';
    EXECUTE
      'REVOKE EXECUTE ON FUNCTION agentops_control.fail_monitor_broker_request(uuid, uuid, text, text, text) FROM agentops_runner';
    EXECUTE
      'REVOKE EXECUTE ON FUNCTION agentops_control.promote_triage_job(uuid, text, jsonb, text, text) FROM agentops_runner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage') THEN
    EXECUTE
      'GRANT EXECUTE ON FUNCTION agentops_control.claim_monitor_broker_request(text, text[], uuid, integer) TO agentops_triage';
    EXECUTE
      'GRANT EXECUTE ON FUNCTION agentops_control.complete_monitor_broker_request(uuid, uuid, text, jsonb) TO agentops_triage';
    EXECUTE
      'GRANT EXECUTE ON FUNCTION agentops_control.fail_monitor_broker_request(uuid, uuid, text, text, text) TO agentops_triage';
    EXECUTE
      'GRANT EXECUTE ON FUNCTION agentops_control.promote_triage_job(uuid, text, jsonb, text, text) TO agentops_triage';
  END IF;
END
$$;
