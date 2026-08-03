-- Job-topology-neutral release identity and causal receipt outbox.
--
-- Small, semantic receipts live in PostgreSQL; large evidence artifacts remain
-- on the registration volume. The outbox row is committed in the same
-- transaction as each release transition, so a process crash cannot leave an
-- irreversible merge authorized only by job-local state.

CREATE FUNCTION agentops_control.valid_release_evidence_configuration(
  value jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  policy jsonb;
  item jsonb;
  epoch numeric;
BEGIN
  IF jsonb_typeof(value) <> 'object'
     OR value - ARRAY['releaseEvidence'] <> '{}'::jsonb THEN
    RETURN false;
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
     ) NOT BETWEEN 2 AND 32
     OR jsonb_typeof(policy->'minimumHeadEpochs') <> 'number' THEN
    RETURN false;
  END IF;
  epoch := (policy->>'minimumHeadEpochs')::numeric;
  IF epoch NOT BETWEEN 1 AND 32 OR mod(epoch, 1) <> 0 THEN
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
       OR length(item #>> '{}') NOT BETWEEN 1 AND 128 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

ALTER TABLE agentops_control.repository_registrations
  DROP CONSTRAINT repository_registrations_empty_configuration;
ALTER TABLE agentops_control.repository_registrations
  ADD CONSTRAINT repository_registrations_release_evidence_configuration
  CHECK (agentops_control.valid_release_evidence_configuration(configuration));

CREATE TABLE agentops_control.releases (
  id uuid PRIMARY KEY,
  registration_id uuid NOT NULL
    REFERENCES agentops_control.repository_registrations(id) ON DELETE RESTRICT,
  release_key text NOT NULL CHECK (release_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'),
  repository text NOT NULL,
  issue_number bigint NOT NULL CHECK (issue_number > 0 AND issue_number <= 2147483647),
  policy jsonb NOT NULL CHECK (
    agentops_control.valid_release_evidence_configuration(
      jsonb_build_object('releaseEvidence', policy)
    )
  ),
  status text NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'merge-authorized', 'merged')),
  pull_request_number bigint CHECK (
    pull_request_number IS NULL
    OR (pull_request_number > 0 AND pull_request_number <= 2147483647)
  ),
  final_head text CHECK (final_head IS NULL OR final_head ~ '^[0-9a-f]{40}$'),
  merge_sha text CHECK (merge_sha IS NULL OR merge_sha ~ '^[0-9a-f]{40}$'),
  merge_actor text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT releases_registration_key UNIQUE (registration_id, release_key),
  CONSTRAINT releases_repository_identity CHECK (
    repository = lower(repository)
    AND repository ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_.-]{1,100}$'
    AND split_part(repository, '/', 2) NOT IN ('.', '..')
  ),
  CONSTRAINT releases_state_shape CHECK (
    (status = 'collecting'
      AND merge_sha IS NULL AND merge_actor IS NULL AND completed_at IS NULL)
    OR
    (status = 'merge-authorized'
      AND pull_request_number IS NOT NULL AND final_head IS NOT NULL
      AND merge_sha IS NULL AND merge_actor IS NULL AND completed_at IS NULL)
    OR
    (status = 'merged'
      AND pull_request_number IS NOT NULL AND final_head IS NOT NULL
      AND merge_sha IS NOT NULL AND merge_actor IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

-- At most one release for one Issue may still be capable of mutating GitHub.
-- A later release after a completed one receives a new explicit release_key.
CREATE UNIQUE INDEX releases_one_open_per_issue
  ON agentops_control.releases(registration_id, issue_number)
  WHERE status IN ('collecting', 'merge-authorized');

ALTER TABLE agentops_control.jobs
  ADD COLUMN release_id uuid
    REFERENCES agentops_control.releases(id) ON DELETE RESTRICT;
CREATE INDEX jobs_release ON agentops_control.jobs(release_id)
  WHERE release_id IS NOT NULL;

CREATE TABLE agentops_control.release_heads (
  release_id uuid NOT NULL
    REFERENCES agentops_control.releases(id) ON DELETE RESTRICT,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  head_epoch integer NOT NULL CHECK (head_epoch BETWEEN 1 AND 1024),
  parent_head text CHECK (parent_head IS NULL OR parent_head ~ '^[0-9a-f]{40}$'),
  first_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (release_id, head_sha),
  CONSTRAINT release_head_epoch UNIQUE (release_id, head_epoch),
  CONSTRAINT release_head_not_self_parent CHECK (parent_head IS NULL OR parent_head <> head_sha)
);

CREATE FUNCTION agentops_control.validate_release_head_parent()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.parent_head IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agentops_control.release_heads parent
     WHERE parent.release_id = NEW.release_id
       AND parent.head_sha = NEW.parent_head
       AND parent.head_epoch < NEW.head_epoch
  ) THEN
    RAISE EXCEPTION 'release head parent must be an earlier epoch in the same release';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER release_head_parent_same_release
AFTER INSERT OR UPDATE OF release_id, head_sha, head_epoch, parent_head
ON agentops_control.release_heads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION agentops_control.validate_release_head_parent();

CREATE TABLE agentops_control.release_receipt_outbox (
  receipt_id uuid PRIMARY KEY,
  release_id uuid NOT NULL
    REFERENCES agentops_control.releases(id) ON DELETE RESTRICT,
  receipt_key text NOT NULL CHECK (
    receipt_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
  ),
  kind text NOT NULL CHECK (kind IN (
    'authority', 'build', 'grade', 'review', 'finding-resolution',
    'runtime-provenance', 'merge-intent', 'merge', 'intervention'
  )),
  repository text NOT NULL,
  issue_number bigint NOT NULL CHECK (issue_number > 0 AND issue_number <= 2147483647),
  head_sha text CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  causes uuid[] NOT NULL DEFAULT '{}'::uuid[],
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT release_receipt_release_key UNIQUE (release_id, receipt_key),
  CONSTRAINT release_receipt_release_id UNIQUE (release_id, receipt_id),
  CONSTRAINT release_receipt_repository_identity CHECK (
    repository = lower(repository)
    AND repository ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_.-]{1,100}$'
    AND split_part(repository, '/', 2) NOT IN ('.', '..')
  ),
  CONSTRAINT release_receipt_payload_coordinates CHECK (
    payload->>'receiptId' = receipt_id::text
    AND payload->>'receiptKey' = receipt_key
    AND payload->>'releaseId' = release_id::text
    AND payload->>'kind' = kind
    AND payload->>'repository' = repository
    AND (payload->>'issueNumber')::bigint = issue_number
    AND payload->'causes' = to_jsonb(causes)
    AND pg_input_is_valid(payload->>'recordedAt', 'timestamp with time zone')
  )
);

