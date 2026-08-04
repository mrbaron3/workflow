-- Retrying a failed development job may reuse its still-open release (and PR).
-- The original promotion function always wrote a second `authority` receipt,
-- violating both the unique receipt key and the exactly-one-authority contract.
-- Keep the original fresh-release path private and wrap it with an explicit
-- open-release recovery path that reuses the already-certified authority.

ALTER FUNCTION agentops_control.promote_triage_release(
  uuid, text, jsonb, text, text, jsonb
) RENAME TO promote_triage_release_new_identity;

REVOKE ALL ON FUNCTION agentops_control.promote_triage_release_new_identity(
  uuid, text, jsonb, text, text, jsonb
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage') THEN
    REVOKE ALL ON FUNCTION
      agentops_control.promote_triage_release_new_identity(
        uuid, text, jsonb, text, text, jsonb
      ) FROM agentops_triage;
  END IF;
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
  triage_job_id uuid;
  current_registration_id uuid;
  current_registration_version bigint;
  current_repository text;
  current_issue_number bigint;
  release_policy jsonb;
  durable_release_id uuid;
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
         current_issue_number, release_policy
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

  SELECT release.id
    INTO durable_release_id
    FROM agentops_control.releases release
   WHERE release.registration_id = current_registration_id
     AND release.repository = current_repository
     AND release.issue_number = current_issue_number
     AND release.policy = release_policy
     AND release.status IN ('collecting', 'merge-authorized')
   FOR UPDATE;

  IF durable_release_id IS NULL THEN
    RETURN QUERY
    SELECT fresh.job_id, fresh.release_id
      FROM agentops_control.promote_triage_release_new_identity(
        p_lease_token, p_worker_id, p_result,
        p_ready_label, p_claimed_label, p_authority
      ) fresh;
    RETURN;
  END IF;

  SELECT min(receipt.receipt_id::text)::uuid, count(*)
    INTO authority_receipt_id, authority_receipt_count
    FROM agentops_control.release_receipt_outbox receipt
   WHERE receipt.release_id = durable_release_id
     AND receipt.kind = 'authority';
  IF authority_receipt_count <> 1 OR authority_receipt_id IS NULL THEN
    RAISE EXCEPTION 'open release authority receipt is absent or ambiguous';
  END IF;
  IF release_policy->>'authority' = 'ai-triage-required'
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
      'reason', 'retry-open-release'
    )
  );
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
