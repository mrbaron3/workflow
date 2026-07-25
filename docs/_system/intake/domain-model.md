# ドメインモデル — intake コンテキスト

- **DOM-intake-001 IntakeRecord** — 集約ルート。identity=`LANG-intake-003`、所有: immutable Source Snapshot、
  claim state、claimedAt、将来のstoreIssueId。1 Intake Identityにつき最大1件。
- **DOM-intake-002 GitHubIssueSnapshot** — 外部adapterから受ける値オブジェクト。repository/number/title/body/
  url/labels/state/updatedAt。schema検証後だけIntakeRecordへ写る。
- **DOM-intake-003 IntakeWatcher** — Source Issue一覧を受け、ready filter・stable sort・dedup・claim retryを行う
  domain service。Issue Contractを生成しない。
- **DOM-intake-009 PlanningEnrichment** — 1 IntakeRecordにつき最大1件の監査record。planning invocation、
  Acceptance Trace、判定理由、生成Issue集合を所有する。
- **DOM-intake-010 EnrichmentCandidate** — candidateKey、title/type/area、IssueContract、ACごとのAcceptance Traceを
  持つ値オブジェクト。candidateKeyは同じenrichment内で一意。

## 不変条件

- **DOM-intake-004 idempotent claim** — duplicate poll/restartで同じIntake Identityをappendしない。
  claimed recordは外部claimも再実行せず、claim-pendingだけをretryする。
- **DOM-intake-005 store-first durability** — external claimより前にidentity/snapshot/claim-pendingをstore.saveする。
  external failure後も次pollが在庫を発見でき、sourceを失わない。
- **DOM-intake-006 immutable original** — 同じSource Issueのtitle/body/labelsが後から変化しても初回snapshotを
  last-write-winsで上書きしない。更新履歴は将来additive eventとして扱う。
- **DOM-intake-007 explicit ready only** — openかつReady Signalを持つSource Issueだけを対象にし、closed/unlabelledを
  推測取込しない。
- **DOM-intake-008 repository isolation** — 1 Organization StoreのIntakeRecordは1 repositoryだけに属する。
  同じissue numberはrepositoryを含むkeyで衝突しないが、configを別repositoryへ変えた同一storeへの取込は拒否する。
- **DOM-intake-011 trace completeness** — Candidateの全ACはちょうど1つのtrace entryを持ち、entryは1つ以上の
  実在Source text/system elementを指す。extra/duplicate/dangling traceはCandidate全体を拒否する。
- **DOM-intake-012 ambiguity gate** — Planning Ambiguityが1件でもある、schema/traceが不正、またはplanning provenanceが
  無い場合はstore Issueを1件も作らずIntakeRecordをneeds-human-reviewへ進める。
- **DOM-intake-013 enrichment idempotency** — 同じIntakeRecordへenrichmentを再適用してもIssue/counterを増やさず、
  初回判定とIssue集合を返す。
- **DOM-intake-014 conditional UI readiness gate** — areaがfrontend/fullstackのCandidateはUI Design Readinessを
  必須とする。artifactが不在・曖昧・schema/trace/provenance不正ならenrichment全体をneeds-human-reviewへ止め、
  backendへ偽装分類したりgeneric generatorへ投影したりしない。backend Candidateには影響しない。
- **DOM-intake-015 UiDesignArtifact** — candidateKey、principles、tokens、components、criterionTracesを持つ値
  オブジェクト。tokens/componentsは一意id、根拠AC、component states/interactions/accessibilityを所有する。
- **DOM-intake-016 UI design integrity** — UI Candidateの全ACはちょうど1つのcriterionTraceを持ち、参照先は同じ
  artifact内の一意なtoken/component idでなければならない。全要素のsourceCriterionIdsは実在ACを指す。
  対応Invocationはrole=ui-designer、candidate固有subject、completedでなければ採用しない。
- **DOM-intake-017 ExperienceDesignRequest** — Source Snapshot、要求trace、surface、制約、任意のdesign system
  base revisionから作る値オブジェクト。provider固有prompt、workflow Issue ID、HTTP endpoint案を含めない。
- **DOM-intake-018 DesignBundleReference** — request/revision identity、manifest location、source digest、
  bundle digest、schema versionを持つ外部成果物参照。bundle内容をstoreへdual-writeしない。
- **DOM-intake-019 CapabilityReconciliation** — approve済みCapability Requirementごとに、最終Issue/AC/system element
  への充足edgeを所有する。全capabilityが1つ以上の実在edgeを持つまでqueue projectionを許さない。
- **DOM-intake-020 digest-bound design authority** — Human Design Decisionは同じrequestId、revisionId、
  bundleDigestにだけ適用する。digest不一致、未承認、request-changes/reject、ambiguity残存は
  `needs-human-review`へ止める。
- **DOM-intake-021 single provider per revision** — 同じcandidate/revisionでlegacy `UiDesignArtifact`と外部
  Design Bundleを同時に正本化しない。backend-onlyはdesign gate不要、frontend/fullstackは選択providerの
  完全な検証を必須とする。