CREATE INDEX release_receipt_outbox_unpublished
  ON agentops_control.release_receipt_outbox(created_at, receipt_id)
  WHERE published_at IS NULL;
CREATE INDEX release_receipt_outbox_release_kind
  ON agentops_control.release_receipt_outbox(release_id, kind, recorded_at);
CREATE UNIQUE INDEX release_receipt_one_authority
  ON agentops_control.release_receipt_outbox(release_id)
  WHERE kind = 'authority';
CREATE UNIQUE INDEX release_receipt_one_merge_intent
  ON agentops_control.release_receipt_outbox(release_id)
  WHERE kind = 'merge-intent';
CREATE UNIQUE INDEX release_receipt_one_merge
  ON agentops_control.release_receipt_outbox(release_id)
  WHERE kind = 'merge';

CREATE FUNCTION agentops_control.preserve_release_receipt()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.receipt_id, NEW.release_id, NEW.receipt_key, NEW.kind,
    NEW.repository, NEW.issue_number, NEW.head_sha, NEW.causes,
    NEW.payload, NEW.recorded_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.receipt_id, OLD.release_id, OLD.receipt_key, OLD.kind,
    OLD.repository, OLD.issue_number, OLD.head_sha, OLD.causes,
    OLD.payload, OLD.recorded_at, OLD.created_at
  ) OR (
    OLD.published_at IS NOT NULL
    AND NEW.published_at IS DISTINCT FROM OLD.published_at
  ) THEN
    RAISE EXCEPTION 'release receipts are immutable after insertion';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER release_receipt_immutable
BEFORE UPDATE ON agentops_control.release_receipt_outbox
FOR EACH ROW EXECUTE FUNCTION agentops_control.preserve_release_receipt();

CREATE FUNCTION agentops_control.reject_release_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable after insertion', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER release_receipt_delete_rejected
BEFORE DELETE ON agentops_control.release_receipt_outbox
FOR EACH ROW EXECUTE FUNCTION agentops_control.reject_release_evidence_mutation();

-- Causes cannot cross releases. PostgreSQL cannot express an array foreign key,
-- so a deferred constraint trigger checks the complete statement/transaction.
CREATE FUNCTION agentops_control.validate_release_receipt_causes()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM agentops_control.releases release
     WHERE release.id = NEW.release_id
       AND release.repository = NEW.repository
       AND release.issue_number = NEW.issue_number
       AND release.created_at <= NEW.recorded_at
  ) OR cardinality(NEW.causes) <> cardinality(
    ARRAY(SELECT DISTINCT receipt_id FROM unnest(NEW.causes) receipt_id)
  ) OR EXISTS (
    SELECT 1
      FROM unnest(NEW.causes) cause(receipt_id)
     WHERE cause.receipt_id = NEW.receipt_id
        OR NOT EXISTS (
          SELECT 1
            FROM agentops_control.release_receipt_outbox prior
           WHERE prior.release_id = NEW.release_id
             AND prior.receipt_id = cause.receipt_id
             AND prior.recorded_at <= NEW.recorded_at
        )
  ) THEN
    RAISE EXCEPTION 'release receipt identity, chronology, or cause is invalid';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER release_receipt_causes_same_release
AFTER INSERT OR UPDATE OF causes, release_id
ON agentops_control.release_receipt_outbox
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION agentops_control.validate_release_receipt_causes();

CREATE FUNCTION agentops_control.notify_release_receipt()
RETURNS trigger LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('agentops_release_receipt_wake', json_build_object(
    'table', TG_TABLE_NAME,
    'operation', TG_OP,
    'id', NEW.receipt_id::text,
    'releaseId', NEW.release_id::text
  )::text);
  RETURN NEW;
END
$$;

CREATE TRIGGER release_receipt_outbox_wake
AFTER INSERT ON agentops_control.release_receipt_outbox
FOR EACH ROW EXECUTE FUNCTION agentops_control.notify_release_receipt();

