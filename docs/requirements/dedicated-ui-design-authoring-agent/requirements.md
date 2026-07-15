# Dedicated UI design authoring agent 受け入れ要件

## 意図

- 機能: Dedicated UI design authoring agent
- outcome: frontend/fullstack Candidateを、独立したUI/UX責務のcontextでtraceableなdesign contractへ著述し、
  検証済み成果物だけを実装・レビューへ渡す。
- 計画の木リンク: feature=FEAT-021 epic=EPIC-10

## 受け入れ基準

- **[AC-UIAUTHOR-001] UI成果物を構造化契約として表現する**
  - Givenfrontend/fullstack CandidateとそのAC集合がある
  - WhenUI designerの出力境界を検証する
  - Thenprinciples、tokens、components、states/interactions、accessibility、criterionTracesをschemaで要求する

- **[AC-UIAUTHOR-002] Candidateごとに独立route/sessionを使う**
  - GivenUI Candidateとprovider/model routeがある
  - Whendevelopment turnがUI著述を開始する
  - Thenplanner/generatorと共有しないfresh context・detached read-only checkout・sidecar outputでui-designerを実行する

- **[AC-UIAUTHOR-003] AC traceとInvocation provenanceを検証する**
  - GivenUI designerがartifactとAgentInvocationを返した
  - Whenplanning enrichment gateへ供給する
  - Then全ACの1対1 trace、design element参照、sourceCriterionIds、candidate固有subject、role、completed outcomeを検証する

- **[AC-UIAUTHOR-004] 不明・不正なUI設計をfail-closedにする**
  - Givenartifact不在、ambiguity、dangling/duplicate trace、source edit、route mismatchのいずれかがある
  - Whenenrichmentを適用する
  - ThenIssueを1件も作らず理由付きneeds-human-reviewへ停止する

- **[AC-UIAUTHOR-005] 同じUI契約を実装とレビューへ投影する**
  - GivenUI artifactがschema/trace/provenance gateを通過した
  - WhenIssueを生成してgenerationとperspective reviewを開始する
  - ThenIssueがartifact/invocationKeyを保持し、generatorと各reviewer promptが同じUI Design Contractを参照する

- **[AC-UIAUTHOR-006] 完了済みUI著述を再実行しない**
  - Given同じIntakeRecordがplanning・UI著述・enrichmentを完了している
  - Whendevelopment turnを再実行する
  - Thenplanner/UI designer/Issue/Invocation/EnrichmentRecordを重複生成しない

## レッドライン

- plannerまたはgeneric generatorにUI設計責務を混ぜない。
- UI designerへ過去の無関係なagent contextを渡さない。
- agentのself-reportだけでartifactを承認しない。
- UI artifactをAC traceまたはInvocation provenanceなしにIssueへ写さない。
- backend-only CandidateへUI著述を起動しない。
