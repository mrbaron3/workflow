-- Bind the GitHub PR to its release as soon as the PR exists. Recovery work is
-- scheduled independently from the originating Issue job, so waiting until
-- merge authorization to persist this coordinate prevents that later job from
-- recovering the stable release identity.
CREATE UNIQUE INDEX releases_one_open_per_pull_request
  ON agentops_control.releases(registration_id, pull_request_number)
  WHERE status IN ('collecting', 'merge-authorized')
    AND pull_request_number IS NOT NULL;

CREATE FUNCTION agentops_control.bind_release_pull_request(
  p_job_id uuid,
  p_release_id uuid,
  p_pull_request_number bigint
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  bound bigint;
BEGIN
  IF p_pull_request_number < 1 OR p_pull_request_number > 2147483647 THEN
    RAISE EXCEPTION 'release pull request number is invalid';
  END IF;

  UPDATE agentops_control.releases release
     SET pull_request_number = p_pull_request_number,
         updated_at = clock_timestamp()
    FROM agentops_control.jobs job
   WHERE release.id = p_release_id
     AND job.id = p_job_id
     AND job.release_id = release.id
     AND job.registration_id = release.registration_id
     AND (session_user <> 'agentops_runner' OR job.job_type = 'agentops.runner')
     AND release.status IN ('collecting', 'merge-authorized')
     AND (
       release.pull_request_number IS NULL
       OR release.pull_request_number = p_pull_request_number
     )
  RETURNING release.pull_request_number INTO bound;

  IF bound IS NULL THEN
    RAISE EXCEPTION 'job cannot bind the pull request to this release';
  END IF;
  RETURN bound;
END
$$;

REVOKE ALL ON FUNCTION
  agentops_control.bind_release_pull_request(uuid, uuid, bigint)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    GRANT EXECUTE ON FUNCTION
      agentops_control.bind_release_pull_request(uuid, uuid, bigint)
      TO agentops_runner;
  END IF;
END
$$;
