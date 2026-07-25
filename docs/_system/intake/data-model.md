# データモデル — intake コンテキスト

- **DATA-intake-001 `GithubIssueSnapshot`** — repository、positive number、externalId、title、body、url、labels、
  `state:'open'|'closed'`、sourceUpdatedAt、snapshotAt。
- **DATA-intake-002 `IntakeRecord`** — id、`intakeKey`、provider=`github`、snapshot、
  `status:'claim-pending'|'claimed'|'planning'|'ready'|'needs-human-review'`、nullable claimedAt、`storeIssueIds[]`。
- **DATA-intake-003 `DB.intakeRecords`** — additive `default([])`。logical unique keyはintakeKey。
- **DATA-intake-004 `HarnessConfig.intake`** — optional `{backend:'github', repository, readyLabel?, claimedLabel?}`。
  label既定は`ready`/`agent-claimed`。repositoryは`owner/name`のremote identityで、local target pathを代用しない。
- **DATA-intake-005 `PlanningEnrichmentRecord`** — id/intakeKey/invocationKey/status/reasons、normalized traces、issueIds、
  createdAt。raw agent output全文はAgentInvocation.prompt/evidenceが所有し、本recordはgate判定とtrace edgeを所有する。
- **DATA-intake-006 `Issue.intakeKey/planningCandidateKey`** — nullable additive source back-reference。nullはlegacy/spec/adopt経路。
- **DATA-intake-007 `DB.planningEnrichments`** — additive `default([])`、logical unique key=intakeKey。
- **DATA-intake-008 Planning workspace/evidence** — `.harness/planning-worktrees/<intake>`と
  `.harness/planning-evidence/<intake>`の揮発実体。prompt/outputはAgentInvocation/PlanningEnrichmentRecordへ投影後、
  completed workspaceを破棄する。
- **DATA-intake-009 UI design projection/evidence** — `Issue.uiDesign`/`uiDesignInvocationKey`はnullable additive、
  `PlanningEnrichmentRecord.uiDesignCandidateKeys[]`/`uiDesignInvocationKeys{}`はdefault空。session実体は
  `.harness/ui-design-worktrees/<intake-candidate>`、sidecarは`.harness/ui-design-evidence/<intake-candidate>`。
- **DATA-intake-010 external design projection** — 将来の`PlanningEnrichmentRecord.experienceDesign`は
  provider id、schema version、requestId、revisionId、manifest locator、sourceDigest、bundleDigestだけを保持する。
  bundle本体はprovider/artifact storeの正本を参照し、DBへ複製しない。
- **DATA-intake-011 human design decision reference** — decision id、actor、decision、decidedAt、revisionId、
  bundleDigestを監査参照として保持する。decision本文とpreviewはbundle側artifactへの参照とする。
- **DATA-intake-012 capability trace projection** — capabilityIdから最終Issue id、criterion id、system element idへの
  1..N edgeを保持する。dangling/zero coverage/異revision混在をschema適用前のall-or-nothing gateで拒否する。
