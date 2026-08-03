-- Repair the runner release-head capability for already-migrated deployments,
-- and keep release policy review requirements within the perspectives the
-- production runner can actually emit.
CREATE OR REPLACE FUNCTION agentops_control.valid_release_evidence_configuration(
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
     ) NOT BETWEEN 2 AND 7
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

ALTER TABLE agentops_control.repository_registrations
  DROP CONSTRAINT repository_registrations_release_evidence_configuration;
ALTER TABLE agentops_control.repository_registrations
  ADD CONSTRAINT repository_registrations_release_evidence_configuration
  CHECK (agentops_control.valid_release_evidence_configuration(configuration));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
    GRANT EXECUTE ON FUNCTION
      agentops_control.observe_release_head(uuid, text, text)
      TO agentops_runner;
  END IF;
END
$$;
