-- SELECT ... FOR SHARE requires table UPDATE privilege. Runner roles must not
-- receive release UPDATE merely to make a completion/failure decision, so the
-- lock and bounded projection live behind a SECURITY DEFINER capability.
CREATE FUNCTION agentops_control.lock_release_completion_state(
  p_job_id uuid,
  p_release_id uuid
) RETURNS TABLE (
  status text,
  final_head text,
  pull_request_number bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT release.status, release.final_head, release.pull_request_number
    FROM agentops_control.releases release
    JOIN agentops_control.jobs job
      ON job.id = p_job_id
     AND job.release_id = release.id
   WHERE release.id = p_release_id
     AND (
       session_user <> 'agentops_runner'
       OR job.job_type = 'agentops.runner'
     )
   FOR SHARE OF release;
END
$$;

REVOKE ALL ON FUNCTION agentops_control.lock_release_completion_state(uuid, uuid)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    GRANT EXECUTE ON FUNCTION
      agentops_control.lock_release_completion_state(uuid, uuid)
      TO agentops_runner;
  END IF;
END
$$;
