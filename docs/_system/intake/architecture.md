# アーキテクチャ — intake コンテキスト

- **ARCH-intake-001 GitHub Issue source port** — publicな形:
  `listReadyIssues(repository, readyLabel): GitHubIssueSnapshot[]`、
  `claimIssue(repository, number, readyLabel, claimedLabel): void`。GitHub I/Oはadapter内。
- **ARCH-intake-002 deterministic poll/claim** — publicな形:
  `pollAndClaimGithubIssues(store, config, runner): IntakePollResult[]`。snapshotをschema検証し、number順で処理、
  store-first pending保存→external claim→claimed保存を行う。
- **ARCH-intake-003 intake configuration** — `config.intake`がbackend/repository/readyLabel/claimedLabelを供給。
  未設定は入口無効、部分設定や非GitHub backendはfail-closed。
- **ARCH-intake-004 planning handoff** — claimed IntakeRecordはFEAT-017 planning enrichmentへの入力。
  FEAT-016ではstore Issue/IssueContractを作らず、粗いWHATとclaim状態までで停止する。
- **ARCH-intake-005 execution independence** — intake watcherはexecution guardへ直接投入しない。
  FEAT-017がschema-valid contractと帰属を作るまで既存queueは不変。
- **ARCH-intake-006 planning output contract** — publicな形: `PlanningEnrichmentOutput`（1..N Candidate、各AC trace、
  ambiguities）。Zodでagent boundaryを検証し、raw proseを直接store Issueへ写さない。
- **ARCH-intake-007 trace validator / gate** — publicな形:
  `applyPlanningEnrichment(store, config, intakeKey, output, {systemDir, invocationKey})`。Source text包含、system id解決、
  AC coverage、candidate key一意性を全件先に検証し、all-or-nothingでIssueを生成またはneeds-human-reviewへ停止する。
- **ARCH-intake-008 queue projection** — accepted Candidateを`contract-drafted`かつresolved generator provider assignedの
  store Issueへ写す。IssueはintakeKey/candidateKeyを保持し、以後は既存execution guardだけが扱う。
- **ARCH-intake-009 development turn orchestration** — publicな形:
  `runGithubDevelopmentTurn(store, config, deps): {intake,enrichments,driveResults}`。poll/claim→planning session→
  trace gate→既存`runLoopLive`を順序固定で合成する。各段はstore状態から再開し、planner/driveはinject可能。
- **ARCH-intake-010 planning session backend** — claimed snapshotごとにdetached planning workspaceとsidecar evidenceを
  作り、resolved planning routeのinteractive providerで`PlanningEnrichmentOutput`を生成する。source checkout変更は
  採用せず、sentinel/liveness/AgentInvocationは既存agent-runtime/execution契約を再利用する。
- **ARCH-intake-011 UI design readiness guard** — `requiresUiDesign(candidate)`がfrontend/fullstackを決定論分類し、
  `applyPlanningEnrichment`のall-or-nothing validation内で検証済みUI design artifactの不在・不正を理由付きfailureにする。
  planning promptはUI workをbackendへ再分類しないよう契約化する。
- **ARCH-intake-012 dedicated UI design session** — publicな形:
  `runUiDesignSession(config, intake, candidate, route): UiDesignSessionResult`。Candidateごとにfresh detached worktreeと
  sidecar evidenceを作り、`ui-design` routeの専用personaへSource Snapshot・Candidate・system viewだけを渡す。
  checkout変更は失敗、曖昧さはartifact=null、completed時だけworkspaceを破棄する。
- **ARCH-intake-013 UI validation / queue projection** — `applyPlanningEnrichment`が`UiDesignOutput` schema、AC↔design
  element完全性、invocation role/subject/outcomeを決定論検証する。通過時だけartifactとinvocationKeyをIssueへ写し、
  generator/reviewer promptへ同じUI契約を供給する。backendへのunexpected artifactはfail-closed。
