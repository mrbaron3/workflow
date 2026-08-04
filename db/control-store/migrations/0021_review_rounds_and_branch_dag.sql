-- Durable review evidence and review-discovered child branch lineage.
-- Review verdicts are immutable-head facts. Child work is always rooted at the
-- exact parent head and can only integrate into the parent's integration branch.

CREATE TABLE agentops_control.development_review_rounds (
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
  round integer NOT NULL CHECK (round BETWEEN 1 AND 1000),
  head_sha text NOT NULL CHECK (
    head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
  ),
  branch text NOT NULL CHECK (length(branch) BETWEEN 1 AND 500),
  pull_request_number bigint CHECK (
    pull_request_number IS NULL OR pull_request_number > 0
  ),
  outcome text NOT NULL CHECK (
    outcome IN ('running', 'approve', 'request-changes', 'escalated')
  ),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT development_review_round_subject_shape CHECK (
    (subject_kind = 'repository' AND subject_number IS NULL)
    OR (subject_kind IN ('issue', 'pull_request') AND subject_number IS NOT NULL)
  ),
  UNIQUE (job_id, round, head_sha)
);

CREATE TABLE agentops_control.development_review_perspectives (
  review_round_id bigint NOT NULL
    REFERENCES agentops_control.development_review_rounds(id) ON DELETE CASCADE,
  perspective text NOT NULL CHECK (perspective IN (
    'functionality', 'codeQuality', 'testQuality', 'ux', 'accessibility',
    'security', 'type-design', 'panel-escalation'
  )),
  verdict text NOT NULL CHECK (
    verdict IN ('approve', 'request_changes', 'needs_human')
  ),
  findings jsonb NOT NULL CHECK (
    jsonb_typeof(findings) = 'array' AND jsonb_array_length(findings) <= 100
  ),
  finding_count integer NOT NULL CHECK (
    finding_count >= 0 AND finding_count <= 100
  ),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (review_round_id, perspective)
);

CREATE INDEX development_review_rounds_subject_latest
  ON agentops_control.development_review_rounds(
    registration_id, subject_kind, subject_number, updated_at DESC, id DESC
  );

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
           AND jsonb_typeof(finding->'lineage') <> 'object'
         )
         OR (
           finding ? 'lineageRef'
           AND jsonb_typeof(finding->'lineageRef') <> 'object'
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

CREATE TABLE agentops_control.development_lineage_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL
    REFERENCES agentops_control.repository_registrations(id) ON DELETE CASCADE,
  release_id uuid UNIQUE
    REFERENCES agentops_control.releases(id) ON DELETE SET NULL,
  repository text NOT NULL,
  issue_number bigint NOT NULL CHECK (issue_number > 0),
  parent_node_id uuid
    REFERENCES agentops_control.development_lineage_nodes(id) ON DELETE RESTRICT,
  source_finding_key text CHECK (
    source_finding_key IS NULL OR source_finding_key ~ '^sha256:[0-9a-f]{64}$'
  ),
  source_finding jsonb CHECK (
    source_finding IS NULL OR jsonb_typeof(source_finding) = 'object'
  ),
  review_round integer CHECK (review_round IS NULL OR review_round BETWEEN 1 AND 1000),
  parent_pull_request_number bigint CHECK (
    parent_pull_request_number IS NULL OR parent_pull_request_number > 0
  ),
  parent_branch text,
  parent_head_sha text CHECK (
    parent_head_sha IS NULL OR parent_head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
  ),
  child_issue_url text,
  status text NOT NULL CHECK (
    status IN ('pending', 'running', 'merge-ready', 'integrated', 'failed')
  ),
  child_pull_request_number bigint CHECK (
    child_pull_request_number IS NULL OR child_pull_request_number > 0
  ),
  child_head_sha text CHECK (
    child_head_sha IS NULL OR child_head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
  ),
  integrated_head_sha text CHECK (
    integrated_head_sha IS NULL OR integrated_head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
  ),
  integrated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT development_lineage_root_or_child CHECK (
    (parent_node_id IS NULL AND source_finding_key IS NULL
      AND source_finding IS NULL AND parent_branch IS NULL
      AND parent_head_sha IS NULL)
    OR
    (parent_node_id IS NOT NULL AND source_finding_key IS NOT NULL
      AND source_finding IS NOT NULL AND review_round IS NOT NULL
      AND parent_pull_request_number IS NOT NULL
      AND length(parent_branch) BETWEEN 1 AND 500
      AND parent_head_sha IS NOT NULL AND child_issue_url IS NOT NULL)
  ),
  UNIQUE (repository, issue_number),
  UNIQUE (parent_node_id, source_finding_key),
  CHECK (parent_node_id IS NULL OR parent_node_id <> id)
);

