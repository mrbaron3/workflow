-- Review finding lineage is an optional string classification, while
-- lineageRef is an optional stable string reference. Migration 0021 copied
-- both as object checks from the separate branch-lineage model, rejecting
-- valid first-review findings such as {"lineage":"new"}.

CREATE OR REPLACE FUNCTION agentops_control.record_development_review_round(
  p_lease_token uuid,
  p_worker_id text,
  p_review jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  review_id bigint;
  durable_registration_id uuid;
  durable_registration_version bigint;
  durable_job_id uuid;
  durable_attempt_id uuid;
  durable_release_id uuid;
  durable_repository text;
  durable_subject_kind text;
  durable_subject_number bigint;
  perspective jsonb;
  finding jsonb;
  seen_perspectives text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(p_review) <> 'object'
     OR NOT (p_review ?& ARRAY[
       'round', 'headSha', 'branch', 'outcome', 'startedAt', 'perspectives'
     ])
     OR p_review - ARRAY[
       'round', 'headSha', 'branch', 'pullRequestNumber', 'outcome',
       'startedAt', 'completedAt', 'perspectives'
     ] <> '{}'::jsonb
     OR jsonb_typeof(p_review->'round') <> 'number'
     OR NOT pg_input_is_valid(p_review->>'round', 'integer')
     OR (p_review->>'round')::integer NOT BETWEEN 1 AND 1000
     OR (p_review->>'headSha') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     OR length(p_review->>'branch') NOT BETWEEN 1 AND 500
     OR p_review->>'outcome' NOT IN (
       'running', 'approve', 'request-changes', 'escalated'
     )
     OR NOT pg_input_is_valid(p_review->>'startedAt', 'timestamptz')
     OR (
       p_review ? 'completedAt' AND p_review->'completedAt' <> 'null'::jsonb
       AND NOT pg_input_is_valid(p_review->>'completedAt', 'timestamptz')
     )
     OR (
       p_review ? 'pullRequestNumber'
       AND p_review->'pullRequestNumber' <> 'null'::jsonb
       AND (
         jsonb_typeof(p_review->'pullRequestNumber') <> 'number'
         OR NOT pg_input_is_valid(p_review->>'pullRequestNumber', 'bigint')
         OR (p_review->>'pullRequestNumber')::bigint < 1
       )
     )
     OR jsonb_typeof(p_review->'perspectives') <> 'array'
     OR jsonb_array_length(p_review->'perspectives') > 8
     OR (
       p_review->>'outcome' = 'running'
       AND (
         (p_review ? 'completedAt'
           AND p_review->'completedAt' <> 'null'::jsonb)
         OR jsonb_array_length(p_review->'perspectives') <> 0
       )
     )
     OR (
       p_review->>'outcome' <> 'running'
       AND (
         NOT p_review ? 'completedAt'
         OR p_review->'completedAt' = 'null'::jsonb
         OR jsonb_array_length(p_review->'perspectives') = 0
       )
     )
     OR (
       p_review ? 'completedAt'
       AND p_review->'completedAt' <> 'null'::jsonb
       AND (p_review->>'completedAt')::timestamptz
         < (p_review->>'startedAt')::timestamptz
     ) THEN
    RAISE EXCEPTION 'development review round is invalid';
  END IF;

  FOR perspective IN SELECT * FROM jsonb_array_elements(p_review->'perspectives')
  LOOP
    IF jsonb_typeof(perspective) <> 'object'
       OR NOT (perspective ?& ARRAY['perspective', 'verdict', 'findings'])
       OR perspective - ARRAY['perspective', 'verdict', 'findings'] <> '{}'::jsonb
       OR perspective->>'perspective' NOT IN (
         'functionality', 'codeQuality', 'testQuality', 'ux', 'accessibility',
         'security', 'type-design', 'panel-escalation'
       )
       OR perspective->>'verdict' NOT IN (
         'approve', 'request_changes', 'needs_human'
       )
       OR perspective->>'perspective' = ANY(seen_perspectives)
       OR jsonb_typeof(perspective->'findings') <> 'array'
       OR jsonb_array_length(perspective->'findings') > 100 THEN
      RAISE EXCEPTION 'development review perspective is invalid';
    END IF;
    seen_perspectives := array_append(
      seen_perspectives, perspective->>'perspective'
    );
    FOR finding IN SELECT * FROM jsonb_array_elements(perspective->'findings')
    LOOP
      IF jsonb_typeof(finding) <> 'object'
         OR NOT (finding ?& ARRAY[
           'criterionId', 'severity', 'expected', 'observed', 'requiredFix',
           'disposition'
         ])
         OR finding - ARRAY[
           'criterionId', 'severity', 'expected', 'observed', 'requiredFix',
           'disposition', 'separationReason', 'lineage', 'lineageRef'
         ] <> '{}'::jsonb
         OR jsonb_typeof(finding->'criterionId') <> 'string'
         OR length(finding->>'criterionId') NOT BETWEEN 1 AND 200
         OR jsonb_typeof(finding->'severity') <> 'string'
         OR finding->>'severity' NOT IN ('blocker', 'major', 'minor')
         OR jsonb_typeof(finding->'expected') <> 'string'
         OR length(finding->>'expected') > 8000
         OR jsonb_typeof(finding->'observed') <> 'string'
         OR length(finding->>'observed') > 8000
         OR jsonb_typeof(finding->'requiredFix') <> 'array'
         OR jsonb_array_length(finding->'requiredFix') > 32
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(finding->'requiredFix') required_fix
            WHERE jsonb_typeof(required_fix) <> 'string'
               OR length(required_fix #>> '{}') > 8000
         )
         OR jsonb_typeof(finding->'disposition') <> 'string'
         OR finding->>'disposition' NOT IN ('in-change', 'separate-issue')
         OR (
           finding->>'disposition' = 'separate-issue'
           AND (
             jsonb_typeof(finding->'separationReason') <> 'string'
             OR length(COALESCE(finding->>'separationReason', '')) NOT BETWEEN 1 AND 8000
           )
         )
         OR (
           finding->>'disposition' = 'in-change'
           AND finding ? 'separationReason'
           AND finding->'separationReason' <> 'null'::jsonb
         )
         OR (
           finding ? 'lineage'
           AND (
             jsonb_typeof(finding->'lineage') <> 'string'
             OR finding->>'lineage' NOT IN ('new', 'persisted')
           )
         )
         OR (
           finding ? 'lineageRef'
           AND (
             jsonb_typeof(finding->'lineageRef') <> 'string'
             OR finding->>'lineageRef' !~ '^finding-origin-v1:[0-9a-f]{64}$'
           )
         ) THEN
        RAISE EXCEPTION 'development review finding is invalid';
      END IF;
    END LOOP;
  END LOOP;

  SELECT registration.id, job.registration_version, job.id, attempt.id,
         release.id, registration.repository,
         CASE
           WHEN release.issue_number IS NOT NULL THEN 'issue'
           WHEN job.payload->'event'->>'kind' IS NOT NULL
             THEN job.payload->'event'->>'kind'
           ELSE 'issue'
         END,
         COALESCE(
           release.issue_number,
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
     AND job.job_type = 'agentops.runner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'development review lease identity is invalid';
  END IF;

  INSERT INTO agentops_control.development_review_rounds(
    registration_id, registration_version, job_id, attempt_id, release_id,
    repository, subject_kind, subject_number, round, head_sha, branch,
    pull_request_number, outcome, started_at, completed_at
  ) VALUES (
    durable_registration_id, durable_registration_version, durable_job_id,
    durable_attempt_id, durable_release_id, durable_repository,
    durable_subject_kind, durable_subject_number, (p_review->>'round')::integer,
    p_review->>'headSha', p_review->>'branch',
    CASE WHEN p_review->'pullRequestNumber' IS NULL
              OR p_review->'pullRequestNumber' = 'null'::jsonb
      THEN NULL ELSE (p_review->>'pullRequestNumber')::bigint END,
    p_review->>'outcome', (p_review->>'startedAt')::timestamptz,
    CASE WHEN p_review->'completedAt' IS NULL
              OR p_review->'completedAt' = 'null'::jsonb
      THEN NULL ELSE (p_review->>'completedAt')::timestamptz END
  )
  ON CONFLICT (job_id, round, head_sha) DO UPDATE SET
    attempt_id = EXCLUDED.attempt_id,
    pull_request_number = EXCLUDED.pull_request_number,
    outcome = EXCLUDED.outcome,
    completed_at = EXCLUDED.completed_at,
    updated_at = clock_timestamp()
  WHERE development_review_rounds.outcome = 'running'
     OR (
       development_review_rounds.outcome = EXCLUDED.outcome
       AND development_review_rounds.pull_request_number
         IS NOT DISTINCT FROM EXCLUDED.pull_request_number
       AND development_review_rounds.completed_at
         IS NOT DISTINCT FROM EXCLUDED.completed_at
       AND (
         SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'perspective', recorded.perspective,
               'verdict', recorded.verdict,
               'findings', recorded.findings
             ) ORDER BY recorded.perspective
           ),
           '[]'::jsonb
         )
           FROM agentops_control.development_review_perspectives recorded
          WHERE recorded.review_round_id = development_review_rounds.id
       ) = (
         SELECT COALESCE(jsonb_agg(item ORDER BY item->>'perspective'), '[]'::jsonb)
           FROM jsonb_array_elements(p_review->'perspectives') item
       )
     )
  RETURNING id INTO review_id;

  IF review_id IS NULL THEN
    RAISE EXCEPTION 'terminal development review round is immutable';
  END IF;

  DELETE FROM agentops_control.development_review_perspectives
   WHERE review_round_id = review_id;
  INSERT INTO agentops_control.development_review_perspectives(
    review_round_id, perspective, verdict, findings, finding_count,
    completed_at
  )
  SELECT review_id, item->>'perspective', item->>'verdict', item->'findings',
         jsonb_array_length(item->'findings'),
         COALESCE(
           NULLIF(p_review->>'completedAt', '')::timestamptz,
           clock_timestamp()
         )
    FROM jsonb_array_elements(p_review->'perspectives') item;
  RETURN review_id;
END
$$;
