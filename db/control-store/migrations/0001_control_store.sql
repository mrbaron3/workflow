-- CISO-02 PostgreSQL control-plane schema.
-- This file is the language-neutral contract consumed by the current TypeScript
-- runtime and the future Go control plane. Large artifacts never belong here.

CREATE SCHEMA IF NOT EXISTS agentops_control;

CREATE TABLE agentops_control.repository_registrations (
  id uuid PRIMARY KEY,
  repository text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  issue_monitor_enabled boolean NOT NULL DEFAULT true,
  pr_monitor_enabled boolean NOT NULL DEFAULT true,
  execution_enabled boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT repository_registrations_canonical_name
    CHECK (repository = lower(repository) AND repository ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  CONSTRAINT repository_registrations_repository_key UNIQUE (repository)
);

CREATE TABLE agentops_control.monitor_cursors (
  registration_id uuid NOT NULL
    REFERENCES agentops_control.repository_registrations(id) ON DELETE CASCADE,
  monitor_kind text NOT NULL CHECK (monitor_kind IN ('issue', 'pull_request')),
  cursor jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (registration_id, monitor_kind)
);

CREATE TABLE agentops_control.webhook_deliveries (
  id uuid PRIMARY KEY,
  delivery_key text NOT NULL,
  repository text NOT NULL,
  registration_id uuid
    REFERENCES agentops_control.repository_registrations(id) ON DELETE SET NULL,
  event text NOT NULL,
  action text,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'ignored', 'failed')),
  ignored_reason text,
  last_error text,
  route_attempts integer NOT NULL DEFAULT 0 CHECK (route_attempts >= 0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webhook_deliveries_delivery_key_key UNIQUE (delivery_key),
  CONSTRAINT webhook_deliveries_canonical_repository
    CHECK (repository = lower(repository))
);

CREATE TABLE agentops_control.webhook_consumers (
  delivery_id uuid NOT NULL
    REFERENCES agentops_control.webhook_deliveries(id) ON DELETE CASCADE,
  consumer text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (delivery_id, consumer)
);

CREATE TABLE agentops_control.jobs (
  id uuid PRIMARY KEY,
  registration_id uuid NOT NULL
    REFERENCES agentops_control.repository_registrations(id) ON DELETE RESTRICT,
  registration_version bigint NOT NULL CHECK (registration_version > 0),
  contract_version integer NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  source_kind text NOT NULL CHECK (source_kind IN ('webhook', 'poll', 'manual', 'recovery')),
  source_key text NOT NULL,
  idempotency_key text NOT NULL,
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled', 'rejected')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  last_error text,
  CONSTRAINT jobs_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT jobs_source_key_key UNIQUE (source_kind, source_key)
);

-- The database, not merely the runtime, guarantees repository single-flight.
CREATE UNIQUE INDEX jobs_one_active_per_repository
  ON agentops_control.jobs (registration_id)
  WHERE status IN ('queued', 'leased');
CREATE INDEX jobs_reconciliation_queue
  ON agentops_control.jobs (available_at, created_at)
  WHERE status = 'queued';

CREATE TABLE agentops_control.job_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES agentops_control.jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('running', 'succeeded', 'failed', 'timed_out', 'cancelled')
  ),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  error text,
  CONSTRAINT job_attempts_job_number_key UNIQUE (job_id, attempt_number)
);

CREATE TABLE agentops_control.job_leases (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES agentops_control.jobs(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL UNIQUE
    REFERENCES agentops_control.job_attempts(id) ON DELETE CASCADE,
  lease_token uuid NOT NULL UNIQUE,
  worker_id text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'expired', 'released')),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CHECK (expires_at > acquired_at)
);
CREATE UNIQUE INDEX job_leases_one_active_per_job
  ON agentops_control.job_leases (job_id)
  WHERE status = 'active';
CREATE INDEX job_leases_expiry ON agentops_control.job_leases (expires_at)
  WHERE status = 'active';

CREATE TABLE agentops_control.runtime_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  event_type text NOT NULL,
  registration_id uuid
    REFERENCES agentops_control.repository_registrations(id) ON DELETE SET NULL,
  job_id uuid REFERENCES agentops_control.jobs(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX runtime_audit_registration_time
  ON agentops_control.runtime_audit (registration_id, occurred_at DESC);
CREATE INDEX runtime_audit_job_time
  ON agentops_control.runtime_audit (job_id, occurred_at DESC);

CREATE TABLE agentops_control.artifact_links (
  id uuid PRIMARY KEY,
  job_id uuid REFERENCES agentops_control.jobs(id) ON DELETE CASCADE,
  attempt_id uuid REFERENCES agentops_control.job_attempts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  uri text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (job_id IS NOT NULL OR attempt_id IS NOT NULL)
);

CREATE TABLE agentops_control.released_builds (
  id uuid PRIMARY KEY,
  registration_id uuid NOT NULL
    REFERENCES agentops_control.repository_registrations(id) ON DELETE RESTRICT,
  issue_number bigint,
  pull_request_number bigint,
  revision_id text NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40,64}$'),
  panel_approved boolean NOT NULL,
  gate_returned boolean NOT NULL DEFAULT false,
  released_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT released_builds_revision_key
    UNIQUE (registration_id, revision_id, head_sha)
);

-- Review-time oracle mismatches (#18) and post-release escapes (#21) share
-- calibration semantics while retaining their observation stage.
CREATE TABLE agentops_control.build_defects (
  id uuid PRIMARY KEY,
  build_id uuid NOT NULL
    REFERENCES agentops_control.released_builds(id) ON DELETE CASCADE,
  defect_key text NOT NULL,
  observation_stage text NOT NULL
    CHECK (observation_stage IN ('review_oracle', 'release_escape')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  issue_url text,
  summary text NOT NULL,
  discovered_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT build_defects_build_key UNIQUE (build_id, defect_key)
);
CREATE INDEX build_defects_build_stage
  ON agentops_control.build_defects (build_id, observation_stage);

CREATE OR REPLACE FUNCTION agentops_control.notify_control_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(TG_ARGV[0], json_build_object(
    'table', TG_TABLE_NAME,
    'operation', TG_OP,
    'id', COALESCE(NEW.id::text, OLD.id::text)
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER repository_registration_wake
AFTER INSERT OR UPDATE OR DELETE ON agentops_control.repository_registrations
FOR EACH ROW EXECUTE FUNCTION agentops_control.notify_control_change('agentops_registration_wake');

CREATE TRIGGER job_queue_wake
AFTER INSERT OR UPDATE ON agentops_control.jobs
FOR EACH ROW EXECUTE FUNCTION agentops_control.notify_control_change('agentops_job_wake');
