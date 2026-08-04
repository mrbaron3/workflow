-- First-class current-head review and gate facts for the operator projection.
-- Existing progress rows remain valid; all additions are nullable and forward
-- compatible. Raw events stay immutable history while the control plane folds
-- them with job, lease, release, and escalation state.
CREATE OR REPLACE FUNCTION agentops_control.valid_release_evidence_configuration(
  value jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  policy jsonb;
  gate_timeouts jsonb;
  gate_key text;
  item jsonb;
  numeric_value numeric;
BEGIN
  IF jsonb_typeof(value) <> 'object'
     OR value - ARRAY['releaseEvidence', 'gateTimeoutSeconds'] <> '{}'::jsonb THEN
    RETURN false;
  END IF;
  IF value ? 'gateTimeoutSeconds' THEN
    gate_timeouts := value->'gateTimeoutSeconds';
    IF jsonb_typeof(gate_timeouts) <> 'object'
       OR gate_timeouts - ARRAY[
         'default', 'planning', 'design', 'repository-graders', 'review',
         'merge', 'lease-recovery'
       ] <> '{}'::jsonb THEN
      RETURN false;
    END IF;
    FOR gate_key IN SELECT * FROM jsonb_object_keys(gate_timeouts)
    LOOP
      IF jsonb_typeof(gate_timeouts->gate_key) <> 'number' THEN
        RETURN false;
      END IF;
      numeric_value := (gate_timeouts->>gate_key)::numeric;
      IF numeric_value NOT BETWEEN 60 AND 2592000
         OR mod(numeric_value, 1) <> 0 THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;
  IF NOT (value ? 'releaseEvidence') THEN
    RETURN true;
  END IF;
  policy := value->'releaseEvidence';
  IF jsonb_typeof(policy) <> 'object'
     OR policy - ARRAY[
       'authority', 'requiredGateSignals',
       'requiredReviewPerspectives', 'minimumHeadEpochs'
     ] <> '{}'::jsonb
     OR (SELECT count(*) FROM jsonb_object_keys(policy)) <> 4
     OR policy->>'authority' NOT IN (
       'human-ready-allowed', 'ai-triage-required'
     )
     OR jsonb_typeof(policy->'requiredGateSignals') <> 'array'
     OR jsonb_array_length(policy->'requiredGateSignals') NOT BETWEEN 1 AND 64
     OR jsonb_typeof(policy->'requiredReviewPerspectives') <> 'array'
     OR jsonb_array_length(
       policy->'requiredReviewPerspectives'
     ) NOT BETWEEN 2 AND 7
     OR jsonb_typeof(policy->'minimumHeadEpochs') <> 'number' THEN
    RETURN false;
  END IF;
  numeric_value := (policy->>'minimumHeadEpochs')::numeric;
  IF numeric_value NOT BETWEEN 1 AND 32 OR mod(numeric_value, 1) <> 0 THEN
    RETURN false;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(policy->'requiredGateSignals')
  LOOP
    IF jsonb_typeof(item) <> 'object'
       OR item - ARRAY['source', 'name'] <> '{}'::jsonb
       OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 2
       OR item->>'source' NOT IN ('repository-grader', 'github-check')
       OR jsonb_typeof(item->'name') <> 'string'
       OR length(item->>'name') NOT BETWEEN 1 AND 128 THEN
      RETURN false;
    END IF;
  END LOOP;
  FOR item IN SELECT * FROM jsonb_array_elements(
    policy->'requiredReviewPerspectives'
  )
  LOOP
    IF jsonb_typeof(item) <> 'string'
       OR (item #>> '{}') NOT IN (
         'functionality', 'codeQuality', 'testQuality', 'ux',
         'accessibility', 'security', 'type-design'
       ) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

ALTER TABLE agentops_control.development_progress_events
  ADD COLUMN head_sha text CHECK (
    head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
  ),
  ADD COLUMN review_round integer CHECK (
    review_round IS NULL OR review_round BETWEEN 1 AND 1000
  ),
  ADD COLUMN review_outcome text CHECK (
    review_outcome IS NULL OR review_outcome IN (
      'pending', 'running', 'approve', 'request-changes', 'escalated'
    )
  ),
  ADD COLUMN gate_key text CHECK (
    gate_key IS NULL OR gate_key IN (
      'planning', 'design', 'repository-graders', 'review', 'merge',
      'lease-recovery'
    )
  ),
  ADD COLUMN human_action text CHECK (
    human_action IS NULL OR length(human_action) BETWEEN 1 AND 1000
  );

ALTER TABLE agentops_control.development_progress_events
  DROP CONSTRAINT development_progress_events_phase_check;
ALTER TABLE agentops_control.development_progress_events
  ADD CONSTRAINT development_progress_events_phase_check CHECK (phase IN (
    'intake', 'planning', 'design', 'generation', 'validation', 'review',
    'repair', 'pull-request', 'merge', 'human-review', 'completed', 'failed'
  ));

CREATE TABLE agentops_control.human_escalations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id uuid NOT NULL
    REFERENCES agentops_control.repository_registrations(id) ON DELETE CASCADE,
  registration_version bigint NOT NULL CHECK (registration_version > 0),
  job_id uuid NOT NULL REFERENCES agentops_control.jobs(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL
    REFERENCES agentops_control.job_attempts(id) ON DELETE CASCADE,
  release_id uuid REFERENCES agentops_control.releases(id) ON DELETE SET NULL,
  repository text NOT NULL,
  subject_kind text NOT NULL CHECK (
    subject_kind IN ('issue', 'pull_request', 'repository')
  ),
  subject_number bigint CHECK (subject_number IS NULL OR subject_number > 0),
  gate_key text NOT NULL CHECK (gate_key IN (
    'planning', 'design', 'repository-graders', 'review', 'merge',
    'lease-recovery'
  )),
  target_sha text CHECK (
    target_sha IS NULL OR target_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
  ),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  human_action text NOT NULL CHECK (length(human_action) BETWEEN 1 AND 1000),
  gate_entered_at timestamptz NOT NULL,
  escalated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CONSTRAINT human_escalation_subject_shape CHECK (
    (subject_kind = 'repository' AND subject_number IS NULL)
    OR (subject_kind IN ('issue', 'pull_request') AND subject_number IS NOT NULL)
  )
);

-- NULL target heads still have a stable one-shot identity. A later concrete
-- head is a different gate observation and may legitimately escalate once.
CREATE UNIQUE INDEX human_escalations_one_shot
  ON agentops_control.human_escalations(
    job_id, gate_key, COALESCE(target_sha, '')
  );
CREATE INDEX human_escalations_open_subject
  ON agentops_control.human_escalations(
    registration_id, subject_kind, subject_number, escalated_at DESC
  ) WHERE resolved_at IS NULL;

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
       'parentIssueNumber', 'headSha', 'reviewRound', 'reviewOutcome',
       'gateKey', 'humanAction'
     ] <> '{}'::jsonb
     OR length(p_event->>'eventKey') NOT BETWEEN 1 AND 200
     OR (p_event->>'eventKey') !~ '^[a-z0-9][a-z0-9:._/-]*$'
     OR p_event->>'phase' NOT IN (
       'intake', 'planning', 'design', 'generation', 'validation', 'review',
       'repair', 'pull-request', 'merge', 'human-review', 'completed', 'failed'
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
     OR length(COALESCE(p_event->>'humanAction', 'x')) NOT BETWEEN 1 AND 1000
     OR (
       p_event ? 'headSha' AND p_event->'headSha' <> 'null'::jsonb
       AND (p_event->>'headSha') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     )
     OR (
       p_event ? 'reviewRound' AND p_event->'reviewRound' <> 'null'::jsonb
       AND (
         jsonb_typeof(p_event->'reviewRound') <> 'number'
         OR NOT pg_input_is_valid(p_event->>'reviewRound', 'integer')
         OR (p_event->>'reviewRound')::integer NOT BETWEEN 1 AND 1000
       )
     )
     OR (
       p_event ? 'reviewOutcome' AND p_event->'reviewOutcome' <> 'null'::jsonb
       AND p_event->>'reviewOutcome' NOT IN (
         'pending', 'running', 'approve', 'request-changes', 'escalated'
       )
     )
     OR (
       p_event ? 'gateKey' AND p_event->'gateKey' <> 'null'::jsonb
       AND p_event->>'gateKey' NOT IN (
         'planning', 'design', 'repository-graders', 'review', 'merge',
         'lease-recovery'
       )
     )
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
             THEN (job.payload->'event'->>'number')::bigint END
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
    branch, pull_request_number, parent_issue_number, head_sha, review_round,
    review_outcome, gate_key, human_action
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
      THEN NULL ELSE (p_event->>'parentIssueNumber')::bigint END,
    NULLIF(p_event->>'headSha', ''),
    CASE WHEN p_event->'reviewRound' IS NULL
              OR p_event->'reviewRound' = 'null'::jsonb
      THEN NULL ELSE (p_event->>'reviewRound')::integer END,
    NULLIF(p_event->>'reviewOutcome', ''), NULLIF(p_event->>'gateKey', ''),
    NULLIF(p_event->>'humanAction', '')
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
    head_sha = EXCLUDED.head_sha,
    review_round = EXCLUDED.review_round,
    review_outcome = EXCLUDED.review_outcome,
    gate_key = EXCLUDED.gate_key,
    human_action = EXCLUDED.human_action,
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
    GRANT EXECUTE ON FUNCTION agentops_control.record_development_progress(
      uuid, text, jsonb
    ) TO agentops_runner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage') THEN
    GRANT EXECUTE ON FUNCTION agentops_control.record_development_progress(
      uuid, text, jsonb
    ) TO agentops_triage;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_control') THEN
    GRANT SELECT, INSERT, UPDATE ON agentops_control.human_escalations
      TO agentops_control;
    GRANT USAGE, SELECT ON SEQUENCE
      agentops_control.human_escalations_id_seq TO agentops_control;
  END IF;
END
$$;
