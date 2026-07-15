# Conditional UI-design readiness gate 受け入れ要件

## 意図

- 機能: Conditional UI-design readiness gate
- outcome: frontend/fullstackのWHATを検証済みUI design artifactなしにgeneric generatorへ流さず、backend intakeを
  妨げない明示的な停止境界を持つ。
- 計画の木リンク: feature=FEAT-020 epic=EPIC-10

## 受け入れ基準

- **[AC-UIDGATE-001] frontend CandidateはUI design readinessを要求する**
  - Givenarea=frontendのschema-valid Candidateがある
  - Whenplanning enrichment gateを評価する
  - Then検証済みUI design artifact不在を理由にneeds-human-reviewへ停止し、Issueを作らない

- **[AC-UIDGATE-002] fullstack Candidateも同じUI境界を通る**
  - Givenarea=fullstackのCandidateがある
  - Whenplanning enrichment gateを評価する
  - Thenbackend部分だけを先行させず、frontendと同じUI readiness failureになる

- **[AC-UIDGATE-003] backend Candidateは従来経路を維持する**
  - Givenarea=backendでtrace-completeなCandidateがある
  - Whenplanning enrichment gateを評価する
  - ThenUI readinessを要求せず、既存のaccepted queue projectionへ進める

- **[AC-UIDGATE-004] UI Candidateを含むbatchはall-or-nothingで停止する**
  - Givenbackend CandidateとUI Candidateが同じplanning outputにある
  - Whenenrichmentを適用する
  - Then一部Issueだけを作らず、全Candidateを0 Issueのneeds-human-reviewとして記録する

- **[AC-UIDGATE-005] plannerへUI分類を回避しない契約を渡す**
  - GivenUIを含むSource Issueをplanning sessionへ渡す
  - Whenpromptを構築する
  - ThenUI workをfrontend/fullstackに分類し、gate回避のためbackendへ偽装しない指示を含む

- **[AC-UIDGATE-006] UI readiness rejectionも再起動で重複しない**
  - Given同じIntakeRecordのUI batchが一度needs-human-reviewになった
  - When同じoutputを再適用する
  - Then初回PlanningEnrichmentRecordを返し、counter・record・Issueを増やさない

## レッドライン

- UI workをbackendへ再分類して通さない。
- design token/system/componentをgeneric planning agentに推測著述させない。
- UI Candidateだけを落としてbackend Candidateを部分投影しない。
- backend-only intakeへUI artifactを要求しない。
- UI agentの出力をschema/trace/provenance検証せずgate解除しない。
