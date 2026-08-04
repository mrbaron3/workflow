-- A v17 migration-abandoned release may have preserved an open PR. After a
-- human reapplies ready, bind that single audited coordinate to the new frozen-
-- requirements release instead of restarting planning and generating a new PR.

CREATE FUNCTION agentops_control.recover_requirements_upgrade_pull_request(
  p_job_id uuid,
  p_release_id uuid
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  durable_registration_id uuid;
  durable_issue_number bigint;
  preserved_pull_requests bigint[];
  preserved_pull_request bigint;
BEGIN
  SELECT release.registration_id, release.issue_number
    INTO durable_registration_id, durable_issue_number
    FROM agentops_control.jobs job
    JOIN agentops_control.releases release
      ON release.id = p_release_id
     AND job.release_id = release.id
     AND job.registration_id = release.registration_id
   WHERE job.id = p_job_id
     AND job.job_type = 'agentops.runner'
     AND release.status = 'collecting'
     AND release.pull_request_number IS NULL
     AND (session_user <> 'agentops_runner' OR job.job_type = 'agentops.runner')
   FOR UPDATE OF release;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'requirements-upgrade recovery requires the current collecting runner release';
  END IF;

  SELECT array_agg(
           DISTINCT legacy.pull_request_number
           ORDER BY legacy.pull_request_number
         )
    INTO preserved_pull_requests
    FROM agentops_control.runtime_audit audit
    JOIN agentops_control.releases legacy
      ON legacy.id = (audit.details->>'releaseId')::uuid
   WHERE audit.event_type = 'release.abandoned.requirements-upgrade'
     AND legacy.registration_id = durable_registration_id
     AND legacy.issue_number = durable_issue_number
     AND legacy.status = 'abandoned'
     AND legacy.pull_request_number IS NOT NULL;

  IF cardinality(preserved_pull_requests) > 1 THEN
    RAISE EXCEPTION
      'requirements-upgrade recovery matches more than one pull request';
  END IF;
  preserved_pull_request := preserved_pull_requests[1];
  IF preserved_pull_request IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN agentops_control.bind_release_pull_request(
    p_job_id, p_release_id, preserved_pull_request
  );
END
$$;

REVOKE ALL ON FUNCTION
  agentops_control.recover_requirements_upgrade_pull_request(uuid, uuid)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    GRANT EXECUTE ON FUNCTION
      agentops_control.recover_requirements_upgrade_pull_request(uuid, uuid)
      TO agentops_runner;
  END IF;
END
$$;
