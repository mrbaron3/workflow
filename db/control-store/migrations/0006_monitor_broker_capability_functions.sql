-- Fence the credential-bearing monitor broker behind capability-style stored
-- procedures. The runner may inspect requests, but cannot directly rewrite
-- their durable state or forge sanitized responses.

ALTER TABLE agentops_control.monitor_broker_requests
  DROP CONSTRAINT monitor_broker_lease_shape;
ALTER TABLE agentops_control.monitor_broker_requests
  ADD CONSTRAINT monitor_broker_lease_shape CHECK (
    (status = 'leased'
      AND worker_id IS NOT NULL AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND response IS NULL
      AND error_code IS NULL AND error_message IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'pending'
      AND worker_id IS NULL AND lease_token IS NULL
      AND lease_expires_at IS NULL AND response IS NULL
      AND error_code IS NULL AND error_message IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'succeeded'
      AND worker_id IS NULL AND lease_token IS NULL
      AND lease_expires_at IS NULL AND response IS NOT NULL
      AND error_code IS NULL AND error_message IS NULL
      AND completed_at IS NOT NULL)
    OR
    (status = 'failed'
      AND worker_id IS NULL AND lease_token IS NULL
      AND lease_expires_at IS NULL AND response IS NULL
      AND error_code IS NOT NULL AND completed_at IS NOT NULL)
  );

CREATE FUNCTION agentops_control.claim_monitor_broker_request(
  p_worker_id text,
  p_allowed_repository text,
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
     OR p_allowed_repository <> 'mrbaron3/workflow'
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
            candidate.repository <> p_allowed_repository
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
  SELECT 'runner', p_worker_id, 'monitor.broker.denied',
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
     WHERE request.repository = p_allowed_repository
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

CREATE FUNCTION agentops_control.complete_monitor_broker_request(
  p_request_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_response jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  result uuid;
  request_repository text;
  request_kind text;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = ''
     OR length(p_worker_id) > 256 THEN
    RAISE EXCEPTION 'invalid monitor broker worker';
  END IF;

  SELECT request.repository, request.monitor_kind
    INTO request_repository, request_kind
    FROM agentops_control.monitor_broker_requests request
   WHERE request.id = p_request_id
     AND request.lease_token = p_lease_token
     AND request.worker_id = p_worker_id
     AND request.status = 'leased'
     AND request.lease_expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_response IS NULL
     OR jsonb_typeof(p_response) <> 'object'
     OR p_response - ARRAY['items', 'nextCursor', 'observedAt'] <> '{}'::jsonb
     OR jsonb_typeof(p_response->'items') <> 'array'
     OR jsonb_array_length(p_response->'items') > 1000
     OR jsonb_typeof(p_response->'nextCursor') <> 'object'
     OR (p_response->'nextCursor') - 'updatedAfter' <> '{}'::jsonb
     OR jsonb_typeof(p_response->'nextCursor'->'updatedAfter') <> 'string'
     OR jsonb_typeof(p_response->'observedAt') <> 'string'
     OR p_response->>'observedAt'
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR NOT pg_input_is_valid(
          p_response->>'observedAt',
          'timestamp with time zone'
        )
     OR (
       p_response->'nextCursor'->>'updatedAfter' <> ''
       AND (
         p_response->'nextCursor'->>'updatedAfter'
           !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
         OR NOT pg_input_is_valid(
              p_response->'nextCursor'->>'updatedAfter',
              'timestamp with time zone'
            )
       )
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_response->'items') item
        WHERE jsonb_typeof(item) <> 'object'
          OR item - ARRAY['repository', 'kind', 'number', 'updatedAt'] <> '{}'::jsonb
          OR item->>'repository' <> request_repository
          OR item->>'kind' <> request_kind
          OR jsonb_typeof(item->'number') <> 'number'
          OR (item->>'number')::numeric <= 0
          OR (item->>'number')::numeric > 2147483647
          OR mod((item->>'number')::numeric, 1) <> 0
          OR jsonb_typeof(item->'updatedAt') <> 'string'
          OR item->>'updatedAt'
            !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
          OR NOT pg_input_is_valid(
               item->>'updatedAt',
               'timestamp with time zone'
             )
     ) THEN
    RAISE EXCEPTION 'invalid monitor broker response';
  END IF;

  UPDATE agentops_control.monitor_broker_requests request
     SET status = 'succeeded', worker_id = NULL, lease_token = NULL,
         lease_expires_at = NULL, response = p_response,
         error_code = NULL, error_message = NULL,
         completed_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE request.id = p_request_id
     AND request.lease_token = p_lease_token
     AND request.worker_id = p_worker_id
     AND request.status = 'leased'
     AND request.lease_expires_at > clock_timestamp()
  RETURNING request.registration_id INTO result;
  RETURN result;
END
$$;

CREATE FUNCTION agentops_control.fail_monitor_broker_request(
  p_request_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  result uuid;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = ''
     OR length(p_worker_id) > 256
     OR p_error_code IS NULL OR btrim(p_error_code) = ''
     OR length(p_error_code) > 128
     OR p_error_code !~ '^[a-z0-9_]+$'
     OR p_error_message IS NULL OR btrim(p_error_message) = ''
     OR length(p_error_message) > 512 THEN
    RAISE EXCEPTION 'invalid monitor broker failure';
  END IF;
  UPDATE agentops_control.monitor_broker_requests request
     SET status = 'failed', worker_id = NULL, lease_token = NULL,
         lease_expires_at = NULL, response = NULL,
         error_code = p_error_code, error_message = p_error_message,
         completed_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE request.id = p_request_id
     AND request.lease_token = p_lease_token
     AND request.worker_id = p_worker_id
     AND request.status = 'leased'
     AND request.lease_expires_at > clock_timestamp()
  RETURNING request.registration_id INTO result;
  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION
  agentops_control.claim_monitor_broker_request(text, text, uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  agentops_control.complete_monitor_broker_request(uuid, uuid, text, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  agentops_control.fail_monitor_broker_request(uuid, uuid, text, text, text)
  FROM PUBLIC;

-- Fresh installs create application roles only after migrations. Upgrades may
-- already have the runner role, so tighten it in the same migration as well.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    EXECUTE
      'REVOKE UPDATE ON agentops_control.monitor_broker_requests FROM agentops_runner';
    EXECUTE
      'GRANT EXECUTE ON FUNCTION agentops_control.claim_monitor_broker_request(text, text, uuid, integer) TO agentops_runner';
    EXECUTE
      'GRANT EXECUTE ON FUNCTION agentops_control.complete_monitor_broker_request(uuid, uuid, text, jsonb) TO agentops_runner';
    EXECUTE
      'GRANT EXECUTE ON FUNCTION agentops_control.fail_monitor_broker_request(uuid, uuid, text, text, text) TO agentops_runner';
  END IF;
END
$$;