CREATE TABLE agentops_control.release_artifacts (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL
    REFERENCES agentops_control.releases(id) ON DELETE RESTRICT,
  artifact_key text NOT NULL CHECK (
    artifact_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
  ),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 128),
  uri text NOT NULL CHECK (length(uri) BETWEEN 1 AND 1024),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  source_head text NOT NULL CHECK (source_head ~ '^[0-9a-f]{40}$'),
  receipt_ids uuid[] NOT NULL CHECK (cardinality(receipt_ids) BETWEEN 1 AND 512),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT release_artifact_key UNIQUE (release_id, artifact_key),
  CONSTRAINT release_artifact_id UNIQUE (release_id, id)
);

CREATE FUNCTION agentops_control.validate_release_artifact_receipts()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM agentops_control.releases release
     WHERE release.id = NEW.release_id
       AND (release.final_head IS NULL OR release.final_head = NEW.source_head)
  ) OR NOT EXISTS (
    SELECT 1
      FROM agentops_control.release_receipt_outbox build
     WHERE build.release_id = NEW.release_id
       AND build.kind = 'build'
       AND build.head_sha = NEW.source_head
  ) OR cardinality(NEW.receipt_ids) <> cardinality(
    ARRAY(SELECT DISTINCT receipt_id FROM unnest(NEW.receipt_ids) receipt_id)
  ) OR EXISTS (
    SELECT 1
      FROM unnest(NEW.receipt_ids) receipt(receipt_id)
     WHERE NOT EXISTS (
       SELECT 1
         FROM agentops_control.release_receipt_outbox evidence
        WHERE evidence.release_id = NEW.release_id
          AND evidence.receipt_id = receipt.receipt_id
     )
  ) THEN
    RAISE EXCEPTION 'release artifact receipt binding is missing or duplicated';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER release_artifact_receipts_same_release
AFTER INSERT OR UPDATE OF release_id, receipt_ids
ON agentops_control.release_artifacts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION agentops_control.validate_release_artifact_receipts();

CREATE TRIGGER release_head_immutable
BEFORE UPDATE OR DELETE ON agentops_control.release_heads
FOR EACH ROW EXECUTE FUNCTION agentops_control.reject_release_evidence_mutation();

CREATE TRIGGER release_artifact_immutable
BEFORE UPDATE OR DELETE ON agentops_control.release_artifacts
FOR EACH ROW EXECUTE FUNCTION agentops_control.reject_release_evidence_mutation();

