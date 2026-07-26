-- CISO-06 agentopsctl lifecycle authority.
-- PostgreSQL remains the only durable source of truth for operating mode,
-- transition idempotency, drain deadlines, and lifecycle audit.

CREATE TABLE agentops_control.lifecycle_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL CHECK (
    mode IN ('OFF', 'MONITOR_ONLY', 'ACTIVE', 'DRAINING')
  ),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  transition_id uuid,
  transition_started_at timestamptz,
  drain_deadline_at timestamptz,
  drain_timed_out boolean NOT NULL DEFAULT false,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO agentops_control.lifecycle_state(singleton, mode)
VALUES (true, 'OFF');

CREATE TABLE agentops_control.lifecycle_transitions (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  actor_id text NOT NULL,
  from_mode text NOT NULL CHECK (
    from_mode IN ('OFF', 'MONITOR_ONLY', 'ACTIVE', 'DRAINING')
  ),
  to_mode text NOT NULL CHECK (
    to_mode IN ('OFF', 'MONITOR_ONLY', 'ACTIVE', 'DRAINING')
  ),
  status text NOT NULL CHECK (
    status IN ('applied', 'idempotent', 'rejected', 'compensated')
  ),
  drain_deadline_at timestamptz,
  error text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX lifecycle_transitions_time
  ON agentops_control.lifecycle_transitions (started_at DESC, id DESC);

-- The lifecycle row is the authoritative race fence. A stale ACTIVE control
-- process cannot enqueue after DRAINING/OFF has committed.
CREATE OR REPLACE FUNCTION agentops_control.require_active_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM agentops_control.lifecycle_state
     WHERE singleton AND mode = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'lifecycle mode does not permit new jobs'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_require_active_lifecycle
BEFORE INSERT ON agentops_control.jobs
FOR EACH ROW EXECUTE FUNCTION agentops_control.require_active_lifecycle();