CREATE INDEX development_lineage_parent_status
  ON agentops_control.development_lineage_nodes(parent_node_id, status);

CREATE FUNCTION agentops_control.reject_development_lineage_cycle()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.parent_node_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors(id, parent_node_id) AS (
      SELECT node.id, node.parent_node_id
        FROM agentops_control.development_lineage_nodes node
       WHERE node.id = NEW.parent_node_id
      UNION ALL
      SELECT node.id, node.parent_node_id
        FROM agentops_control.development_lineage_nodes node
        JOIN ancestors ON node.id = ancestors.parent_node_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'development lineage cycle is forbidden';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER development_lineage_cycle_guard
BEFORE INSERT OR UPDATE OF parent_node_id
ON agentops_control.development_lineage_nodes
FOR EACH ROW EXECUTE FUNCTION agentops_control.reject_development_lineage_cycle();

CREATE OR REPLACE FUNCTION agentops_control.record_review_child(
  p_lease_token uuid,
  p_worker_id text,
  p_child jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  durable_registration_id uuid;
  durable_release_id uuid;
  durable_job_id uuid;
  durable_repository text;
  durable_issue_number bigint;
  parent_id uuid;
  child_id uuid;
BEGIN
  IF jsonb_typeof(p_child) <> 'object'
     OR NOT (p_child ?& ARRAY[
       'childIssueNumber', 'childIssueUrl', 'findingKey', 'finding',
       'reviewRound', 'parentPullRequestNumber', 'parentBranch', 'parentHeadSha'
     ])
     OR p_child - ARRAY[
       'childIssueNumber', 'childIssueUrl', 'findingKey', 'finding',
       'reviewRound', 'parentPullRequestNumber', 'parentBranch', 'parentHeadSha'
     ] <> '{}'::jsonb
     OR NOT pg_input_is_valid(p_child->>'childIssueNumber', 'bigint')
     OR (p_child->>'childIssueNumber')::bigint < 1
     OR length(p_child->>'childIssueUrl') NOT BETWEEN 1 AND 2000
     OR (p_child->>'findingKey') !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(p_child->'finding') <> 'object'
     OR p_child->'finding'->>'disposition' <> 'separate-issue'
     OR NOT pg_input_is_valid(p_child->>'reviewRound', 'integer')
     OR (p_child->>'reviewRound')::integer NOT BETWEEN 1 AND 1000
     OR NOT pg_input_is_valid(p_child->>'parentPullRequestNumber', 'bigint')
     OR (p_child->>'parentPullRequestNumber')::bigint < 1
     OR length(p_child->>'parentBranch') NOT BETWEEN 1 AND 500
     OR (p_child->>'parentHeadSha') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$' THEN
    RAISE EXCEPTION 'review child is invalid';
  END IF;

  SELECT job.registration_id, job.release_id, job.id,
         registration.repository, release.issue_number
    INTO durable_registration_id, durable_release_id, durable_job_id,
         durable_repository, durable_issue_number
    FROM agentops_control.job_leases lease
    JOIN agentops_control.job_attempts attempt ON attempt.id = lease.attempt_id
    JOIN agentops_control.jobs job ON job.id = lease.job_id
    JOIN agentops_control.repository_registrations registration
      ON registration.id = job.registration_id
    JOIN agentops_control.releases release ON release.id = job.release_id
   WHERE lease.lease_token = p_lease_token
     AND lease.worker_id = p_worker_id
     AND lease.status = 'active' AND lease.expires_at > clock_timestamp()
     AND attempt.status = 'running' AND job.status = 'leased'
     AND job.job_type = 'agentops.runner';
  IF NOT FOUND THEN RAISE EXCEPTION 'review child lease identity is invalid'; END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM agentops_control.development_review_rounds review
      JOIN agentops_control.development_review_perspectives perspective
        ON perspective.review_round_id = review.id
      CROSS JOIN LATERAL jsonb_array_elements(perspective.findings)
        AS finding(value)
     WHERE review.job_id = durable_job_id
       AND review.round = (p_child->>'reviewRound')::integer
       AND review.head_sha = p_child->>'parentHeadSha'
       AND review.branch = p_child->>'parentBranch'
       AND review.pull_request_number =
         (p_child->>'parentPullRequestNumber')::bigint
       AND review.outcome IN ('request-changes', 'escalated')
       AND finding.value = p_child->'finding'
  ) THEN
    RAISE EXCEPTION 'review child is not backed by durable review evidence';
  END IF;

  INSERT INTO agentops_control.development_lineage_nodes(
    registration_id, release_id, repository, issue_number, status,
    child_pull_request_number, child_head_sha
  ) VALUES (
    durable_registration_id, durable_release_id, durable_repository,
    durable_issue_number, 'running',
    (p_child->>'parentPullRequestNumber')::bigint,
    p_child->>'parentHeadSha'
  )
  ON CONFLICT (release_id) DO UPDATE SET
    child_pull_request_number = EXCLUDED.child_pull_request_number,
    child_head_sha = EXCLUDED.child_head_sha,
    updated_at = clock_timestamp()
  RETURNING id INTO parent_id;

  INSERT INTO agentops_control.development_lineage_nodes AS existing(
    registration_id, repository, issue_number, parent_node_id,
    source_finding_key, source_finding, review_round,
    parent_pull_request_number, parent_branch, parent_head_sha,
    child_issue_url, status
  ) VALUES (
    durable_registration_id, durable_repository,
    (p_child->>'childIssueNumber')::bigint, parent_id,
    p_child->>'findingKey', p_child->'finding',
    (p_child->>'reviewRound')::integer,
    (p_child->>'parentPullRequestNumber')::bigint,
    p_child->>'parentBranch', p_child->>'parentHeadSha',
    p_child->>'childIssueUrl', 'pending'
  )
  ON CONFLICT (parent_node_id, source_finding_key) DO UPDATE SET
    updated_at = clock_timestamp()
  WHERE existing.issue_number = EXCLUDED.issue_number
    AND existing.child_issue_url = EXCLUDED.child_issue_url
    AND existing.source_finding = EXCLUDED.source_finding
    AND existing.review_round = EXCLUDED.review_round
    AND existing.parent_pull_request_number = EXCLUDED.parent_pull_request_number
    AND existing.parent_branch = EXCLUDED.parent_branch
    AND existing.parent_head_sha = EXCLUDED.parent_head_sha
  RETURNING id INTO child_id;
  IF child_id IS NULL THEN
    RAISE EXCEPTION 'review finding is already bound to different child coordinates';
  END IF;
  RETURN child_id;
END
$$;

CREATE OR REPLACE FUNCTION agentops_control.bind_review_child_release(
  p_lease_token uuid,
  p_worker_id text,
  p_release_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  child_id uuid;
BEGIN
  SELECT node.id INTO child_id
    FROM agentops_control.job_leases lease
    JOIN agentops_control.job_attempts attempt ON attempt.id = lease.attempt_id
    JOIN agentops_control.jobs job ON job.id = lease.job_id
    JOIN agentops_control.releases release ON release.id = job.release_id
    JOIN agentops_control.development_lineage_nodes node
      ON node.registration_id = job.registration_id
     AND node.repository = release.repository
     AND node.issue_number = release.issue_number
   WHERE lease.lease_token = p_lease_token
     AND lease.worker_id = p_worker_id
     AND lease.status = 'active' AND lease.expires_at > clock_timestamp()
     AND attempt.status = 'running' AND job.status = 'leased'
     AND job.release_id = p_release_id
     AND node.parent_node_id IS NOT NULL
     AND (node.release_id IS NULL OR node.release_id = p_release_id)
   FOR UPDATE OF node;
  IF NOT FOUND THEN RAISE EXCEPTION 'review child release binding is invalid'; END IF;
  UPDATE agentops_control.development_lineage_nodes
     SET release_id = p_release_id, status = 'running',
         updated_at = clock_timestamp()
   WHERE id = child_id;
  RETURN child_id;
END
$$;

CREATE OR REPLACE FUNCTION agentops_control.mark_review_child_integrated(
  p_lease_token uuid,
  p_worker_id text,
  p_release_id uuid,
  p_pull_request_number bigint,
  p_child_head_sha text,
  p_integrated_head_sha text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  child_id uuid;
BEGIN
  IF p_pull_request_number < 1
     OR p_child_head_sha !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     OR p_integrated_head_sha !~ '^[0-9a-f]{40}([0-9a-f]{24})?$' THEN
    RAISE EXCEPTION 'review child integration coordinates are invalid';
  END IF;
  SELECT node.id INTO child_id
    FROM agentops_control.job_leases lease
    JOIN agentops_control.job_attempts attempt ON attempt.id = lease.attempt_id
    JOIN agentops_control.jobs job ON job.id = lease.job_id
    JOIN agentops_control.development_lineage_nodes node
      ON node.release_id = p_release_id
    JOIN agentops_control.releases release ON release.id = p_release_id
   WHERE lease.lease_token = p_lease_token
     AND lease.worker_id = p_worker_id
     AND lease.status = 'active' AND lease.expires_at > clock_timestamp()
     AND attempt.status = 'running' AND job.status = 'leased'
     AND job.release_id = p_release_id
     AND node.parent_node_id IS NOT NULL
     AND release.status = 'merged'
     AND release.pull_request_number = p_pull_request_number
     AND release.final_head = p_child_head_sha
     AND release.merge_sha = p_integrated_head_sha
     AND NOT EXISTS (
       SELECT 1
         FROM agentops_control.development_lineage_nodes descendant
        WHERE descendant.parent_node_id = node.id
          AND descendant.status <> 'integrated'
     )
     AND (node.status <> 'integrated'
       OR (node.child_pull_request_number = p_pull_request_number
         AND node.child_head_sha = p_child_head_sha
         AND node.integrated_head_sha = p_integrated_head_sha))
   FOR UPDATE OF node;
  IF NOT FOUND THEN RAISE EXCEPTION 'review child integration is invalid'; END IF;
  UPDATE agentops_control.development_lineage_nodes
     SET status = 'integrated',
         child_pull_request_number = p_pull_request_number,
         child_head_sha = p_child_head_sha,
         integrated_head_sha = p_integrated_head_sha,
         integrated_at = COALESCE(integrated_at, clock_timestamp()),
         updated_at = clock_timestamp()
   WHERE id = child_id;
  RETURN child_id;
END
$$;

REVOKE ALL ON FUNCTION agentops_control.record_development_review_round(
  uuid, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentops_control.record_review_child(
  uuid, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentops_control.bind_review_child_release(
  uuid, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentops_control.mark_review_child_integrated(
  uuid, text, uuid, bigint, text, text
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    GRANT EXECUTE ON FUNCTION agentops_control.record_development_review_round(
      uuid, text, jsonb
    ) TO agentops_runner;
    GRANT EXECUTE ON FUNCTION agentops_control.record_review_child(
      uuid, text, jsonb
    ) TO agentops_runner;
    GRANT EXECUTE ON FUNCTION agentops_control.bind_review_child_release(
      uuid, text, uuid
    ) TO agentops_runner;
    GRANT EXECUTE ON FUNCTION agentops_control.mark_review_child_integrated(
      uuid, text, uuid, bigint, text, text
    ) TO agentops_runner;
    GRANT SELECT ON agentops_control.development_review_rounds,
      agentops_control.development_review_perspectives,
      agentops_control.development_lineage_nodes TO agentops_runner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_control') THEN
    GRANT SELECT ON agentops_control.development_review_rounds,
      agentops_control.development_review_perspectives,
      agentops_control.development_lineage_nodes TO agentops_control;
  END IF;
END
$$;