-- v1 triage remains valid when releaseEvidence is absent. Once a Registration
-- opts into v2, promotion atomically creates/reuses one release identity and
-- links both the triage and development jobs. Receipt production may then span
-- later reconciliation and recovery jobs without relying on their topology.
CREATE FUNCTION agentops_control.promote_triage_release(
  p_lease_token uuid,
  p_worker_id text,
  p_result jsonb,
  p_ready_label text,
  p_claimed_label text,
  p_authority jsonb
) RETURNS TABLE (job_id uuid, release_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  triage_job_id uuid;
  current_attempt_id uuid;
  current_registration_id uuid;
  current_registration_version bigint;
  current_repository text;
  current_issue_number bigint;
  release_policy jsonb;
  promoted_job_id uuid;
  durable_release_id uuid;
  authority_receipt_id uuid;
  authority_recorded_at timestamptz;
  authority_route text;
  authority_actor text;
  authority_ready_at timestamptz;
  triage_source_digest text;
  triage_readiness text;
  triage_invocation_id text;
  triage_completed_at timestamptz;
  triage_provenance jsonb;
  triage_producer_job_id uuid;
  triage_producer_attempt_id uuid;
  authority_payload jsonb;
  runtime_receipt_id uuid;
  runtime_recorded_at timestamptz;
BEGIN
  IF p_authority IS NULL OR jsonb_typeof(p_authority) <> 'object'
     OR p_authority - ARRAY['actor', 'readyAt', 'triage'] <> '{}'::jsonb
     OR (SELECT count(*) FROM jsonb_object_keys(p_authority)) NOT BETWEEN 2 AND 3
     OR jsonb_typeof(p_authority->'actor') <> 'string'
     OR length(p_authority->>'actor') NOT BETWEEN 1 AND 128
     OR jsonb_typeof(p_authority->'readyAt') <> 'string'
     OR NOT pg_input_is_valid(
       p_authority->>'readyAt', 'timestamp with time zone'
     ) THEN
    RAISE EXCEPTION 'triage promotion authority is invalid';
  END IF;
  IF p_authority ? 'triage' AND (
    jsonb_typeof(p_authority->'triage') <> 'object'
    OR (p_authority->'triage') - ARRAY[
      'sourceDigest', 'decision', 'completedAt', 'providerProvenance'
    ] <> '{}'::jsonb
    OR (SELECT count(*) FROM jsonb_object_keys(p_authority->'triage')) <> 4
    OR (p_authority->'triage'->>'sourceDigest') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_authority->'triage'->'decision') <> 'object'
    OR p_authority->'triage'->'decision'->>'readiness' <> 'ready_candidate'
    OR jsonb_typeof(p_authority->'triage'->'completedAt') <> 'string'
    OR NOT pg_input_is_valid(
      p_authority->'triage'->>'completedAt', 'timestamp with time zone'
    )
    OR jsonb_typeof(
      p_authority->'triage'->'providerProvenance'
    ) <> 'object'
    OR NOT pg_input_is_valid(
      p_authority->'triage'->'providerProvenance'->>'attemptId', 'uuid'
    )
    OR jsonb_typeof(
      p_authority->'triage'->'providerProvenance'->'model'
    ) <> 'object'
    OR jsonb_typeof(
      p_authority->'triage'->'providerProvenance'->'consumer'
    ) <> 'object'
    OR jsonb_typeof(
      p_authority->'triage'->'providerProvenance'->'environment'
    ) <> 'object'
  ) THEN
    RAISE EXCEPTION 'triage promotion AI authority is invalid';
  END IF;

  SELECT job.id, lease.attempt_id,
         job.registration_id, job.registration_version,
         registration.repository,
         (job.payload->'issue'->>'number')::bigint,
         registration.configuration->'releaseEvidence'
    INTO triage_job_id, current_attempt_id,
         current_registration_id, current_registration_version,
         current_repository, current_issue_number, release_policy
    FROM agentops_control.job_leases lease
    JOIN agentops_control.jobs job ON job.id = lease.job_id
    JOIN agentops_control.repository_registrations registration
      ON registration.id = job.registration_id
   WHERE lease.lease_token = p_lease_token
     AND lease.worker_id = p_worker_id
     AND lease.status = 'active'
     AND lease.expires_at > clock_timestamp()
     AND job.status = 'leased'
     AND job.job_type = 'agentops.triage'
   FOR UPDATE OF lease, job, registration;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'triage promotion lease is stale or lost';
  END IF;

  authority_actor := p_authority->>'actor';
  authority_ready_at := (p_authority->>'readyAt')::timestamptz;
  IF p_authority ? 'triage' AND (
    p_authority->'triage'->>'completedAt'
  )::timestamptz <= authority_ready_at THEN
    triage_source_digest := p_authority->'triage'->>'sourceDigest';
    triage_readiness :=
      p_authority->'triage'->'decision'->>'readiness';
    triage_invocation_id := 'triage-job:' || triage_job_id::text;
    triage_completed_at := (
      p_authority->'triage'->>'completedAt'
    )::timestamptz;
    triage_provenance := p_authority->'triage'->'providerProvenance';
    triage_producer_job_id := triage_job_id;
    triage_producer_attempt_id := (
      triage_provenance->>'attemptId'
    )::uuid;
  ELSIF release_policy IS NOT NULL THEN
    SELECT previous.result->>'sourceDigest',
           previous.result->'decision'->>'readiness',
           'triage-job:' || previous.id::text,
           (previous.result->>'completedAt')::timestamptz,
           previous.result->'providerProvenance',
           previous.id,
           (previous.result->'providerProvenance'->>'attemptId')::uuid
      INTO triage_source_digest, triage_readiness, triage_invocation_id,
           triage_completed_at, triage_provenance,
           triage_producer_job_id, triage_producer_attempt_id
      FROM agentops_control.jobs previous
     WHERE previous.registration_id = current_registration_id
       AND previous.id <> triage_job_id
       AND previous.job_type = 'agentops.triage'
       AND previous.status = 'succeeded'
       AND (previous.payload->'issue'->>'number')::bigint = current_issue_number
       AND previous.result->>'sourceDigest' ~ '^[0-9a-f]{64}$'
       AND previous.result->'decision'->>'readiness' = 'ready_candidate'
       AND jsonb_typeof(previous.result->'providerProvenance') = 'object'
       AND pg_input_is_valid(
         previous.result->'providerProvenance'->>'attemptId', 'uuid'
       )
       AND pg_input_is_valid(
         previous.result->>'completedAt', 'timestamp with time zone'
       )
       AND (previous.result->>'completedAt')::timestamptz <= authority_ready_at
       AND previous.finished_at <= authority_ready_at
     ORDER BY previous.finished_at DESC, previous.id DESC
     LIMIT 1;
  END IF;
  IF release_policy IS NOT NULL
     AND release_policy->>'authority' = 'ai-triage-required'
     AND (
       triage_source_digest IS NULL
       OR triage_readiness <> 'ready_candidate'
       OR triage_provenance IS NULL
     ) THEN
    RAISE EXCEPTION 'AI triage receipt is required before promotion';
  END IF;

  promoted_job_id := agentops_control.promote_triage_job(
    p_lease_token, p_worker_id, p_result - 'providerProvenance',
    p_ready_label, p_claimed_label
  );
  UPDATE agentops_control.jobs
     SET result = p_result, updated_at = clock_timestamp()
   WHERE id = triage_job_id;
  IF release_policy IS NULL THEN
    RETURN QUERY SELECT promoted_job_id, NULL::uuid;
    RETURN;
  END IF;

  SELECT release.id
    INTO durable_release_id
    FROM agentops_control.releases release
   WHERE release.registration_id = current_registration_id
     AND release.issue_number = current_issue_number
     AND release.status IN ('collecting', 'merge-authorized')
   FOR UPDATE;
  IF durable_release_id IS NULL THEN
    durable_release_id := gen_random_uuid();
    INSERT INTO agentops_control.releases(
      id, registration_id, release_key, repository, issue_number, policy
    ) VALUES (
      durable_release_id, current_registration_id,
      'triage-promotion:' || triage_job_id::text,
      current_repository, current_issue_number, release_policy
    );
  END IF;

  UPDATE agentops_control.jobs
     SET release_id = durable_release_id, updated_at = clock_timestamp()
   WHERE id IN (triage_job_id, promoted_job_id)
     AND jobs.registration_id = current_registration_id;

  authority_route := CASE
    WHEN triage_source_digest IS NULL THEN 'human-ready'
    ELSE 'ai-triage-then-human-ready'
  END;
  authority_receipt_id := gen_random_uuid();
  authority_recorded_at := clock_timestamp();
  authority_payload := jsonb_build_object(
    'receiptId', authority_receipt_id,
    'receiptKey', 'authority',
    'releaseId', durable_release_id,
    'repository', current_repository,
    'issueNumber', current_issue_number,
    'producer', jsonb_build_object(
      'jobId', triage_job_id,
      'attemptId', current_attempt_id
    ),
    'causes', '[]'::jsonb,
    'recordedAt', to_char(
      authority_recorded_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'kind', 'authority',
    'route', authority_route,
    'actor', jsonb_build_object('type', 'human', 'login', authority_actor),
    'readyLabel', p_ready_label,
    'readyAt', to_char(
      authority_ready_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
  IF authority_route = 'ai-triage-then-human-ready' THEN
    authority_payload := authority_payload || jsonb_build_object(
      'triageInvocationId', triage_invocation_id,
      'triageCompletedAt', to_char(
        triage_completed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'sourceDigest', triage_source_digest,
      'decision', jsonb_build_object(
        'schemaVersion', 1,
        'readiness', triage_readiness
      )
    );
  END IF;
  INSERT INTO agentops_control.release_receipt_outbox(
    receipt_id, release_id, receipt_key, kind, repository, issue_number,
    head_sha, causes, payload, recorded_at
  ) VALUES (
    authority_receipt_id, durable_release_id, 'authority', 'authority',
    current_repository, current_issue_number, NULL, '{}'::uuid[],
    authority_payload, authority_recorded_at
  );
  IF authority_route = 'ai-triage-then-human-ready' THEN
    runtime_receipt_id := gen_random_uuid();
    runtime_recorded_at := clock_timestamp();
    INSERT INTO agentops_control.release_receipt_outbox(
      receipt_id, release_id, receipt_key, kind, repository, issue_number,
      head_sha, causes, payload, recorded_at
    ) VALUES (
      runtime_receipt_id, durable_release_id,
      'runtime:triage:' || triage_producer_job_id::text,
      'runtime-provenance', current_repository, current_issue_number,
      NULL, ARRAY[authority_receipt_id],
      jsonb_build_object(
        'receiptId', runtime_receipt_id,
        'receiptKey', 'runtime:triage:' || triage_producer_job_id::text,
        'releaseId', durable_release_id,
        'repository', current_repository,
        'issueNumber', current_issue_number,
        'producer', jsonb_build_object(
          'jobId', triage_producer_job_id,
          'attemptId', triage_producer_attempt_id
        ),
        'causes', jsonb_build_array(authority_receipt_id),
        'recordedAt', to_char(
          runtime_recorded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'kind', 'runtime-provenance',
        'consumer', triage_provenance->'consumer',
        'environment', triage_provenance->'environment',
        'invocations', jsonb_build_array(jsonb_build_object(
          'invocationId', triage_invocation_id,
          'role', 'triage',
          'provider', triage_provenance->>'provider',
          'model', triage_provenance->'model'
        ))
      ),
      runtime_recorded_at
    );
  END IF;
  INSERT INTO agentops_control.runtime_audit(
    actor_type, actor_id, event_type, registration_id, job_id, details
  ) VALUES (
    'triage', p_worker_id, 'release.identity.linked',
    current_registration_id, triage_job_id,
    jsonb_build_object(
      'releaseId', durable_release_id,
      'repository', current_repository,
      'issueNumber', current_issue_number,
      'promotedJobId', promoted_job_id
    )
  );
  RETURN QUERY SELECT promoted_job_id, durable_release_id;
END
$$;

REVOKE ALL ON FUNCTION agentops_control.promote_triage_release(
  uuid, text, jsonb, text, text, jsonb
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage') THEN
    EXECUTE
      'GRANT EXECUTE ON FUNCTION agentops_control.promote_triage_release(uuid, text, jsonb, text, text, jsonb) TO agentops_triage';
  END IF;
END
$$;

-- The runner receives release capabilities, never table DML. These functions
-- lock one release identity and re-check the bounded semantic preconditions at
-- the database boundary; callers still run the fuller TypeScript certifier.
CREATE FUNCTION agentops_control.observe_release_head(
  p_release_id uuid,
  p_head text,
  p_parent_head text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  release_status text;
  existing_epoch integer;
  existing_parent text;
  next_epoch integer;
BEGIN
  IF p_head !~ '^[0-9a-f]{40}$'
     OR (p_parent_head IS NOT NULL AND p_parent_head !~ '^[0-9a-f]{40}$') THEN
    RAISE EXCEPTION 'release head coordinates are invalid';
  END IF;
  SELECT status INTO release_status
    FROM agentops_control.releases
   WHERE id = p_release_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release does not exist'; END IF;
  SELECT head_epoch, parent_head INTO existing_epoch, existing_parent
    FROM agentops_control.release_heads
   WHERE release_id = p_release_id AND head_sha = p_head;
  IF FOUND THEN
    IF existing_parent IS DISTINCT FROM p_parent_head THEN
      RAISE EXCEPTION 'release head parent conflicts with durable epoch';
    END IF;
    RETURN existing_epoch;
  END IF;
  IF release_status <> 'collecting' THEN
    RAISE EXCEPTION 'release no longer accepts heads';
  END IF;
  IF p_parent_head IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agentops_control.release_heads
     WHERE release_id = p_release_id AND head_sha = p_parent_head
  ) THEN
    RAISE EXCEPTION 'release head parent is not durable';
  END IF;
  SELECT COALESCE(max(head_epoch), 0) + 1 INTO next_epoch
    FROM agentops_control.release_heads WHERE release_id = p_release_id;
  INSERT INTO agentops_control.release_heads(
    release_id, head_sha, head_epoch, parent_head
  ) VALUES (p_release_id, p_head, next_epoch, p_parent_head);
  RETURN next_epoch;
END
$$;

CREATE FUNCTION agentops_control.record_release_receipt(
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  rid uuid;
  durable_release_id uuid;
  v_receipt_key text;
  receipt_kind text;
  v_repository text;
  v_issue_number bigint;
  receipt_head text;
  receipt_causes uuid[];
  receipt_recorded_at timestamptz;
  producer_job_id uuid;
  durable agentops_control.releases%ROWTYPE;
  existing_payload jsonb;
  observed_epoch integer;
BEGIN
  rid := (p_payload->>'receiptId')::uuid;
  durable_release_id := (p_payload->>'releaseId')::uuid;
  v_receipt_key := p_payload->>'receiptKey';
  receipt_kind := p_payload->>'kind';
  v_repository := p_payload->>'repository';
  v_issue_number := (p_payload->>'issueNumber')::bigint;
  receipt_recorded_at := (p_payload->>'recordedAt')::timestamptz;
  receipt_causes := ARRAY(
    SELECT value::uuid FROM jsonb_array_elements_text(p_payload->'causes')
  );
  IF receipt_kind IN ('merge-intent', 'merge')
     OR receipt_kind NOT IN (
       'authority', 'runtime-provenance', 'build', 'grade', 'review',
       'finding-resolution', 'intervention'
     ) THEN
    RAISE EXCEPTION 'receipt kind requires a different release capability';
  END IF;
  IF receipt_kind = 'authority' AND session_user = 'agentops_runner' THEN
    RAISE EXCEPTION 'runner cannot create release authority';
  END IF;
  SELECT * INTO durable FROM agentops_control.releases
   WHERE id = durable_release_id FOR UPDATE;
  IF NOT FOUND OR durable.status <> 'collecting'
     OR durable.repository <> v_repository
     OR durable.issue_number <> v_issue_number
     OR receipt_recorded_at < durable.created_at THEN
    RAISE EXCEPTION 'receipt does not match a collecting release';
  END IF;
  IF p_payload->'producer' ? 'jobId' THEN
    producer_job_id := (p_payload->'producer'->>'jobId')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM agentops_control.jobs
       WHERE id = producer_job_id AND release_id = durable.id
    ) THEN
      RAISE EXCEPTION 'receipt producer is not linked to this release';
    END IF;
  END IF;
  IF receipt_kind = 'build' THEN
    receipt_head := p_payload->>'head';
    observed_epoch := agentops_control.observe_release_head(
      durable_release_id, receipt_head, p_payload->>'parentHead'
    );
  ELSIF receipt_kind IN ('grade', 'review') THEN
    receipt_head := p_payload->>'head';
    SELECT head_epoch INTO observed_epoch
      FROM agentops_control.release_heads
     WHERE release_id = durable.id AND head_sha = receipt_head;
    IF observed_epoch IS NULL OR (
      receipt_kind = 'review'
      AND observed_epoch <> (p_payload->>'headEpoch')::integer
    ) THEN
      RAISE EXCEPTION 'receipt head epoch is not durable';
    END IF;
  END IF;
  INSERT INTO agentops_control.release_receipt_outbox(
    receipt_id, release_id, receipt_key, kind, repository, issue_number,
    head_sha, causes, payload, recorded_at
  ) VALUES (
    rid, durable_release_id, v_receipt_key, receipt_kind,
    v_repository, v_issue_number,
    receipt_head, receipt_causes, p_payload, receipt_recorded_at
  ) ON CONFLICT (release_id, receipt_key) DO NOTHING;
  SELECT payload INTO existing_payload
    FROM agentops_control.release_receipt_outbox
   WHERE release_receipt_outbox.release_id = durable.id
     AND release_receipt_outbox.receipt_key = v_receipt_key;
  IF existing_payload IS DISTINCT FROM p_payload THEN
    RAISE EXCEPTION 'receipt key was reused with different evidence';
  END IF;
  RETURN existing_payload;
END
$$;

CREATE FUNCTION agentops_control.authorize_release_merge(
  p_intent jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  durable agentops_control.releases%ROWTYPE;
  v_release_id uuid := (p_intent->>'releaseId')::uuid;
  intent_id uuid := (p_intent->>'receiptId')::uuid;
  v_intent_key text := p_intent->>'receiptKey';
  v_expected_head text := p_intent->>'expectedHead';
  v_pull_request bigint := (p_intent->>'pullRequest')::bigint;
  v_causes uuid[] := ARRAY(
    SELECT value::uuid FROM jsonb_array_elements_text(p_intent->'causes')
  );
  existing_payload jsonb;
BEGIN
  SELECT * INTO durable FROM agentops_control.releases
   WHERE id = v_release_id FOR UPDATE;
  IF NOT FOUND OR durable.status NOT IN ('collecting', 'merge-authorized')
     OR p_intent->>'kind' <> 'merge-intent'
     OR durable.repository <> p_intent->>'repository'
     OR durable.issue_number <> (p_intent->>'issueNumber')::bigint
     OR v_expected_head !~ '^[0-9a-f]{40}$'
     OR v_expected_head <> p_intent->>'observedPrHead'
     OR v_pull_request < 1 THEN
    RAISE EXCEPTION 'merge intent coordinates are invalid';
  END IF;
  IF durable.status = 'merge-authorized' AND (
    durable.final_head <> v_expected_head
    OR durable.pull_request_number <> v_pull_request
  ) THEN
    RAISE EXCEPTION 'release was authorized for different coordinates';
  END IF;
  IF (SELECT count(*) FROM agentops_control.release_receipt_outbox
       WHERE release_receipt_outbox.release_id = durable.id
         AND kind = 'authority') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM agentops_control.release_receipt_outbox
        WHERE release_receipt_outbox.release_id = durable.id
          AND kind = 'runtime-provenance'
     )
     OR NOT EXISTS (
       SELECT 1 FROM agentops_control.release_receipt_outbox
        WHERE release_receipt_outbox.release_id = durable.id
          AND kind = 'build' AND head_sha = v_expected_head
     ) THEN
    RAISE EXCEPTION 'release lacks authority, runtime, or final build evidence';
  END IF;
  IF durable.policy->>'authority' = 'ai-triage-required' AND NOT EXISTS (
    SELECT 1 FROM agentops_control.release_receipt_outbox
     WHERE release_receipt_outbox.release_id = durable.id
       AND kind = 'authority'
       AND payload->>'route' = 'ai-triage-then-human-ready'
  ) THEN
    RAISE EXCEPTION 'release lacks required AI triage authority';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(durable.policy->'requiredGateSignals') signal
     WHERE NOT EXISTS (
       SELECT 1 FROM agentops_control.release_receipt_outbox receipt
        WHERE receipt.release_id = durable.id AND receipt.kind = 'grade'
          AND receipt.head_sha = v_expected_head
          AND receipt.payload->'signal' = signal
          AND receipt.payload->>'status' = 'passed'
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(
        durable.policy->'requiredReviewPerspectives'
      ) perspective
     WHERE NOT EXISTS (
       SELECT 1 FROM agentops_control.release_receipt_outbox receipt
        WHERE receipt.release_id = durable.id AND receipt.kind = 'review'
          AND receipt.head_sha = v_expected_head
          AND receipt.payload->>'perspective' = perspective
          AND receipt.payload->>'verdict' = 'approved'
     )
  ) THEN
    RAISE EXCEPTION 'release lacks a required final-head gate or review';
  END IF;
  IF (SELECT count(*) FROM agentops_control.release_heads
       WHERE release_heads.release_id = durable.id)
       < (durable.policy->>'minimumHeadEpochs')::integer THEN
    RAISE EXCEPTION 'release lacks required head epochs';
  END IF;
  IF EXISTS (
    SELECT 1 FROM agentops_control.release_receipt_outbox receipt
     WHERE receipt.release_id = durable.id
       AND NOT (p_intent->'causes' ? receipt.receipt_id::text)
  ) THEN
    RAISE EXCEPTION 'merge intent does not include every durable receipt cause';
  END IF;
  INSERT INTO agentops_control.release_receipt_outbox(
    receipt_id, release_id, receipt_key, kind, repository, issue_number,
    head_sha, causes, payload, recorded_at
  ) VALUES (
    intent_id, durable.id, v_intent_key, 'merge-intent', durable.repository,
    durable.issue_number, v_expected_head, v_causes, p_intent,
    (p_intent->>'recordedAt')::timestamptz
  ) ON CONFLICT (release_id, receipt_key) DO NOTHING;
  SELECT payload INTO existing_payload
    FROM agentops_control.release_receipt_outbox
   WHERE release_receipt_outbox.release_id = durable.id
     AND release_receipt_outbox.receipt_key = v_intent_key;
  IF existing_payload IS DISTINCT FROM p_intent THEN
    RAISE EXCEPTION 'merge intent conflicts with durable authorization';
  END IF;
  UPDATE agentops_control.releases
     SET status = 'merge-authorized', pull_request_number = v_pull_request,
         final_head = v_expected_head, updated_at = clock_timestamp()
   WHERE id = durable.id;
  RETURN durable.id;
END
$$;

CREATE FUNCTION agentops_control.complete_release_merge(
  p_receipt jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  durable agentops_control.releases%ROWTYPE;
  v_release_id uuid := (p_receipt->>'releaseId')::uuid;
  merge_id uuid := (p_receipt->>'receiptId')::uuid;
  v_merge_key text := p_receipt->>'receiptKey';
  intent agentops_control.release_receipt_outbox%ROWTYPE;
  v_causes uuid[] := ARRAY(
    SELECT value::uuid FROM jsonb_array_elements_text(p_receipt->'causes')
  );
  existing_payload jsonb;
BEGIN
  SELECT * INTO durable FROM agentops_control.releases
   WHERE id = v_release_id FOR UPDATE;
  SELECT * INTO intent FROM agentops_control.release_receipt_outbox
   WHERE release_receipt_outbox.release_id = v_release_id
     AND kind = 'merge-intent';
  IF NOT FOUND OR durable.status NOT IN ('merge-authorized', 'merged')
     OR p_receipt->>'kind' <> 'merge'
     OR durable.repository <> p_receipt->>'repository'
     OR durable.issue_number <> (p_receipt->>'issueNumber')::bigint
     OR durable.pull_request_number <> (p_receipt->>'pullRequest')::bigint
     OR durable.final_head <> p_receipt->>'expectedHead'
     OR durable.final_head <> p_receipt->>'observedPrHead'
     OR p_receipt->>'issueState' <> 'CLOSED'
     OR p_receipt->>'issueStateReason' <> 'COMPLETED'
     OR p_receipt->>'mergeReachableFromDefaultBranch' <> 'true'
     OR NOT (p_receipt->'causes' ? intent.receipt_id::text) THEN
    RAISE EXCEPTION 'merge observation lacks matching durable authorization';
  END IF;
  INSERT INTO agentops_control.release_receipt_outbox(
    receipt_id, release_id, receipt_key, kind, repository, issue_number,
    head_sha, causes, payload, recorded_at
  ) VALUES (
    merge_id, durable.id, v_merge_key, 'merge', durable.repository,
    durable.issue_number, durable.final_head, v_causes, p_receipt,
    (p_receipt->>'recordedAt')::timestamptz
  ) ON CONFLICT (release_id, receipt_key) DO NOTHING;
  SELECT payload INTO existing_payload
    FROM agentops_control.release_receipt_outbox
   WHERE release_receipt_outbox.release_id = durable.id
     AND release_receipt_outbox.receipt_key = v_merge_key;
  IF existing_payload IS DISTINCT FROM p_receipt THEN
    RAISE EXCEPTION 'merge observation conflicts with durable result';
  END IF;
  IF durable.status = 'merged' AND (
    durable.merge_sha <> p_receipt->>'mergeSha'
    OR durable.merge_actor <> p_receipt->>'actor'
  ) THEN
    RAISE EXCEPTION 'completed release conflicts with merge observation';
  END IF;
  UPDATE agentops_control.releases
     SET status = 'merged', merge_sha = p_receipt->>'mergeSha',
         merge_actor = p_receipt->>'actor',
         completed_at = (p_receipt->>'mergedAt')::timestamptz,
         updated_at = clock_timestamp()
   WHERE id = durable.id;
  RETURN durable.id;
END
$$;

CREATE FUNCTION agentops_control.record_release_artifact(
  p_artifact_key text,
  p_artifact jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_release_id uuid := (p_artifact->>'releaseId')::uuid;
  v_source_head text := p_artifact->>'sourceHead';
  v_receipt_ids uuid[] := ARRAY(
    SELECT value::uuid FROM jsonb_array_elements_text(p_artifact->'receiptIds')
  );
  existing jsonb;
BEGIN
  IF p_artifact_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
     OR NOT EXISTS (
       SELECT 1 FROM agentops_control.releases
        WHERE id = v_release_id
          AND (final_head IS NULL OR final_head = v_source_head)
     )
     OR NOT EXISTS (
       SELECT 1 FROM agentops_control.release_receipt_outbox
        WHERE release_receipt_outbox.release_id = v_release_id
          AND kind = 'build' AND head_sha = v_source_head
     ) THEN
    RAISE EXCEPTION 'release artifact coordinates are invalid';
  END IF;
  INSERT INTO agentops_control.release_artifacts(
    id, release_id, artifact_key, kind, uri, sha256, size_bytes,
    source_head, receipt_ids
  ) VALUES (
    gen_random_uuid(), v_release_id, p_artifact_key, p_artifact->>'kind',
    p_artifact->>'uri', p_artifact->>'sha256',
    (p_artifact->>'sizeBytes')::bigint, v_source_head, v_receipt_ids
  ) ON CONFLICT (release_id, artifact_key) DO NOTHING;
  SELECT jsonb_build_object(
    'kind', kind, 'uri', uri, 'sha256', sha256,
    'sizeBytes', size_bytes, 'releaseId', release_id,
    'sourceHead', source_head, 'receiptIds', to_jsonb(receipt_ids)
  ) INTO existing
    FROM agentops_control.release_artifacts
   WHERE release_artifacts.release_id = v_release_id
     AND artifact_key = p_artifact_key;
  IF existing IS DISTINCT FROM p_artifact THEN
    RAISE EXCEPTION 'artifact key was reused with different evidence';
  END IF;
  RETURN existing;
END
$$;

REVOKE ALL ON FUNCTION agentops_control.observe_release_head(uuid, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentops_control.record_release_receipt(jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentops_control.authorize_release_merge(jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentops_control.complete_release_merge(jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentops_control.record_release_artifact(text, jsonb)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    GRANT SELECT ON agentops_control.release_heads,
      agentops_control.release_receipt_outbox,
      agentops_control.release_artifacts TO agentops_runner;
    GRANT EXECUTE ON FUNCTION
      agentops_control.record_release_receipt(jsonb),
      agentops_control.authorize_release_merge(jsonb),
      agentops_control.complete_release_merge(jsonb),
      agentops_control.record_release_artifact(text, jsonb)
      TO agentops_runner;
  END IF;
END
$$;
