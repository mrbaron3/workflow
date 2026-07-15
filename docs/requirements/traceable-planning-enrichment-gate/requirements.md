# Traceable planning enrichment gate 受け入れ要件

## 意図

- 機能: Traceable planning enrichment gate
- outcome: planning-agentが粗いWHATを1..N個のIssue Contract候補へ整え、全ACを原文またはsystem要素へtraceする。
  曖昧さや根拠のないscope追加は推測せずneeds-human-reviewへ止める。
- 計画の木リンク: feature=FEAT-017 epic=EPIC-08

## 受け入れ基準

- **[AC-ENRICH-001] 1つのclaimed sourceから1..N schema-valid Issueをall-or-nothing生成する**
  - Givenclaimed IntakeRecordとschema-validな複数Candidateがある
  - Whenenrichment gateを適用する
  - Then全Candidateをcontract-drafted Issueへ変換し、intakeをreadyにしてIssue集合を記録する

- **[AC-ENRICH-002] 全ACのSource text traceが初回原文に実在する**
  - GivenCandidate ACがsource traceを持つ
  - Whengateがtraceを検証する
  - Thentrace textが初回snapshot title/bodyに実在する場合だけAC根拠として受理する

- **[AC-ENRICH-003] system traceは実在elementだけをIssue contextへ渡す**
  - GivenCandidate ACがsystem element traceを持つ
  - Whengateがtarget _systemを解決する
  - Then実在idだけを受理し、accepted Issue.dependsOnSystemへ重複なく投影する

- **[AC-ENRICH-004] ambiguity・untraced AC・dangling traceはIssueを作らず停止する**
  - Givenambiguities、AC trace欠落/重複/extra、原文に無いtext、またはmissing system idがある
  - Whengateを適用する
  - Thenstore Issueを1件も作らず理由をPlanningEnrichmentRecordへ残しintakeをneeds-human-reviewにする

- **[AC-ENRICH-005] source・planning invocation・生成Issueの帰属を往復できる**
  - Givenissue-planner AgentInvocationからaccepted enrichmentを作る
  - Whenstoreを監査する
  - ThenSource Snapshot→PlanningEnrichmentRecord→AgentInvocationと生成Issue→intakeKey/candidateKeyを双方向に辿れる

- **[AC-ENRICH-006] duplicate applyでIssue/counterを増やさない**
  - Givenacceptedまたはneeds-human-reviewのenrichmentが記録済みである
  - When同じintakeKeyへ再適用する
  - Then初回record/issue集合/理由を返し、新しいIssue・enrichment・counterを作らない

## レッドライン

- gateが欠けたtraceやACを自動補完しない。
- planning outputだけを根拠にSource Snapshotを上書きしない。
- invalid Candidateの一部だけをqueueへ流さない。
- dangling system idを無視してdependsOnSystemから落とさない。
- planning invocation無しのoutputを匿名のWHATとして採用しない。
