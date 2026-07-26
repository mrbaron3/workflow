-- CISO-07 typed private-repository monitor broker.
-- Control never receives the runner GitHub credential. It submits one durable,
-- typed issue/PR read request; runner returns only validated work identities
-- and cursor timestamps. There is no generic HTTP/GitHub proxy.

CREATE TABLE agentops_control.monitor_broker_requests (
  id uuid PRIMARY KEY,
  registration_id uuid NOT NULL
    REFERENCES agentops_control.repository_registrations(id) ON DELETE CASCADE,
  registration_version bigint NOT NULL CHECK (registration_version > 0),
  repository text NOT NULL CHECK (
    repository = lower(repository)
    AND repository ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
  ),
  monitor_kind text NOT NULL CHECK (
    monitor_kind IN ('issue', 'pull_request')
  ),
  cursor jsonb NOT NULL CHECK (
    jsonb_typeof(cursor) = 'object'
    AND cursor - 'updatedAfter' = '{}'::jsonb
    AND jsonb_typeof(cursor -> 'updatedAfter') = 'string'
  ),
  cursor_sha256 text NOT NULL CHECK (cursor_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'leased', 'succeeded', 'failed')
  ),
  worker_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  response jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT monitor_broker_lease_shape CHECK (
    (status = 'leased'
      AND worker_id IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND response IS NULL
      AND error_code IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'pending'
      AND worker_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND response IS NULL
      AND error_code IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'succeeded'
      AND response IS NOT NULL
      AND error_code IS NULL
      AND completed_at IS NOT NULL)
    OR
    (status = 'failed'
      AND response IS NULL
      AND error_code IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX monitor_broker_one_active_cursor
  ON agentops_control.monitor_broker_requests(
    registration_id, registration_version, monitor_kind, cursor_sha256
  )
  WHERE status IN ('pending', 'leased');

CREATE INDEX monitor_broker_claim_order
  ON agentops_control.monitor_broker_requests(created_at, id)
  WHERE status IN ('pending', 'leased');

CREATE INDEX monitor_broker_audit_order
  ON agentops_control.monitor_broker_requests(
    registration_id, monitor_kind, created_at DESC
  );
