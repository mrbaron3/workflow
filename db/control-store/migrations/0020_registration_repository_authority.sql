-- Repository scope is selected from the durable Registration on each claim.
-- No process-startup environment allowlist is a second source of truth.
DROP FUNCTION agentops_control.claim_monitor_broker_request(
  text, text[], uuid, integer
);

CREATE FUNCTION agentops_control.claim_monitor_broker_request(
  p_worker_id text,
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
     OR p_lease_token IS NULL
     OR p_lease_ms IS NULL OR p_lease_ms < 5000 OR p_lease_ms > 60000 THEN
    RAISE EXCEPTION 'invalid monitor broker claim';
  END IF;

  WITH rejected AS (
    UPDATE agentops_control.monitor_broker_requests request
       SET status = 'failed', worker_id = NULL, lease_token = NULL,
           lease_expires_at = NULL, response = NULL,
           error_code = 'stale_registration',
           error_message = 'registration is stale, disabled, or no longer enables this monitor',
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE request.id IN (
       SELECT candidate.id
         FROM agentops_control.monitor_broker_requests candidate
        WHERE candidate.status IN ('pending', 'leased')
          AND (candidate.status = 'pending'
            OR candidate.lease_expires_at <= clock_timestamp())
          AND NOT EXISTS (
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
        FOR UPDATE SKIP LOCKED
     )
    RETURNING request.id, request.registration_id
  )
  INSERT INTO agentops_control.runtime_audit(
    actor_type, actor_id, event_type, registration_id, details
  )
  SELECT 'triage', p_worker_id, 'monitor.broker.denied',
         rejected.registration_id,
         jsonb_build_object(
           'requestId', rejected.id,
           'reason', 'stale_registration'
         )
    FROM rejected;

  RETURN QUERY
  WITH candidate AS (
    SELECT request.id
      FROM agentops_control.monitor_broker_requests request
      JOIN agentops_control.repository_registrations registration
        ON registration.id = request.registration_id
       AND registration.version = request.registration_version
       AND registration.repository = request.repository
     WHERE registration.enabled
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
  agentops_control.claim_monitor_broker_request(text, uuid, integer)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage') THEN
    GRANT EXECUTE ON FUNCTION
      agentops_control.claim_monitor_broker_request(text, uuid, integer)
      TO agentops_triage;
  END IF;
END
$$;

-- A fresh Servo control store starts with exactly one target. The insert is
-- idempotent for upgraded stores and never changes another registration.
WITH inserted AS (
  INSERT INTO agentops_control.repository_registrations(
    id, repository, enabled, issue_monitor_enabled, pr_monitor_enabled,
    execution_enabled, configuration
  )
  SELECT gen_random_uuid(), 'mrbaron3/servo', true, true, true, true,
         '{
           "releaseEvidence": {
             "authority": "ai-triage-required",
             "requiredGateSignals": [
               {"source":"repository-grader","name":"build"},
               {"source":"repository-grader","name":"typecheck"},
               {"source":"repository-grader","name":"unit_tests"},
               {"source":"repository-grader","name":"secrets_scan"},
               {"source":"repository-grader","name":"scope_check"}
             ],
             "requiredReviewPerspectives": [
               "functionality", "codeQuality", "testQuality", "ux",
               "accessibility", "security", "type-design"
             ],
             "minimumHeadEpochs": 1
           },
           "gateTimeoutSeconds": {"default":3600}
         }'::jsonb
   WHERE NOT EXISTS (
     SELECT 1 FROM agentops_control.repository_registrations
      WHERE repository = 'mrbaron3/servo'
   )
  RETURNING id
)
INSERT INTO agentops_control.runtime_audit(
  actor_type, actor_id, event_type, registration_id, details
)
SELECT 'system', 'migration-0020', 'registration.seeded', inserted.id,
       '{"repository":"mrbaron3/servo","source":"durable-bootstrap"}'::jsonb
  FROM inserted;
