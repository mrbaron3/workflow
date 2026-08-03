-- Freeze the exact Source Issue requirements at the human ready boundary. The
-- snapshot is attached atomically to the promoted runner job, so later PR
-- webhooks resolve requirements through the durable release instead of reading
-- a mutable GitHub Issue into a privileged reviewer prompt.

-- Releases created before this migration have no ready-time requirements
-- authority. They must not continue toward merge under evidence rules they
-- can never satisfy. Preserve the old PR coordinate for audit, but make the
-- identity terminal so a new human ready event creates a fresh release.
ALTER TABLE agentops_control.releases
  DROP CONSTRAINT releases_status_check,
  DROP CONSTRAINT releases_state_shape;
ALTER TABLE agentops_control.releases
  ADD CONSTRAINT releases_status_check
    CHECK (status IN ('collecting', 'merge-authorized', 'merged', 'abandoned')),
  ADD CONSTRAINT releases_state_shape CHECK (
    (status = 'collecting'
      AND final_head IS NULL
      AND merge_sha IS NULL AND merge_actor IS NULL AND completed_at IS NULL)
    OR
    (status = 'merge-authorized'
      AND pull_request_number IS NOT NULL AND final_head IS NOT NULL
      AND merge_sha IS NULL AND merge_actor IS NULL AND completed_at IS NULL)
    OR
    (status = 'merged'
      AND pull_request_number IS NOT NULL AND final_head IS NOT NULL
      AND merge_sha IS NOT NULL AND merge_actor IS NOT NULL
      AND completed_at IS NOT NULL)
    OR
    (status = 'abandoned'
      AND final_head IS NULL AND merge_sha IS NULL AND merge_actor IS NULL
      AND completed_at IS NOT NULL)
  );

WITH abandoned AS (
  UPDATE agentops_control.releases release
     SET status = 'abandoned', final_head = NULL,
         completed_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE release.status IN ('collecting', 'merge-authorized')
  RETURNING release.id, release.registration_id, release.issue_number,
            release.pull_request_number
)
INSERT INTO agentops_control.runtime_audit(
  actor_type, actor_id, event_type, registration_id, details
)
SELECT 'system', 'migration-0017', 'release.abandoned.requirements-upgrade',
       abandoned.registration_id,
       jsonb_build_object(
         'releaseId', abandoned.id,
         'issueNumber', abandoned.issue_number,
         'pullRequestNumber', abandoned.pull_request_number,
         'reason', 'legacy-release-had-no-frozen-requirements-authority'
       )
  FROM abandoned;

ALTER TABLE agentops_control.release_receipt_outbox
  DROP CONSTRAINT release_receipt_outbox_kind_check;
ALTER TABLE agentops_control.release_receipt_outbox
  ADD CONSTRAINT release_receipt_outbox_kind_check CHECK (kind IN (
    'authority', 'requirements-authority', 'build', 'grade', 'review',
    'finding-resolution', 'runtime-provenance', 'merge-intent', 'merge',
    'intervention'
  ));

ALTER FUNCTION agentops_control.promote_triage_release(
  uuid, text, jsonb, text, text, jsonb
) RENAME TO promote_triage_release_without_source_snapshot;

REVOKE ALL ON FUNCTION
  agentops_control.promote_triage_release_without_source_snapshot(
    uuid, text, jsonb, text, text, jsonb
  ) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage') THEN
    REVOKE ALL ON FUNCTION
      agentops_control.promote_triage_release_without_source_snapshot(
        uuid, text, jsonb, text, text, jsonb
      ) FROM agentops_triage;
  END IF;
END
$$;

-- Extend durable progress to the triage lease role without changing applied
-- migration 0014. Identity remains derived from the live lease in SQL.
ALTER TABLE agentops_control.development_progress_events
  ADD COLUMN parent_issue_number bigint CHECK (
    parent_issue_number IS NULL OR parent_issue_number > 0
  );

CREATE INDEX development_progress_parent_time
  ON agentops_control.development_progress_events(
    repository, parent_issue_number, occurred_at DESC, id DESC
  ) WHERE parent_issue_number IS NOT NULL;

