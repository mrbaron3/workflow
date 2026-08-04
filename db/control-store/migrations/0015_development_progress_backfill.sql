-- v14 can describe every new runner transition and any lease that was active
-- during migration. Reconstruct the terminal jobs that predate it so an
-- already-claimed Issue never appears as "no durable events".
WITH candidates AS (
  SELECT DISTINCT ON (job.id)
         job.registration_id,
         job.registration_version,
         job.id AS job_id,
         attempt.id AS attempt_id,
         release.id AS release_id,
         registration.repository,
         CASE WHEN release.issue_number IS NOT NULL THEN 'issue'
              ELSE job.payload->'event'->>'kind' END AS subject_kind,
         COALESCE(
           release.issue_number,
           CASE WHEN job.payload->'event'->>'kind' <> 'repository'
             THEN (job.payload->'event'->>'number')::bigint END
         ) AS subject_number,
         attempt.worker_id,
         CASE
           WHEN job.status = 'succeeded'
             AND job.result->>'outcome' = 'needs-human-review'
             THEN 'human-review'
           WHEN job.status = 'succeeded' THEN 'completed'
           ELSE 'failed'
         END AS phase,
         CASE
           WHEN job.status = 'succeeded'
             AND job.result->>'outcome' = 'needs-human-review'
             THEN 'planning clarification required'
           WHEN job.status = 'succeeded'
             AND release.status = 'merged'
             THEN 'implementation released'
           WHEN job.status = 'succeeded' THEN 'runner job completed'
           ELSE 'runner job terminated'
         END AS step,
         CASE
           WHEN job.status = 'succeeded'
             AND job.result->>'outcome' = 'needs-human-review'
             THEN 'blocked'
           WHEN job.status = 'succeeded' THEN 'succeeded'
           ELSE 'failed'
         END AS progress_state,
         CASE
           WHEN job.status = 'succeeded'
             AND release.status = 'merged'
             THEN 'Implementation merged before durable phase reporting was installed'
           WHEN job.status = 'succeeded'
             AND job.result->>'outcome' = 'needs-human-review'
             THEN 'Human planning judgment is required; inspect the managed Issue comment'
           WHEN job.status = 'succeeded'
             THEN 'Runner completed before durable phase reporting was installed'
           ELSE 'Runner stopped before durable phase reporting was installed'
         END AS summary,
         CASE
           WHEN job.status = 'succeeded'
             AND job.result->>'outcome' = 'needs-human-review'
             THEN 'human updates the Issue and reapplies the ready label'
           WHEN job.status = 'succeeded' THEN NULL
           ELSE 'operator resolves the blocker and authorizes a new runner attempt'
         END AS next_gate,
         CASE
           WHEN job.status IN ('failed', 'cancelled', 'rejected')
             THEN COALESCE(job.last_error, job.status)
           WHEN job.result->>'outcome' = 'needs-human-review'
             THEN 'human planning judgment required'
           ELSE NULL
         END AS blocker,
         COALESCE(
           release.pull_request_number,
           CASE WHEN pg_input_is_valid(job.result->>'pullRequestNumber', 'bigint')
             THEN (job.result->>'pullRequestNumber')::bigint END
         ) AS pull_request_number,
         COALESCE(job.finished_at, attempt.finished_at, job.updated_at) AS occurred_at
    FROM agentops_control.jobs job
    JOIN agentops_control.repository_registrations registration
      ON registration.id = job.registration_id
    JOIN agentops_control.job_attempts attempt ON attempt.job_id = job.id
    LEFT JOIN agentops_control.releases release ON release.id = job.release_id
    LEFT JOIN agentops_control.development_progress_events progress
      ON progress.job_id = job.id
   WHERE job.job_type = 'agentops.runner'
     AND job.status IN ('succeeded', 'failed', 'cancelled', 'rejected')
     AND progress.id IS NULL
     AND (
       release.issue_number IS NOT NULL
       OR job.payload->'event'->>'kind' = 'repository'
       OR pg_input_is_valid(job.payload->'event'->>'number', 'bigint')
     )
   ORDER BY job.id, attempt.attempt_number DESC, attempt.id DESC
)
INSERT INTO agentops_control.development_progress_events(
  registration_id, registration_version, job_id, attempt_id, release_id,
  repository, subject_kind, subject_number, worker_id, event_key, phase,
  step, state, summary, next_gate, blocker, pull_request_number, occurred_at
)
SELECT registration_id, registration_version, job_id, attempt_id, release_id,
       repository, subject_kind, subject_number, worker_id,
       'migration:terminal-job', phase, step, progress_state, summary,
       next_gate, blocker, pull_request_number, occurred_at
  FROM candidates
 WHERE subject_kind IN ('issue', 'pull_request', 'repository')
   AND (
     (subject_kind = 'repository' AND subject_number IS NULL)
     OR (subject_kind <> 'repository' AND subject_number > 0)
   )
ON CONFLICT (job_id, event_key) DO NOTHING;
