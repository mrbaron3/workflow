-- Durable, operator-facing issue progress. Runtime logs remain diagnostics;
-- this table is the resumable source for CLI and Dashboard projections.
CREATE TABLE agentops_control.development_progress_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id uuid NOT NULL
    REFERENCES agentops_control.repository_registrations(id) ON DELETE CASCADE,
  registration_version bigint NOT NULL CHECK (registration_version > 0),
  job_id uuid NOT NULL REFERENCES agentops_control.jobs(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL
    REFERENCES agentops_control.job_attempts(id) ON DELETE CASCADE,
  release_id uuid REFERENCES agentops_control.releases(id) ON DELETE SET NULL,
  repository text NOT NULL,
  subject_kind text NOT NULL
    CHECK (subject_kind IN ('issue', 'pull_request', 'repository')),
  subject_number bigint CHECK (subject_number IS NULL OR subject_number > 0),
  worker_id text NOT NULL,
  event_key text NOT NULL CHECK (
    length(event_key) BETWEEN 1 AND 200
    AND event_key ~ '^[a-z0-9][a-z0-9:._/-]*$'
  ),
  phase text NOT NULL CHECK (phase IN (
    'intake', 'planning', 'design', 'generation', 'validation', 'review',
    'pull-request', 'merge', 'human-review', 'completed', 'failed'
  )),
  step text NOT NULL CHECK (length(step) BETWEEN 1 AND 160),
  state text NOT NULL CHECK (
    state IN ('pending', 'running', 'waiting', 'blocked', 'succeeded', 'failed')
  ),
  summary text CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 1000),
  next_gate text CHECK (next_gate IS NULL OR length(next_gate) BETWEEN 1 AND 500),
  blocker text CHECK (blocker IS NULL OR length(blocker) BETWEEN 1 AND 1000),
  session_name text CHECK (
    session_name IS NULL OR length(session_name) BETWEEN 1 AND 250
  ),
  worktree_path text CHECK (
    worktree_path IS NULL OR length(worktree_path) BETWEEN 1 AND 2000
  ),
  branch text CHECK (branch IS NULL OR length(branch) BETWEEN 1 AND 500),
  pull_request_number bigint CHECK (
    pull_request_number IS NULL OR pull_request_number > 0
  ),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT development_progress_job_event_key UNIQUE (job_id, event_key),
  CONSTRAINT development_progress_subject_shape CHECK (
    (subject_kind = 'repository' AND subject_number IS NULL)
    OR (subject_kind IN ('issue', 'pull_request') AND subject_number IS NOT NULL)
  )
);

CREATE INDEX development_progress_subject_time
  ON agentops_control.development_progress_events(
    repository, subject_kind, subject_number, occurred_at DESC, id DESC
  );
CREATE INDEX development_progress_registration_time
  ON agentops_control.development_progress_events(
    registration_id, occurred_at DESC, id DESC
  );

-- The runner may only report progress for its own currently-live lease. All
-- repository, Issue, Job, attempt, and release identities are derived in SQL.
CREATE FUNCTION agentops_control.record_development_progress(
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
       'sessionName', 'worktreePath', 'branch', 'pullRequestNumber'
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
     ) THEN
    RAISE EXCEPTION 'development progress event is invalid';
  END IF;

  SELECT registration.id, job.registration_version, job.id, attempt.id,
         release.id, registration.repository,
         CASE
           WHEN release.issue_number IS NOT NULL THEN 'issue'
           ELSE job.payload->'event'->>'kind'
         END,
         COALESCE(
           release.issue_number,
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
     AND job.job_type = 'agentops.runner';
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
    branch, pull_request_number
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
      THEN NULL ELSE (p_event->>'pullRequestNumber')::bigint END
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
    GRANT SELECT ON agentops_control.development_progress_events
      TO agentops_runner;
    GRANT EXECUTE ON FUNCTION agentops_control.record_development_progress(
      uuid, text, jsonb
    ) TO agentops_runner;
  END IF;
END
$$;

-- Preserve a truthful minimum projection for work already active when v14 is
-- installed. New runners immediately replace this with phase-specific events.
INSERT INTO agentops_control.development_progress_events(
  registration_id, registration_version, job_id, attempt_id, release_id,
  repository, subject_kind, subject_number, worker_id, event_key, phase,
  step, state, summary, next_gate
)
SELECT job.registration_id, job.registration_version, job.id, attempt.id,
       release.id, registration.repository,
       CASE WHEN release.issue_number IS NOT NULL THEN 'issue'
            ELSE job.payload->'event'->>'kind' END,
       COALESCE(
         release.issue_number,
         CASE WHEN job.payload->'event'->>'kind' <> 'repository'
           THEN (job.payload->'event'->>'number')::bigint END
       ),
       lease.worker_id, 'migration:active-lease', 'intake', 'runner lease active',
       'running', 'Detailed phase predates durable progress reporting',
       'runner will publish the next phase transition'
  FROM agentops_control.jobs job
  JOIN agentops_control.repository_registrations registration
    ON registration.id = job.registration_id
  JOIN agentops_control.job_leases lease
    ON lease.job_id = job.id AND lease.status = 'active'
  JOIN agentops_control.job_attempts attempt ON attempt.id = lease.attempt_id
  LEFT JOIN agentops_control.releases release ON release.id = job.release_id
 WHERE job.status = 'leased'
   AND job.job_type = 'agentops.runner'
   AND lease.expires_at > clock_timestamp()
   AND (
     release.issue_number IS NOT NULL
     OR job.payload->'event'->>'kind' = 'repository'
     OR pg_input_is_valid(job.payload->'event'->>'number', 'bigint')
   )
ON CONFLICT (job_id, event_key) DO NOTHING;