CREATE OR REPLACE FUNCTION agentops_control.record_development_progress(
  p_lease_token uuid,
  p_worker_id text,
  p_event jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  progress_id bigint;
  durable_registration_id uuid;
  durable_registration_version bigint;
  durable_job_id uuid;
  durable_attempt_id uuid;
  durable_release_id uuid;
  durable_repository text;
  durable_subject_kind text;
  durable_subject_number bigint;
BEGIN
  IF jsonb_typeof(p_event) <> 'object'
     OR NOT (p_event ?& ARRAY['eventKey', 'phase', 'step', 'state'])
     OR p_event - ARRAY[
       'eventKey', 'phase', 'step', 'state', 'summary', 'nextGate', 'blocker',
       'sessionName', 'worktreePath', 'branch', 'pullRequestNumber',
       'parentIssueNumber'
     ] <> '{}'::jsonb
     OR length(p_event->>'eventKey') NOT BETWEEN 1 AND 200
     OR (p_event->>'eventKey') !~ '^[a-z0-9][a-z0-9:._/-]*$'
     OR p_event->>'phase' NOT IN (
       'intake', 'planning', 'design', 'generation', 'validation', 'review',
       'pull-request', 'merge', 'human-review', 'completed', 'failed'
     )
     OR length(p_event->>'step') NOT BETWEEN 1 AND 160
     OR p_event->>'state' NOT IN (
       'pending', 'running', 'waiting', 'blocked', 'succeeded', 'failed'
     )
     OR length(COALESCE(p_event->>'summary', 'x')) NOT BETWEEN 1 AND 1000
     OR length(COALESCE(p_event->>'nextGate', 'x')) NOT BETWEEN 1 AND 500
     OR length(COALESCE(p_event->>'blocker', 'x')) NOT BETWEEN 1 AND 1000
     OR length(COALESCE(p_event->>'sessionName', 'x')) NOT BETWEEN 1 AND 250
     OR length(COALESCE(p_event->>'worktreePath', 'x')) NOT BETWEEN 1 AND 2000
     OR length(COALESCE(p_event->>'branch', 'x')) NOT BETWEEN 1 AND 500
     OR (
       p_event ? 'pullRequestNumber'
       AND p_event->'pullRequestNumber' <> 'null'::jsonb
       AND (
         jsonb_typeof(p_event->'pullRequestNumber') <> 'number'
         OR NOT pg_input_is_valid(p_event->>'pullRequestNumber', 'bigint')
         OR (p_event->>'pullRequestNumber')::bigint < 1
       )
     )
     OR (
       p_event ? 'parentIssueNumber'
       AND p_event->'parentIssueNumber' <> 'null'::jsonb
       AND (
         jsonb_typeof(p_event->'parentIssueNumber') <> 'number'
         OR NOT pg_input_is_valid(p_event->>'parentIssueNumber', 'bigint')
         OR (p_event->>'parentIssueNumber')::bigint < 1
       )
     ) THEN
    RAISE EXCEPTION 'development progress event is invalid';
  END IF;

  SELECT registration.id, job.registration_version, job.id, attempt.id,
         release.id, registration.repository,
         CASE
           WHEN release.issue_number IS NOT NULL THEN 'issue'
           WHEN job.job_type = 'agentops.triage' THEN 'issue'
           ELSE job.payload->'event'->>'kind'
         END,
         COALESCE(
           release.issue_number,
           CASE WHEN job.job_type = 'agentops.triage'
             THEN (job.payload->'issue'->>'number')::bigint END,
           CASE WHEN job.payload->'event'->>'kind' <> 'repository'
             THEN (job.payload->'event'->>'number')::bigint
           END
         )
    INTO durable_registration_id, durable_registration_version, durable_job_id,
         durable_attempt_id, durable_release_id, durable_repository,
         durable_subject_kind, durable_subject_number
    FROM agentops_control.job_leases lease
    JOIN agentops_control.job_attempts attempt ON attempt.id = lease.attempt_id
    JOIN agentops_control.jobs job ON job.id = lease.job_id
    JOIN agentops_control.repository_registrations registration
      ON registration.id = job.registration_id
    LEFT JOIN agentops_control.releases release ON release.id = job.release_id
   WHERE lease.lease_token = p_lease_token
     AND lease.worker_id = p_worker_id
     AND lease.status = 'active'
     AND lease.expires_at > clock_timestamp()
     AND attempt.status = 'running'
     AND job.status = 'leased'
     AND job.job_type IN ('agentops.runner', 'agentops.triage');
  IF NOT FOUND
     OR durable_subject_kind NOT IN ('issue', 'pull_request', 'repository')
     OR (durable_subject_kind = 'repository' AND durable_subject_number IS NOT NULL)
     OR (durable_subject_kind <> 'repository' AND durable_subject_number IS NULL) THEN
    RAISE EXCEPTION 'development progress lease identity is invalid';
  END IF;

  INSERT INTO agentops_control.development_progress_events(
    registration_id, registration_version, job_id, attempt_id, release_id,
    repository, subject_kind, subject_number, worker_id, event_key, phase,
    step, state, summary, next_gate, blocker, session_name, worktree_path,
    branch, pull_request_number, parent_issue_number
  ) VALUES (
    durable_registration_id, durable_registration_version, durable_job_id,
    durable_attempt_id, durable_release_id, durable_repository,
    durable_subject_kind, durable_subject_number, p_worker_id,
    p_event->>'eventKey', p_event->>'phase', p_event->>'step', p_event->>'state',
    NULLIF(p_event->>'summary', ''), NULLIF(p_event->>'nextGate', ''),
    NULLIF(p_event->>'blocker', ''), NULLIF(p_event->>'sessionName', ''),
    NULLIF(p_event->>'worktreePath', ''), NULLIF(p_event->>'branch', ''),
    CASE WHEN p_event->'pullRequestNumber' IS NULL
              OR p_event->'pullRequestNumber' = 'null'::jsonb
      THEN NULL ELSE (p_event->>'pullRequestNumber')::bigint END,
    CASE WHEN p_event->'parentIssueNumber' IS NULL
              OR p_event->'parentIssueNumber' = 'null'::jsonb
      THEN NULL ELSE (p_event->>'parentIssueNumber')::bigint END
  )
  ON CONFLICT (job_id, event_key) DO UPDATE SET
    attempt_id = EXCLUDED.attempt_id,
    worker_id = EXCLUDED.worker_id,
    phase = EXCLUDED.phase,
    step = EXCLUDED.step,
    state = EXCLUDED.state,
    summary = EXCLUDED.summary,
    next_gate = EXCLUDED.next_gate,
    blocker = EXCLUDED.blocker,
    session_name = EXCLUDED.session_name,
    worktree_path = EXCLUDED.worktree_path,
    branch = EXCLUDED.branch,
    pull_request_number = EXCLUDED.pull_request_number,
    parent_issue_number = EXCLUDED.parent_issue_number,
    occurred_at = clock_timestamp()
  RETURNING id INTO progress_id;

  RETURN progress_id;
END
$$;

REVOKE ALL ON FUNCTION agentops_control.record_development_progress(
  uuid, text, jsonb
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    REVOKE SELECT ON agentops_control.development_progress_events
      FROM agentops_runner;
    GRANT EXECUTE ON FUNCTION agentops_control.record_development_progress(
      uuid, text, jsonb
    ) TO agentops_runner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage') THEN
    GRANT EXECUTE ON FUNCTION agentops_control.record_development_progress(
      uuid, text, jsonb
    ) TO agentops_triage;
  END IF;
END
$$;

-- The runner completion capability validates the exact typed result and
-- durable repository/job coordinates rather than trusting its caller.
CREATE OR REPLACE FUNCTION agentops_control.complete_runner_human_review(
  p_lease_token uuid,
  p_worker_id text,
  p_result jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  lease_id uuid;
  attempt_id uuid;
  attempt_number integer;
  runner_job_id uuid;
  durable_release_id uuid;
  durable_registration_id uuid;
  durable_repository text;
BEGIN
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object'
     OR (p_result ?& ARRAY[
       'schemaVersion', 'status', 'jobId', 'attemptNumber', 'repository',
       'outcome', 'humanReview', 'headSha', 'pullRequestNumber', 'artifacts',
       'completedAt'
     ]) IS NOT TRUE
     OR p_result - ARRAY[
       'schemaVersion', 'status', 'jobId', 'attemptNumber', 'repository',
       'outcome', 'humanReview', 'headSha', 'pullRequestNumber', 'artifacts',
       'completedAt'
     ] <> '{}'::jsonb
     OR p_result->'schemaVersion' IS DISTINCT FROM '1'::jsonb
     OR p_result->>'status' IS DISTINCT FROM 'succeeded'
     OR jsonb_typeof(p_result->'jobId') IS DISTINCT FROM 'string'
     OR pg_input_is_valid(p_result->>'jobId', 'uuid') IS NOT TRUE
     OR jsonb_typeof(p_result->'attemptNumber') IS DISTINCT FROM 'number'
     OR pg_input_is_valid(p_result->>'attemptNumber', 'integer') IS NOT TRUE
     OR (p_result->>'attemptNumber')::integer < 1
     OR jsonb_typeof(p_result->'repository') IS DISTINCT FROM 'string'
     OR p_result->>'repository' <> lower(p_result->>'repository')
     OR p_result->>'repository' !~
       '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_.-]{1,100}$'
     OR split_part(p_result->>'repository', '/', 2) IN ('.', '..')
     OR p_result->>'outcome' IS DISTINCT FROM 'needs-human-review'
     OR p_result->'headSha' IS DISTINCT FROM 'null'::jsonb
     OR p_result->'pullRequestNumber' IS DISTINCT FROM 'null'::jsonb
     OR jsonb_typeof(p_result->'artifacts') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_result->'completedAt') IS DISTINCT FROM 'string'
     OR pg_input_is_valid(
       p_result->>'completedAt', 'timestamp with time zone'
     ) IS NOT TRUE
     OR jsonb_typeof(p_result->'humanReview') IS DISTINCT FROM 'object'
     OR ((p_result->'humanReview') ?& ARRAY[
       'issueNumber', 'reasonCount', 'commentUrl', 'classification',
       'howIntervention', 'aiAppliedReadyLabel', 'claimedLabelRemoved'
     ]) IS NOT TRUE
     OR (p_result->'humanReview') - ARRAY[
       'issueNumber', 'reasonCount', 'commentUrl', 'classification',
       'howIntervention', 'aiAppliedReadyLabel', 'claimedLabelRemoved'
     ] <> '{}'::jsonb
     OR jsonb_typeof(p_result->'humanReview'->'issueNumber')
       IS DISTINCT FROM 'number'
     OR pg_input_is_valid(
       p_result->'humanReview'->>'issueNumber', 'bigint'
     ) IS NOT TRUE
     OR (p_result->'humanReview'->>'issueNumber')::bigint
       NOT BETWEEN 1 AND 2147483647
     OR jsonb_typeof(p_result->'humanReview'->'reasonCount')
       IS DISTINCT FROM 'number'
     OR pg_input_is_valid(
       p_result->'humanReview'->>'reasonCount', 'integer'
     ) IS NOT TRUE
     OR (p_result->'humanReview'->>'reasonCount')::integer < 1
     OR jsonb_typeof(p_result->'humanReview'->'commentUrl')
       IS DISTINCT FROM 'string'
     OR length(p_result->'humanReview'->>'commentUrl') NOT BETWEEN 1 AND 2000
     OR p_result->'humanReview'->>'classification'
       IS DISTINCT FROM 'what-judgment'
     OR p_result->'humanReview'->'howIntervention'
       IS DISTINCT FROM 'false'::jsonb
     OR p_result->'humanReview'->'aiAppliedReadyLabel'
       IS DISTINCT FROM 'false'::jsonb
     OR p_result->'humanReview'->'claimedLabelRemoved'
       IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'runner human-review result is invalid';
  END IF;

  SELECT lease.id, lease.attempt_id, attempt.attempt_number,
         job.id, release.id, release.registration_id, release.repository
    INTO lease_id, attempt_id, attempt_number,
         runner_job_id, durable_release_id, durable_registration_id,
         durable_repository
    FROM agentops_control.job_leases lease
    JOIN agentops_control.job_attempts attempt
      ON attempt.id = lease.attempt_id
    JOIN agentops_control.jobs job ON job.id = lease.job_id
    JOIN agentops_control.releases release ON release.id = job.release_id
   WHERE lease.lease_token = p_lease_token
     AND lease.worker_id = p_worker_id
     AND lease.status = 'active'
     AND lease.expires_at > clock_timestamp()
     AND job.status = 'leased'
     AND job.job_type = 'agentops.runner'
     AND release.status = 'collecting'
     AND release.final_head IS NULL
     AND release.merge_sha IS NULL
     AND release.merge_actor IS NULL
     AND release.issue_number = (
       p_result->'humanReview'->>'issueNumber'
     )::bigint
   FOR UPDATE OF lease, attempt, job, release;
  IF NOT FOUND
     OR runner_job_id IS DISTINCT FROM (p_result->>'jobId')::uuid
     OR attempt_number IS DISTINCT FROM (p_result->>'attemptNumber')::integer
     OR durable_repository IS DISTINCT FROM p_result->>'repository' THEN
    RAISE EXCEPTION 'runner human-review lease or release is invalid';
  END IF;

  UPDATE agentops_control.releases
     SET status = 'abandoned', final_head = NULL,
         completed_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE id = durable_release_id;
  UPDATE agentops_control.job_leases
     SET status = 'completed', released_at = clock_timestamp()
   WHERE id = lease_id;
  UPDATE agentops_control.job_attempts
     SET status = 'succeeded', finished_at = clock_timestamp(),
         error = NULL, failure = NULL
   WHERE id = attempt_id;
  UPDATE agentops_control.jobs
     SET status = 'succeeded', finished_at = clock_timestamp(),
         updated_at = clock_timestamp(), last_error = NULL,
         result = p_result, failure = NULL
   WHERE id = runner_job_id;
  INSERT INTO agentops_control.runtime_audit(
    actor_type, actor_id, event_type, registration_id, job_id, details
  ) VALUES (
    'runner', p_worker_id, 'release.abandoned.human-review',
    durable_registration_id, runner_job_id,
    jsonb_build_object(
      'releaseId', durable_release_id,
      'issueNumber', (p_result->'humanReview'->>'issueNumber')::bigint,
      'reasonCount', (p_result->'humanReview'->>'reasonCount')::integer,
      'commentUrl', p_result->'humanReview'->>'commentUrl'
    )
  );
  RETURN durable_release_id;
END
$$;

-- Preserve retry identity across Registration policy changes without creating
-- a second authority receipt or hiding an existing open release.
CREATE OR REPLACE FUNCTION agentops_control.promote_triage_release_without_source_snapshot(
  p_lease_token uuid,
  p_worker_id text,
  p_result jsonb,
  p_ready_label text,
  p_claimed_label text,
  p_authority jsonb
) RETURNS TABLE (job_id uuid, release_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  triage_job_id uuid;
  current_registration_id uuid;
  current_registration_version bigint;
  current_repository text;
  current_issue_number bigint;
  configured_release_policy jsonb;
  durable_release_id uuid;
  durable_release_ids uuid[];
  durable_repository text;
  durable_release_policy jsonb;
  promoted_job_id uuid;
  authority_receipt_id uuid;
  authority_receipt_count bigint;
BEGIN
  IF p_authority IS NULL OR jsonb_typeof(p_authority) <> 'object'
     OR p_authority - ARRAY['actor', 'readyAt', 'triage'] <> '{}'::jsonb
     OR (SELECT count(*) FROM jsonb_object_keys(p_authority)) NOT BETWEEN 2 AND 3
     OR jsonb_typeof(p_authority->'actor') <> 'string'
     OR length(p_authority->>'actor') NOT BETWEEN 1 AND 128
     OR jsonb_typeof(p_authority->'readyAt') <> 'string'
     OR NOT pg_input_is_valid(
       p_authority->>'readyAt', 'timestamp with time zone'
     ) THEN
    RAISE EXCEPTION 'triage promotion authority is invalid';
  END IF;

  SELECT job.id, job.registration_id, job.registration_version,
         registration.repository,
         CASE
           WHEN jsonb_typeof(job.payload->'issue'->'number') = 'number'
             AND pg_input_is_valid(
               job.payload->'issue'->>'number', 'bigint'
             )
           THEN (job.payload->'issue'->>'number')::bigint
           ELSE NULL
         END,
         registration.configuration->'releaseEvidence'
    INTO triage_job_id, current_registration_id,
         current_registration_version, current_repository,
         current_issue_number, configured_release_policy
    FROM agentops_control.job_leases lease
    JOIN agentops_control.jobs job ON job.id = lease.job_id
    JOIN agentops_control.repository_registrations registration
      ON registration.id = job.registration_id
   WHERE lease.lease_token = p_lease_token
     AND lease.worker_id = p_worker_id
     AND lease.status = 'active'
     AND lease.expires_at > clock_timestamp()
     AND job.status = 'leased'
     AND job.job_type = 'agentops.triage'
     AND registration.enabled
     AND registration.execution_enabled
     AND registration.version = job.registration_version
   FOR UPDATE OF lease, job, registration;
  IF NOT FOUND OR current_issue_number IS NULL THEN
    RAISE EXCEPTION 'triage promotion lease is stale, lost, or malformed';
  END IF;

  SELECT array_agg(release.id ORDER BY release.id)
    INTO durable_release_ids
    FROM agentops_control.releases release
   WHERE release.registration_id = current_registration_id
     AND release.issue_number = current_issue_number
     AND release.status IN ('collecting', 'merge-authorized');

  IF cardinality(durable_release_ids) > 1 THEN
    RAISE EXCEPTION 'multiple open releases conflict for triage promotion';
  END IF;
  durable_release_id := durable_release_ids[1];

  IF durable_release_id IS NULL THEN
    RETURN QUERY
    SELECT fresh.job_id, fresh.release_id
      FROM agentops_control.promote_triage_release_new_identity(
        p_lease_token, p_worker_id, p_result,
        p_ready_label, p_claimed_label, p_authority
      ) fresh;
    RETURN;
  END IF;

  SELECT release.repository, release.policy
    INTO durable_repository, durable_release_policy
    FROM agentops_control.releases release
   WHERE release.id = durable_release_id
     AND release.status IN ('collecting', 'merge-authorized')
   FOR UPDATE;
  IF NOT FOUND
     OR durable_repository IS DISTINCT FROM current_repository
     OR jsonb_typeof(durable_release_policy) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'open release identity conflicts with triage promotion';
  END IF;

  SELECT min(receipt.receipt_id::text)::uuid, count(*)
    INTO authority_receipt_id, authority_receipt_count
    FROM agentops_control.release_receipt_outbox receipt
   WHERE receipt.release_id = durable_release_id
     AND receipt.kind = 'authority';
  IF authority_receipt_count <> 1 OR authority_receipt_id IS NULL THEN
    RAISE EXCEPTION 'open release authority receipt is absent or ambiguous';
  END IF;
  IF durable_release_policy->>'authority' = 'ai-triage-required'
     AND NOT EXISTS (
       SELECT 1
         FROM agentops_control.release_receipt_outbox receipt
        WHERE receipt.release_id = durable_release_id
          AND receipt.kind = 'runtime-provenance'
          AND authority_receipt_id = ANY(receipt.causes)
     ) THEN
    RAISE EXCEPTION 'open release AI triage provenance is absent';
  END IF;

  promoted_job_id := agentops_control.promote_triage_job(
    p_lease_token, p_worker_id, p_result - 'providerProvenance',
    p_ready_label, p_claimed_label
  );
  UPDATE agentops_control.jobs
     SET result = p_result, updated_at = clock_timestamp()
   WHERE id = triage_job_id;
  UPDATE agentops_control.jobs
     SET release_id = durable_release_id, updated_at = clock_timestamp()
   WHERE id IN (triage_job_id, promoted_job_id)
     AND jobs.registration_id = current_registration_id;
  INSERT INTO agentops_control.runtime_audit(
    actor_type, actor_id, event_type, registration_id, job_id, details
  ) VALUES (
    'triage', p_worker_id, 'release.identity.reused',
    current_registration_id, triage_job_id,
    jsonb_build_object(
      'releaseId', durable_release_id,
      'repository', current_repository,
      'issueNumber', current_issue_number,
      'registrationVersion', current_registration_version,
      'promotedJobId', promoted_job_id,
      'authorityReceiptId', authority_receipt_id,
      'configuredPolicyChanged',
        durable_release_policy IS DISTINCT FROM configured_release_policy,
      'reason', 'retry-open-release'
    )
  );
  RETURN QUERY SELECT promoted_job_id, durable_release_id;
END
$$;

CREATE FUNCTION agentops_control.promote_triage_release(
  p_lease_token uuid,
  p_worker_id text,
  p_result jsonb,
  p_ready_label text,
  p_claimed_label text,
  p_authority jsonb
) RETURNS TABLE (job_id uuid, release_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  source_issue jsonb;
  promoted_job_id uuid;
  durable_release_id uuid;
  promoted_repository text;
  promoted_issue_number bigint;
  updated_count bigint;
  calculated_digest text;
  authority_receipt_id uuid;
  requirements_receipt_id uuid;
  requirements_recorded_at timestamptz;
  existing_release_id uuid;
  existing_release_status text;
  existing_requirements_digest text;
  existing_registration_id uuid;
  existing_triage_job_id uuid;
BEGIN
  source_issue := p_authority->'sourceIssue';
  IF p_authority IS NULL OR jsonb_typeof(p_authority) <> 'object'
     OR p_authority - ARRAY['actor', 'readyAt', 'triage', 'sourceIssue']
       <> '{}'::jsonb
     OR NOT p_authority ? 'sourceIssue'
     OR jsonb_typeof(source_issue) <> 'object'
     OR source_issue - ARRAY[
       'repository', 'number', 'title', 'body', 'url', 'labels', 'comments', 'state',
       'sourceUpdatedAt', 'capturedAt', 'digest'
     ] <> '{}'::jsonb
     OR (SELECT count(*) FROM jsonb_object_keys(source_issue)) <> 11
     OR jsonb_typeof(source_issue->'repository') <> 'string'
     OR source_issue->>'repository' <> lower(source_issue->>'repository')
     OR source_issue->>'repository' !~
       '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_.-]{1,100}$'
     OR split_part(source_issue->>'repository', '/', 2) IN ('.', '..')
     OR jsonb_typeof(source_issue->'number') <> 'number'
     OR NOT pg_input_is_valid(source_issue->>'number', 'bigint')
     OR (source_issue->>'number')::bigint NOT BETWEEN 1 AND 2147483647
     OR jsonb_typeof(source_issue->'title') <> 'string'
     OR length(source_issue->>'title') > 4096
     OR jsonb_typeof(source_issue->'body') <> 'string'
     OR length(source_issue->>'body') > 1000000
     OR jsonb_typeof(source_issue->'url') <> 'string'
     OR source_issue->>'url' IS DISTINCT FROM
       'https://github.com/' || (source_issue->>'repository') || '/issues/'
         || (source_issue->>'number')
     OR jsonb_typeof(source_issue->'labels') <> 'array'
     OR jsonb_array_length(source_issue->'labels') > 100
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(source_issue->'labels') AS labels(value)
        WHERE jsonb_typeof(labels.value) <> 'string'
           OR length(labels.value #>> '{}') > 100
     )
     OR jsonb_typeof(source_issue->'comments') <> 'array'
     OR jsonb_array_length(source_issue->'comments') > 1000
     OR jsonb_typeof(source_issue->'state') <> 'string'
     OR source_issue->>'state' <> 'open'
     OR jsonb_typeof(source_issue->'sourceUpdatedAt') <> 'string'
     OR NOT pg_input_is_valid(
       source_issue->>'sourceUpdatedAt', 'timestamp with time zone'
     )
     OR jsonb_typeof(source_issue->'capturedAt') <> 'string'
     OR NOT pg_input_is_valid(
       source_issue->>'capturedAt', 'timestamp with time zone'
     )
     OR jsonb_typeof(source_issue->'digest') <> 'string'
     OR source_issue->>'digest' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'triage promotion Source Issue snapshot is invalid';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM jsonb_array_elements(source_issue->'comments') AS comments(value)
        WHERE jsonb_typeof(comments.value) <> 'object'
           OR comments.value - ARRAY['id', 'body', 'updatedAt', 'url', 'author']
             <> '{}'::jsonb
           OR CASE WHEN jsonb_typeof(comments.value) = 'object'
             THEN (SELECT count(*) FROM jsonb_object_keys(comments.value)) <> 5
             ELSE true END
           OR jsonb_typeof(comments.value->'id') <> 'number'
           OR NOT pg_input_is_valid(comments.value->>'id', 'bigint')
           OR CASE WHEN pg_input_is_valid(comments.value->>'id', 'bigint')
             THEN (comments.value->>'id')::numeric NOT BETWEEN 1 AND 9007199254740991
             ELSE true END
           OR jsonb_typeof(comments.value->'body') <> 'string'
           OR length(comments.value->>'body') > 100000
           OR jsonb_typeof(comments.value->'updatedAt') <> 'string'
           OR NOT pg_input_is_valid(
             comments.value->>'updatedAt', 'timestamp with time zone'
           )
           OR jsonb_typeof(comments.value->'url') <> 'string'
           OR length(comments.value->>'url') NOT BETWEEN 1 AND 2000
           OR jsonb_typeof(comments.value->'author') <> 'string'
           OR length(comments.value->>'author') NOT BETWEEN 1 AND 128
     )
     OR (
       SELECT COALESCE(sum(octet_length(convert_to(value->>'body', 'UTF8'))), 0)
         FROM jsonb_array_elements(source_issue->'comments') AS comments(value)
     ) > 500000 THEN
    RAISE EXCEPTION 'triage promotion Source Issue comments are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        SELECT (value->>'id')::bigint AS id,
               lag((value->>'id')::bigint) OVER (ORDER BY ordinal) AS prior_id
          FROM jsonb_array_elements(source_issue->'comments')
            WITH ORDINALITY AS comments(value, ordinal)
      ) ordered_comments
     WHERE prior_id >= id
  ) THEN
    RAISE EXCEPTION 'triage promotion Source Issue comments must have unique ascending IDs';
  END IF;

  calculated_digest := encode(sha256(convert_to(
    octet_length(convert_to(source_issue->>'repository', 'UTF8'))::text
      || ':' || (source_issue->>'repository') || '|'
      || octet_length(convert_to(source_issue->>'number', 'UTF8'))::text
      || ':' || (source_issue->>'number') || '|'
      || octet_length(convert_to(source_issue->>'title', 'UTF8'))::text
      || ':' || (source_issue->>'title') || '|'
      || octet_length(convert_to(source_issue->>'body', 'UTF8'))::text
      || ':' || (source_issue->>'body') || '|'
      || octet_length(convert_to(source_issue->>'url', 'UTF8'))::text
      || ':' || (source_issue->>'url')
      || COALESCE((
        SELECT string_agg(
          '|'
          || octet_length(convert_to(value->>'id', 'UTF8'))::text
          || ':' || (value->>'id') || '|'
          || octet_length(convert_to(value->>'body', 'UTF8'))::text
          || ':' || (value->>'body') || '|'
          || octet_length(convert_to(value->>'updatedAt', 'UTF8'))::text
          || ':' || (value->>'updatedAt') || '|'
          || octet_length(convert_to(value->>'url', 'UTF8'))::text
          || ':' || (value->>'url') || '|'
          || octet_length(convert_to(value->>'author', 'UTF8'))::text
          || ':' || (value->>'author'),
          '' ORDER BY ordinal
        )
          FROM jsonb_array_elements(source_issue->'comments')
            WITH ORDINALITY AS comments(value, ordinal)
      ), ''),
    'UTF8'
  )), 'hex');
  IF calculated_digest IS DISTINCT FROM source_issue->>'digest'
     OR (source_issue->>'sourceUpdatedAt')::timestamptz
       > (p_authority->>'readyAt')::timestamptz THEN
    RAISE EXCEPTION 'Source Issue snapshot is not bound to ready authority';
  END IF;

  -- A new human-ready snapshot is a new requirements authority. Reuse is
  -- permitted only for the exact same stable requirements digest; otherwise
  -- terminate a still-collecting identity and let the private fresh path mint
  -- a new authority receipt. A merge-authorized identity needs explicit human
  -- reconciliation and is never silently superseded.
  SELECT release.id, release.status,
         requirements.payload->>'sourceIssueDigest', job.registration_id,
         job.id
    INTO existing_release_id, existing_release_status,
         existing_requirements_digest, existing_registration_id,
         existing_triage_job_id
    FROM agentops_control.job_leases lease
    JOIN agentops_control.jobs job ON job.id = lease.job_id
    JOIN agentops_control.releases release
      ON release.registration_id = job.registration_id
     AND release.issue_number = (source_issue->>'number')::bigint
     AND release.status IN ('collecting', 'merge-authorized')
    LEFT JOIN agentops_control.release_receipt_outbox requirements
      ON requirements.release_id = release.id
     AND requirements.kind = 'requirements-authority'
   WHERE lease.lease_token = p_lease_token
     AND lease.worker_id = p_worker_id
     AND lease.status = 'active'
     AND job.job_type = 'agentops.triage'
   FOR UPDATE OF release;
  IF existing_release_id IS NOT NULL
     AND existing_requirements_digest IS DISTINCT FROM source_issue->>'digest' THEN
    IF existing_release_status <> 'collecting' THEN
      RAISE EXCEPTION
        'merge-authorized release requirements changed; human reconciliation required';
    END IF;
    UPDATE agentops_control.releases
       SET status = 'abandoned', final_head = NULL,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE id = existing_release_id AND status = 'collecting';
    INSERT INTO agentops_control.runtime_audit(
      actor_type, actor_id, event_type, registration_id, job_id, details
    ) VALUES (
      'triage', p_worker_id, 'release.abandoned.requirements-changed',
      existing_registration_id, existing_triage_job_id,
      jsonb_build_object(
        'releaseId', existing_release_id,
        'priorDigest', existing_requirements_digest,
        'nextDigest', source_issue->>'digest',
        'reason', 'new-human-ready-requirements-authority'
      )
    );
  END IF;

  SELECT promoted.job_id, promoted.release_id
    INTO promoted_job_id, durable_release_id
    FROM agentops_control.promote_triage_release_without_source_snapshot(
      p_lease_token, p_worker_id, p_result, p_ready_label, p_claimed_label,
      p_authority - 'sourceIssue'
    ) promoted;
  IF promoted_job_id IS NULL THEN
    RAISE EXCEPTION 'triage promotion did not create a runner job';
  END IF;

  SELECT registration.repository,
         (job.payload->'event'->>'number')::bigint
    INTO promoted_repository, promoted_issue_number
    FROM agentops_control.jobs job
    JOIN agentops_control.repository_registrations registration
      ON registration.id = job.registration_id
   WHERE job.id = promoted_job_id
     AND (
       durable_release_id IS NULL
       OR job.release_id = durable_release_id
     )
     AND job.job_type = 'agentops.runner'
     AND job.payload->'event'->>'kind' = 'issue'
   FOR UPDATE OF job;
  IF NOT FOUND
     OR source_issue->>'repository' IS DISTINCT FROM promoted_repository
     OR (source_issue->>'number')::bigint IS DISTINCT FROM promoted_issue_number
     OR (durable_release_id IS NOT NULL AND EXISTS (
       SELECT 1
         FROM agentops_control.jobs prior
        WHERE prior.release_id = durable_release_id
          AND prior.job_type = 'agentops.runner'
          AND prior.payload ? 'sourceIssue'
          AND prior.payload->'sourceIssue'->>'digest'
            IS DISTINCT FROM source_issue->>'digest'
     )) THEN
    RAISE EXCEPTION 'Source Issue snapshot conflicts with release identity';
  END IF;

  UPDATE agentops_control.jobs AS target
     SET payload = jsonb_set(target.payload, '{sourceIssue}', source_issue, true),
         updated_at = clock_timestamp()
   WHERE target.id = promoted_job_id
     AND (
       durable_release_id IS NULL
       OR target.release_id = durable_release_id
     )
     AND target.job_type = 'agentops.runner';
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN
    RAISE EXCEPTION 'Source Issue snapshot was not bound to promoted runner job';
  END IF;

  IF durable_release_id IS NOT NULL THEN
    SELECT receipt.receipt_id
      INTO authority_receipt_id
      FROM agentops_control.release_receipt_outbox receipt
     WHERE receipt.release_id = durable_release_id
       AND receipt.kind = 'authority';
    IF authority_receipt_id IS NULL THEN
      RAISE EXCEPTION 'Source Issue snapshot has no human-ready authority receipt';
    END IF;
    requirements_receipt_id := gen_random_uuid();
    requirements_recorded_at := clock_timestamp();
    INSERT INTO agentops_control.release_receipt_outbox(
    receipt_id, release_id, receipt_key, kind, repository, issue_number,
    head_sha, causes, payload, recorded_at
  ) VALUES (
    requirements_receipt_id, durable_release_id, 'requirements-authority',
    'requirements-authority', promoted_repository, promoted_issue_number,
    NULL, ARRAY[authority_receipt_id], jsonb_build_object(
      'receiptId', requirements_receipt_id,
      'receiptKey', 'requirements-authority',
      'releaseId', durable_release_id,
      'repository', promoted_repository,
      'issueNumber', promoted_issue_number,
      'producer', jsonb_build_object(),
      'causes', to_jsonb(ARRAY[authority_receipt_id]),
      'recordedAt', to_char(
        requirements_recorded_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'kind', 'requirements-authority',
      'sourceIssueDigest', source_issue->>'digest',
      'sourceUpdatedAt', source_issue->>'sourceUpdatedAt',
      'capturedAt', source_issue->>'capturedAt'
    ), requirements_recorded_at
    ) ON CONFLICT ON CONSTRAINT release_receipt_release_key DO NOTHING;
    IF EXISTS (
      SELECT 1 FROM agentops_control.release_receipt_outbox receipt
       WHERE receipt.release_id = durable_release_id
         AND receipt.receipt_key = 'requirements-authority'
         AND receipt.payload->>'sourceIssueDigest'
           IS DISTINCT FROM source_issue->>'digest'
    ) THEN
      RAISE EXCEPTION 'release requirements authority conflicts with Source Issue snapshot';
    END IF;
  END IF;

  RETURN QUERY SELECT promoted_job_id, durable_release_id;
END
$$;

REVOKE ALL ON FUNCTION agentops_control.promote_triage_release(
  uuid, text, jsonb, text, text, jsonb
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage') THEN
    GRANT EXECUTE ON FUNCTION agentops_control.promote_triage_release(
      uuid, text, jsonb, text, text, jsonb
    ) TO agentops_triage;
  END IF;
END
$$;

-- Legacy release abandonment cannot mutate GitHub labels from a database
-- migration. Make the stale claim and exact human recovery sequence durable
-- and visible in `mise run progress` immediately after upgrade.
WITH legacy_release_jobs AS (
  SELECT DISTINCT ON (release.id)
         release.id AS release_id, release.registration_id,
         release.issue_number, release.pull_request_number,
         registration.repository, job.id AS job_id,
         job.registration_version, attempt.id AS attempt_id,
         attempt.worker_id, audit.occurred_at,
         COALESCE((
           SELECT runner.payload->'execution'->>'claimedLabel'
             FROM agentops_control.jobs runner
            WHERE runner.release_id = release.id
              AND runner.job_type = 'agentops.runner'
            ORDER BY runner.created_at DESC, runner.id DESC
            LIMIT 1
         ), 'agent-claimed') AS claimed_label,
         COALESCE((
           SELECT runner.payload->'execution'->>'readyLabel'
             FROM agentops_control.jobs runner
            WHERE runner.release_id = release.id
              AND runner.job_type = 'agentops.runner'
            ORDER BY runner.created_at DESC, runner.id DESC
            LIMIT 1
         ), 'ready') AS ready_label
    FROM agentops_control.runtime_audit audit
    JOIN agentops_control.releases release
      ON release.id = (audit.details->>'releaseId')::uuid
    JOIN agentops_control.repository_registrations registration
      ON registration.id = release.registration_id
    JOIN agentops_control.jobs job ON job.release_id = release.id
    JOIN agentops_control.job_attempts attempt ON attempt.job_id = job.id
   WHERE audit.event_type = 'release.abandoned.requirements-upgrade'
     AND release.status = 'abandoned'
   ORDER BY release.id, attempt.attempt_number DESC, attempt.id DESC
)
INSERT INTO agentops_control.development_progress_events(
  registration_id, registration_version, job_id, attempt_id, release_id,
  repository, subject_kind, subject_number, worker_id, event_key, phase,
  step, state, summary, next_gate, blocker, pull_request_number, occurred_at
)
SELECT registration_id, registration_version, job_id, attempt_id, release_id,
       repository, 'issue', issue_number, worker_id,
       'migration:requirements-upgrade', 'human-review',
       'fresh ready-time requirements authority required', 'blocked',
       'Legacy release was abandoned safely; its GitHub claimed label remains external state',
       'human removes ' || claimed_label || ', then reapplies ' || ready_label
         || ' to freeze current requirements',
       claimed_label || ' prevents triage from observing a new ' || ready_label
         || ' event until a human removes it',
       pull_request_number, occurred_at
  FROM legacy_release_jobs
ON CONFLICT (job_id, event_key) DO NOTHING;

-- Backfill pre-v17 triage outcomes so needs-info and blocked explanations are
-- visible immediately after upgrade, not only after a new GitHub event.
WITH triage_candidates AS (
  SELECT DISTINCT ON (job.id)
         job.registration_id, job.registration_version, job.id AS job_id,
         attempt.id AS attempt_id, registration.repository,
         (job.payload->'issue'->>'number')::bigint AS subject_number,
         attempt.worker_id,
         job.result->'decision'->>'readiness' AS readiness,
         job.result->'decision'->>'summary' AS summary,
         COALESCE((
           SELECT string_agg(value, '; ' ORDER BY ordinal)
             FROM jsonb_array_elements_text(
               COALESCE(job.result->'decision'->'missingInformation', '[]'::jsonb)
             ) WITH ORDINALITY AS missing(value, ordinal)
         ), job.last_error) AS blocker,
         COALESCE(job.finished_at, attempt.finished_at, job.updated_at) AS occurred_at
    FROM agentops_control.jobs job
    JOIN agentops_control.repository_registrations registration
      ON registration.id = job.registration_id
    JOIN agentops_control.job_attempts attempt ON attempt.job_id = job.id
    LEFT JOIN agentops_control.development_progress_events progress
      ON progress.job_id = job.id
   WHERE job.job_type = 'agentops.triage'
     AND job.status IN ('succeeded', 'failed', 'cancelled', 'rejected')
     AND progress.id IS NULL
     AND pg_input_is_valid(job.payload->'issue'->>'number', 'bigint')
   ORDER BY job.id, attempt.attempt_number DESC, attempt.id DESC
)
INSERT INTO agentops_control.development_progress_events(
  registration_id, registration_version, job_id, attempt_id, release_id,
  repository, subject_kind, subject_number, worker_id, event_key, phase,
  step, state, summary, next_gate, blocker, occurred_at
)
SELECT registration_id, registration_version, job_id, attempt_id, NULL,
       repository, 'issue', subject_number, worker_id,
       'migration:triage-result',
       CASE WHEN readiness IN ('needs_info', 'blocked')
         THEN 'human-review' ELSE 'intake' END,
       CASE WHEN readiness = 'needs_info' THEN 'triage needs information'
            WHEN readiness = 'blocked' THEN 'triage blocked'
            ELSE 'triage completed' END,
       CASE WHEN readiness IN ('needs_info', 'blocked')
         THEN 'blocked' ELSE 'waiting' END,
       COALESCE(summary, 'Triage completed before durable progress reporting was installed'),
       CASE WHEN readiness IN ('needs_info', 'blocked')
         THEN 'human updates the Issue; apply ready only after the blocker is resolved'
         ELSE 'human applies the ready label' END,
       left(blocker, 1000), occurred_at
  FROM triage_candidates
 WHERE subject_number > 0
ON CONFLICT (job_id, event_key) DO NOTHING;

-- The database capability is the final merge authority. Keep the legacy
-- implementation private and require the new frozen-requirements receipt at
-- this boundary as well as in the TypeScript preflight.
ALTER FUNCTION agentops_control.authorize_release_merge(jsonb)
  RENAME TO authorize_release_merge_without_requirements;
REVOKE ALL ON FUNCTION
  agentops_control.authorize_release_merge_without_requirements(jsonb)
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    REVOKE ALL ON FUNCTION
      agentops_control.authorize_release_merge_without_requirements(jsonb)
      FROM agentops_runner;
  END IF;
END
$$;

CREATE FUNCTION agentops_control.authorize_release_merge(
  p_intent jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  durable_release_id uuid;
  authority_receipt_id uuid;
  requirements_receipt_id uuid;
  requirements_causes uuid[];
  authority_count bigint;
  requirements_count bigint;
BEGIN
  IF jsonb_typeof(p_intent) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_intent->'releaseId') IS DISTINCT FROM 'string'
     OR pg_input_is_valid(p_intent->>'releaseId', 'uuid') IS NOT TRUE
     OR jsonb_typeof(p_intent->'causes') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'merge intent requirements authority coordinates are invalid';
  END IF;
  durable_release_id := (p_intent->>'releaseId')::uuid;
  SELECT min(receipt.receipt_id::text)::uuid, count(*)
    INTO authority_receipt_id, authority_count
    FROM agentops_control.release_receipt_outbox receipt
   WHERE receipt.release_id = durable_release_id
     AND receipt.kind = 'authority';
  SELECT min(receipt.receipt_id::text)::uuid, count(*)
    INTO requirements_receipt_id, requirements_count
    FROM agentops_control.release_receipt_outbox receipt
   WHERE receipt.release_id = durable_release_id
     AND receipt.kind = 'requirements-authority';
  SELECT receipt.causes INTO requirements_causes
    FROM agentops_control.release_receipt_outbox receipt
   WHERE receipt.release_id = durable_release_id
     AND receipt.receipt_id = requirements_receipt_id;
  IF authority_count <> 1 OR authority_receipt_id IS NULL
     OR requirements_count <> 1 OR requirements_receipt_id IS NULL
     OR requirements_causes IS DISTINCT FROM ARRAY[authority_receipt_id]
     OR (p_intent->'causes' ? requirements_receipt_id::text) IS NOT TRUE THEN
    RAISE EXCEPTION
      'release lacks exactly one authority-bound requirements receipt';
  END IF;
  RETURN agentops_control.authorize_release_merge_without_requirements(p_intent);
END
$$;

REVOKE ALL ON FUNCTION agentops_control.authorize_release_merge(jsonb)
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    GRANT EXECUTE ON FUNCTION agentops_control.authorize_release_merge(jsonb)
      TO agentops_runner;
  END IF;
END
$$;
