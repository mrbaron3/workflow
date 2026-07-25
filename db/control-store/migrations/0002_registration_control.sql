-- CISO-03 registration-driven control/supervision state.
-- PostgreSQL remains the only durable control-plane source of truth.

ALTER TABLE agentops_control.webhook_deliveries
  ADD COLUMN registration_version bigint CHECK (registration_version > 0),
  ADD COLUMN next_retry_at timestamptz;

CREATE INDEX webhook_deliveries_retry
  ON agentops_control.webhook_deliveries (next_retry_at, received_at)
  WHERE status = 'failed';

CREATE TABLE agentops_control.monitor_actual_states (
  registration_id uuid NOT NULL
    REFERENCES agentops_control.repository_registrations(id) ON DELETE CASCADE,
  component text NOT NULL CHECK (
    component IN ('issue_monitor', 'pr_monitor', 'forwarder')
  ),
  registration_version bigint NOT NULL CHECK (registration_version > 0),
  state text NOT NULL CHECK (
    state IN ('starting', 'running', 'stopped', 'failed', 'disconnected')
  ),
  supervisor_id text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_healthy_at timestamptz,
  last_error text,
  PRIMARY KEY (registration_id, component)
);
CREATE INDEX monitor_actual_states_freshness
  ON agentops_control.monitor_actual_states (observed_at);

CREATE TABLE agentops_control.control_api_requests (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status_code integer NOT NULL CHECK (status_code BETWEEN 200 AND 299),
  response jsonb NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE agentops_control.delivery_retry_attempts (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL
    REFERENCES agentops_control.webhook_deliveries(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  observed_route_attempts integer NOT NULL CHECK (observed_route_attempts >= 0),
  actor_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'rejected')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (delivery_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION agentops_control.reject_registration_stale_work()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version <> OLD.version THEN
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

CREATE TRIGGER repository_registration_reject_stale_work
AFTER UPDATE OF version ON agentops_control.repository_registrations
FOR EACH ROW
WHEN (NEW.version <> OLD.version)
EXECUTE FUNCTION agentops_control.reject_registration_stale_work();
