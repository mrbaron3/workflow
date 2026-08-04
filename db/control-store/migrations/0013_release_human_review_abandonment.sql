-- A planning WHAT stop is a successful runner outcome, but it cannot keep the
-- release identity open: a later human-ready signal authorizes a different
-- source snapshot and therefore needs a fresh authority receipt and release.
ALTER TABLE agentops_control.releases
  DROP CONSTRAINT releases_status_check,
  DROP CONSTRAINT releases_state_shape;

ALTER TABLE agentops_control.releases
  ADD CONSTRAINT releases_status_check
    CHECK (status IN ('collecting', 'merge-authorized', 'merged', 'abandoned')),
  ADD CONSTRAINT releases_state_shape CHECK (
    (status = 'collecting'
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
      AND pull_request_number IS NULL AND final_head IS NULL
      AND merge_sha IS NULL AND merge_actor IS NULL
      AND completed_at IS NOT NULL)
  );

-- Repair releases left open by pre-v13 successful planning human-review jobs.
WITH candidates AS (
  SELECT DISTINCT ON (release.id)
         release.id, release.registration_id, job.id AS job_id,
         COALESCE(job.finished_at, clock_timestamp()) AS completed_at
    FROM agentops_control.releases release
    JOIN agentops_control.jobs job ON job.release_id = release.id
   WHERE release.status = 'collecting'
     AND release.pull_request_number IS NULL
     AND release.final_head IS NULL
     AND job.job_type = 'agentops.runner'
     AND job.status = 'succeeded'
     AND job.result->>'outcome' = 'needs-human-review'
   ORDER BY release.id, job.finished_at DESC NULLS LAST, job.id DESC
), abandoned AS (
  UPDATE agentops_control.releases release
     SET status = 'abandoned',
         completed_at = candidate.completed_at,
         updated_at = clock_timestamp()
    FROM candidates candidate
   WHERE release.id = candidate.id
  RETURNING release.id, release.registration_id
)
INSERT INTO agentops_control.runtime_audit(
  actor_type, actor_id, event_type, registration_id, job_id, details
)
SELECT 'system', 'migration-0013', 'release.abandoned.human-review',
       abandoned.registration_id, candidate.job_id,
       jsonb_build_object(
         'releaseId', abandoned.id,
         'reason', 'backfilled-needs-human-review'
       )
  FROM abandoned
  JOIN candidates candidate ON candidate.id = abandoned.id;

CREATE FUNCTION agentops_control.complete_runner_human_review(
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
BEGIN
  IF p_result->>'status' <> 'succeeded'
     OR p_result->>'outcome' <> 'needs-human-review'
     OR p_result->'headSha' IS DISTINCT FROM 'null'::jsonb
     OR p_result->'pullRequestNumber' IS DISTINCT FROM 'null'::jsonb
     OR jsonb_typeof(p_result->'humanReview') <> 'object'
     OR p_result->'humanReview'->>'classification' <> 'what-judgment'
     OR p_result->'humanReview'->>'howIntervention' <> 'false'
     OR p_result->'humanReview'->>'aiAppliedReadyLabel' <> 'false'
     OR p_result->'humanReview'->>'claimedLabelRemoved' <> 'true'
     OR NOT pg_input_is_valid(p_result->>'jobId', 'uuid')
     OR NOT pg_input_is_valid(
       p_result->'humanReview'->>'issueNumber', 'bigint'
     ) THEN
    RAISE EXCEPTION 'runner human-review result is invalid';
  END IF;

  SELECT lease.id, lease.attempt_id, attempt.attempt_number,
         job.id, release.id, release.registration_id
    INTO lease_id, attempt_id, attempt_number,
         runner_job_id, durable_release_id, durable_registration_id
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
     AND release.pull_request_number IS NULL
     AND release.final_head IS NULL
     AND release.merge_sha IS NULL
     AND release.merge_actor IS NULL
     AND release.issue_number = (
       p_result->'humanReview'->>'issueNumber'
     )::bigint
   FOR UPDATE OF lease, attempt, job, release;
  IF NOT FOUND
     OR runner_job_id::text <> p_result->>'jobId'
     OR attempt_number <> (p_result->>'attemptNumber')::integer THEN
    RAISE EXCEPTION 'runner human-review lease or release is invalid';
  END IF;

  UPDATE agentops_control.releases
     SET status = 'abandoned', completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
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

REVOKE ALL ON FUNCTION agentops_control.complete_runner_human_review(
  uuid, text, jsonb
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    GRANT EXECUTE ON FUNCTION
      agentops_control.complete_runner_human_review(uuid, text, jsonb)
      TO agentops_runner;
  END IF;
END
$$;
