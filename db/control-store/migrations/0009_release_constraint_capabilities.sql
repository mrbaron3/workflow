-- Deferred constraint triggers run when the caller's statement/transaction
-- finishes, after a SECURITY DEFINER capability function has returned. Keep
-- their integrity reads inside the same privileged boundary instead of
-- granting worker roles direct access to release evidence tables.
ALTER FUNCTION agentops_control.validate_release_receipt_causes()
  SECURITY DEFINER;
ALTER FUNCTION agentops_control.validate_release_artifact_receipts()
  SECURITY DEFINER;

REVOKE ALL ON FUNCTION agentops_control.validate_release_receipt_causes()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentops_control.validate_release_artifact_receipts()
  FROM PUBLIC;
